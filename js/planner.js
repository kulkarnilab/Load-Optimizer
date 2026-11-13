/* Order planning: clubs orders into trips, picks vehicles, sequences drops,
 * assigns owned vs market fleet and evaluates re-planning triggers.
 * Depends on Packer (packer.js).
 */
(function (root) {
  const Packer = root.Packer || (typeof require !== 'undefined' ? require('./packer.js') : null);
  const EPS = 0.01;

  // ---------- geography ----------
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  function haversine(a, b) {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const ROAD = 1.3; // road-distance factor over straight line
  const SILIGURI = { lat: 26.73, lng: 88.40 }; // the "chicken's neck": all road traffic to the NE passes here
  function isNE(p) { return p.region === 'North East'; }
  function roadKm(a, b) {
    if (isNE(a) !== isNE(b)) return Math.round((haversine(a, SILIGURI) + haversine(SILIGURI, b)) * ROAD);
    return Math.round(haversine(a, b) * (isNE(a) && isNE(b) ? 1.5 : ROAD));
  }

  // ---------- vehicles & customer restrictions ----------
  const vVol = (v) => v.l * v.w * v.h;
  const bySize = (a, b) => vVol(a) - vVol(b) || a.payload - b.payload;

  function effectiveMaxVehicle(cust, state) {
    if (cust.maxVehicleId) return { id: cust.maxVehicleId, source: 'Customer exception' };
    const rr = (state.regionRules || []).find((r) => r.region === cust.region && r.maxVehicleId);
    if (rr) return { id: rr.maxVehicleId, source: 'Region rule – ' + rr.region };
    return null;
  }
  function allowedFor(cust, state) {
    const lim = effectiveMaxVehicle(cust, state);
    const vs = state.vehicles.filter((v) => v.active !== false);
    if (!lim) return vs.slice().sort(bySize);
    const max = state.vehicles.find((v) => v.id === lim.id);
    if (!max) return vs.slice().sort(bySize);
    return vs.filter((v) => v.l <= max.l + EPS && v.payload <= max.payload + EPS && v.h <= max.h + EPS).sort(bySize);
  }
  function allowedForAll(custs, state) {
    let set = null;
    custs.forEach((c) => {
      const ids = new Set(allowedFor(c, state).map((v) => v.id));
      set = set ? new Set([...set].filter((x) => ids.has(x))) : ids;
    });
    return state.vehicles.filter((v) => set && set.has(v.id)).sort(bySize);
  }
  // Usable volume: open bodies in "all items" height mode also count the space above the side walls.
  const capVol = (v, o) => (o && Packer.effVol ? Packer.effVol(v, o) : vVol(v));
  const fits = (v, wt, vol, eff, o) => wt <= v.payload + EPS && vol <= capVol(v, o) * eff + EPS;

  // ---------- category grouping ----------
  function coloadGroups(state) {
    // Graph-colour categories so that no two "no" categories share a group.
    const groups = [];
    state.categories.forEach((c) => {
      const g = groups.find((gr) => gr.every((x) => Packer.compatOf(state.compat, x, c.id) !== 'no'));
      if (g) g.push(c.id); else groups.push([c.id]);
    });
    const map = {};
    groups.forEach((g, i) => g.forEach((c) => (map[c] = 'G' + (i + 1))));
    return { groups, map };
  }

  // ---------- main planning ----------
  function plan(state, opts) {
    const t0 = Date.now();
    const o = Object.assign({ scope: [], segregation: 'mixed', dropPolicy: 'auto', longHaulKm: 400, maxDrops: 4, maxDetourPct: 30, packEff: 0.85, verify: true, priority: 'auto', openTop: 'off', openTopH: 0 }, opts || {});
    const skuMap = Object.fromEntries(state.skus.map((s) => [s.id, s]));
    const custMap = Object.fromEntries(state.customers.map((c) => [c.id, c]));
    const catName = Object.fromEntries(state.categories.map((c) => [c.id, c.name]));
    const dc = Object.assign({ region: 'East' }, state.dc);
    const inScope = (cat) => !o.scope.length || o.scope.includes(cat);
    const notes = [];

    // 1) consignments = order lines split by co-load group (or category when segregating)
    let cons = [];
    const pendingOrders = state.orders.filter((x) => x.status === 'pending');
    pendingOrders.forEach((ord) => {
      const cust = custMap[ord.custId];
      if (!cust) return;
      const parts = {};
      // Within one order, categories that must not share a vehicle go to separate consignments.
      const catWt = {};
      ord.lines.forEach((ln) => { const s = skuMap[ln.skuId]; if (s) catWt[s.cat] = (catWt[s.cat] || 0) + s.wt * ln.qty; });
      const groups = [];
      Object.keys(catWt).sort((a, b) => catWt[b] - catWt[a]).forEach((ct) => {
        const g = groups.find((gr) => gr.every((x) => Packer.compatOf(state.compat, x, ct) !== 'no'));
        if (g) g.push(ct); else groups.push([ct]);
      });
      const partOf = {};
      groups.forEach((g, i) => g.forEach((ct) => (partOf[ct] = 'P' + i)));
      ord.lines.forEach((ln) => {
        const s = skuMap[ln.skuId];
        if (!s || !inScope(s.cat) || !(ln.qty > 0)) return;
        const key = o.segregation === 'separate' ? s.cat : partOf[s.cat];
        (parts[key] = parts[key] || []).push({ skuId: s.id, qty: ln.qty });
      });
      Object.keys(parts).forEach((key) => cons.push(makeCons(ord.id, cust, key, parts[key])));
    });
    function makeCons(orderId, cust, key, lines) {
      let wt = 0, vol = 0;
      const cats = new Set();
      lines.forEach((ln) => { const s = skuMap[ln.skuId]; wt += s.wt * ln.qty; vol += s.l * s.w * s.h * ln.qty; cats.add(s.cat); });
      return { orderIds: [orderId], cust, key, lines, wt, vol, cats };
    }

    // 2) split consignments bigger than the largest vehicle the customer allows
    const split = [];
    cons.forEach((c) => {
      const allowed = allowedFor(c.cust, state);
      const maxV = allowed[allowed.length - 1];
      if (!maxV) { split.push(c); return; }
      if (fits(maxV, c.wt, c.vol, o.packEff, o)) { split.push(c); return; }
      // break into chunks that each fit the largest allowed vehicle
      const units = [];
      c.lines.forEach((ln) => { for (let i = 0; i < ln.qty; i++) units.push(ln.skuId); });
      units.sort((a, b) => skuMap[b].wt - skuMap[a].wt);
      const n = Math.max(Math.ceil(c.wt / maxV.payload), Math.ceil(c.vol / (capVol(maxV, o) * o.packEff)));
      const chunks = Array.from({ length: n }, () => ({ wt: 0, vol: 0, cnt: {} }));
      units.forEach((id) => {
        const s = skuMap[id];
        const ch = chunks.reduce((best, x) => (Math.max(x.wt / maxV.payload, x.vol / capVol(maxV, o)) < Math.max(best.wt / maxV.payload, best.vol / capVol(maxV, o)) ? x : best));
        ch.wt += s.wt; ch.vol += s.l * s.w * s.h; ch.cnt[id] = (ch.cnt[id] || 0) + 1;
      });
      chunks.forEach((ch, i) => {
        const nc = makeCons(c.orderIds[0], c.cust, c.key, Object.keys(ch.cnt).map((k) => ({ skuId: k, qty: ch.cnt[k] })));
        nc.splitNote = `Split ${i + 1}/${n}: order exceeds largest vehicle allowed for ${c.cust.name} (${maxV.name})`;
        split.push(nc);
      });
    });
    cons = split;

    function canJoinCats(a, b) {
      for (const x of a) for (const y of b) if (Packer.compatOf(state.compat, x, y) === 'no') return false;
      return true;
    }
    // Clubbing must not add more than maxDetourPct over the farthest direct run.
    function detourOk(custs) {
      if (custs.length < 2) return true;
      const direct = Math.max(...custs.map((cu) => roadKm(dc, cu)));
      const route = routeKm(dc, nearestOrder(dc, custs.map((cu) => ({ cust: cu })))).km;
      return route <= direct * (1 + o.maxDetourPct / 100) + 1;
    }
    function newTrip(c) { return { corridor: c.cust.corridor, key: c.key, cons: [c], custs: new Map([[c.cust.id, c.cust]]), wt: c.wt, vol: c.vol, cats: new Set(c.cats) }; }
    function addTo(t, c) { t.cons.push(c); t.custs.set(c.cust.id, c.cust); t.wt += c.wt; t.vol += c.vol; c.cats.forEach((x) => t.cats.add(x)); }

    // 3) club consignments into trips per corridor (and per category when segregating)
    const buckets = {};
    cons.forEach((c) => { const k = c.cust.corridor + '||' + (o.segregation === 'separate' ? c.key : 'mix'); (buckets[k] = buckets[k] || []).push(c); });
    let trips = [];
    Object.keys(buckets).forEach((bk) => {
      const list = buckets[bk].sort((a, b) => b.wt - a.wt);
      const open = [];
      list.forEach((c) => {
        let best = null;
        open.forEach((t) => {
          const custs = new Map(t.custs);
          custs.set(c.cust.id, c.cust);
          if (custs.size > o.maxDrops) return;
          if (!canJoinCats(t.cats, c.cats)) return;
          if (custs.size > t.custs.size && !detourOk([...custs.values()])) return;
          const allowed = allowedForAll([...custs.values()], state);
          const capV = allowed[allowed.length - 1];
          if (!capV || !fits(capV, t.wt + c.wt, t.vol + c.vol, o.packEff, o)) return;
          const slack = 1 - Math.max((t.wt + c.wt) / capV.payload, (t.vol + c.vol) / (capVol(capV, o) * o.packEff));
          if (!best || slack < best.slack) best = { t, slack };
        });
        if (best) addTo(best.t, c);
        else open.push(newTrip(c));
      });
      trips.push(...open);
    });

    // 4) right-size, sequence, verify with the 3D packer
    const done = [];
    let guard = 0;
    while (trips.length && guard++ < 200) {
      const t = trips.shift();
      const custs = [...t.custs.values()];
      const allowed = allowedForAll(custs, state);
      const flags = [];
      custs.forEach((cu) => {
        const lim = effectiveMaxVehicle(cu, state);
        if (lim) {
          const v = state.vehicles.find((x) => x.id === lim.id);
          flags.push(`${cu.city}: max ${v ? v.name : lim.id} (${lim.source})`);
        }
      });
      t.cons.forEach((c) => c.splitNote && flags.push(c.splitNote));
      if (!allowed.length) { done.push(Object.assign(t, { vehicle: null, flags: flags.concat('No vehicle satisfies all customer restrictions') })); continue; }

      // per-customer loads
      const perCust = {};
      t.cons.forEach((c) => {
        const pc = perCust[c.cust.id] || (perCust[c.cust.id] = { cust: c.cust, wt: 0, vol: 0, lines: {}, orderIds: new Set() });
        pc.wt += c.wt; pc.vol += c.vol;
        c.orderIds.forEach((x) => pc.orderIds.add(x));
        c.lines.forEach((ln) => { pc.lines[ln.skuId] = (pc.lines[ln.skuId] || 0) + ln.qty; });
      });
      let idx = allowed.findIndex((v) => fits(v, t.wt, t.vol, o.packEff, o));
      if (idx < 0) idx = allowed.length - 1;

      let result = null;
      for (; idx < allowed.length; idx++) {
        const v = allowed[idx];
        const seq = sequence(Object.values(perCust), v, dc, o);
        const items = [];
        seq.order.forEach((pc, i) => Object.keys(pc.lines).forEach((sk) => items.push({ id: pc.cust.id + '-' + sk, skuId: sk, qty: pc.lines[sk], drop: i + 1, dest: pc.cust.city, custId: pc.cust.id })));
        let packRes = null;
        if (o.verify) {
          packRes = Packer.pack(v, items, skuMap, { compat: state.compat, catNames: catName, priority: o.priority, multiDrop: true, direction: 'nose_to_door', timeLimitMs: 3000, openTop: o.openTop, openTopH: o.openTopH });
        }
        result = { v, seq, items, packRes };
        if (!packRes || packRes.unplaced.length === 0) break;
      }
      const { v, seq, items, packRes } = result;
      if (packRes && packRes.unplaced.length) {
        // spill leftovers into a new trip for the same customers
        const left = {};
        packRes.unplaced.forEach(({ u }) => {
          const it = items.find((x) => x.id === u.lineId);
          const k = it.custId;
          (left[k] = left[k] || {})[u.skuId] = (left[k][u.skuId] || 0) + 1;
          it.qty -= 1;
        });
        let spill = null;
        Object.keys(left).forEach((cid) => {
          const cu = custMap[cid];
          const pc = perCust[cid];
          const c = makeCons([...pc.orderIds][0], cu, t.key, Object.keys(left[cid]).map((k) => ({ skuId: k, qty: left[cid][k] })));
          c.orderIds = [...pc.orderIds];
          c.splitNote = `${cu.city}: spill-over from ${t.corridor} vehicle (${packRes.unplaced[0].why})`;
          // Prefer topping up another trip still in the queue on the same corridor.
          const host = trips.find((q) => q.corridor === t.corridor && (o.segregation !== 'separate' || q.key === t.key) && canJoinCats(q.cats, c.cats) &&
            (q.custs.has(cid) || q.custs.size < o.maxDrops) && (() => { const cs = new Map(q.custs); cs.set(cid, cu); const al = allowedForAll([...cs.values()], state); const cap = al[al.length - 1]; return cap && fits(cap, q.wt + c.wt, q.vol + c.vol, o.packEff, o) && detourOk([...cs.values()]); })());
          if (host) addTo(host, c);
          else if (spill) addTo(spill, c);
          else spill = newTrip(c);
        });
        if (spill) trips.push(spill);
        flags.push(`${packRes.unplaced.length} units moved to another vehicle after 3D check`);
      }
      const realItems = items.filter((x) => x.qty > 0);
      const wt = packRes ? packRes.stats.usedWt : t.wt;
      const vol = packRes ? packRes.stats.usedVol : t.vol;
      const bigger = allowed[allowed.length - 1];
      if (bigger && state.vehicles.some((x) => vVol(x) > vVol(bigger) && x.active !== false) && custs.some((cu) => effectiveMaxVehicle(cu, state))) {
        flags.push(`Largest vehicle capped at ${bigger.name} by customer restrictions`);
      }
      done.push({
        corridor: t.corridor, key: t.key, vehicle: v, items: realItems, seq, wt, vol,
        wtPct: (wt / v.payload) * 100, volPct: (vol / capVol(v, o)) * 100,
        cats: [...new Set(realItems.map((x) => skuMap[x.skuId].cat))],
        orderIds: [...new Set(t.cons.flatMap((c) => c.orderIds))],
        flags, packStats: packRes ? packRes.stats : null, binding: packRes ? packRes.stats.binding : null,
      });
    }

    // 5) owned vs market by KM slab
    const ownedLeft = Object.fromEntries(state.vehicles.map((v) => [v.id, +v.ownedCount || 0]));
    const valid = done.filter((t) => t.vehicle);
    valid.sort((a, b) => a.seq.km - b.seq.km); // shortest trips claim owned vehicles first
    valid.forEach((t, i) => {
      const km = t.seq.km;
      const slab = (state.slabs || []).find((s) => km >= s.from && km < s.to) || { from: 0, to: Infinity, policy: 'owned_first' };
      const label = POLICY[slab.policy] || slab.policy;
      const slabTxt = `${km} km → slab ${slab.from}–${slab.to >= 99999 ? '∞' : slab.to} km: ${label}`;
      let fleet, why = slabTxt;
      const hasOwned = ownedLeft[t.vehicle.id] > 0;
      if (slab.policy === 'market_only' || slab.policy === 'market_first') fleet = 'market';
      else if (hasOwned) fleet = 'owned';
      else { fleet = 'market'; why += ` · no owned ${t.vehicle.name} free → market`; if (slab.policy === 'owned_only') t.flags.push('Owned-only slab but no owned vehicle available'); }
      if (fleet === 'owned') ownedLeft[t.vehicle.id] -= 1;
      t.fleet = fleet; t.fleetReason = why;
      const rate = fleet === 'owned' ? +t.vehicle.ownedRate || 0 : +t.vehicle.marketRate || 0;
      t.cost = fleet === 'owned' ? Math.round(rate * km * 2) : Math.round(Math.max(+t.vehicle.marketMin || 0, rate * km));
      t.costNote = !t.cost ? `No ${fleet} ₹/km rate set for ${t.vehicle.name} (Masters → Fleet)` : fleet === 'owned' ? `₹${rate}/km × ${km * 2} km (incl. empty return)` : `₹${rate}/km × ${km} km${t.vehicle.marketMin ? `, min ₹${t.vehicle.marketMin}` : ''}`;
    });
    valid.sort((a, b) => a.corridor.localeCompare(b.corridor) || b.seq.km - a.seq.km);
    valid.forEach((t, i) => (t.id = 'T' + String(i + 1).padStart(2, '0')));

    const plannedOrderIds = new Set(valid.flatMap((t) => t.orderIds));
    const outOfScope = pendingOrders.filter((x) => !plannedOrderIds.has(x.id)).map((x) => x.id);
    const summary = {
      trips: valid.length, owned: valid.filter((t) => t.fleet === 'owned').length, market: valid.filter((t) => t.fleet === 'market').length,
      cost: valid.reduce((a, t) => a + t.cost, 0), wt: valid.reduce((a, t) => a + t.wt, 0),
      avgUtil: valid.length ? valid.reduce((a, t) => a + Math.max(t.wtPct, t.volPct), 0) / valid.length : 0,
      ms: Date.now() - t0, orders: plannedOrderIds.size,
    };
    return { trips: valid, failed: done.filter((t) => !t.vehicle), summary, plannedOrderIds: [...plannedOrderIds], outOfScope, notes };
  }

  const POLICY = { owned_first: 'Owned first', market_first: 'Market (hired) first', owned_only: 'Owned only', market_only: 'Market only' };

  // ---------- drop sequencing ----------
  function routeKm(dc, order) {
    let km = 0, prev = dc;
    const legs = [];
    order.forEach((pc) => { const d = roadKm(prev, pc.cust); legs.push(d); km += d; prev = pc.cust; });
    return { km, legs };
  }
  function nearestOrder(dc, pcs) {
    const left = pcs.slice(), out = [];
    let cur = dc;
    while (left.length) {
      let bi = 0;
      left.forEach((p, i) => { if (roadKm(cur, p.cust) < roadKm(cur, left[bi].cust)) bi = i; });
      cur = left[bi].cust; out.push(left.splice(bi, 1)[0]);
    }
    return out;
  }
  /** Utilisation along the route: share of capacity on board for each leg, km-weighted. */
  function profile(order, legs, v) {
    const share = (pc) => Math.max(pc.wt / v.payload, pc.vol / vVol(v));
    let onboard = order.reduce((a, pc) => a + share(pc), 0);
    const perLeg = [];
    let num = 0, den = 0;
    order.forEach((pc, i) => { perLeg.push({ km: legs[i], util: Math.min(1, onboard) }); num += Math.min(1, onboard) * legs[i]; den += legs[i]; onboard -= share(pc); });
    return { perLeg, tkm: den ? num / den : 0 };
  }
  function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    arr.forEach((x, i) => permutations(arr.slice(0, i).concat(arr.slice(i + 1))).forEach((p) => out.push([x].concat(p))));
    return out;
  }
  // Shortest route over `rest`, then `last` fixed as the final drop.
  function bestWithLast(dc, rest, last, preferSmallFirst, share) {
    let best = null;
    const perms = rest.length <= 6 ? permutations(rest) : [nearestOrder(dc, rest)];
    perms.forEach((p) => {
      const ord = last ? p.concat([last]) : p;
      const km = routeKm(dc, ord).km;
      const tie = preferSmallFirst ? ord.reduce((a, pc, i) => a + share(pc) * i, 0) : 0;
      if (!best || km < best.km - 1 || (Math.abs(km - best.km) <= 1 && tie > best.tie)) best = { ord, km, tie };
    });
    return best.ord;
  }
  function sequence(pcs, v, dc, o) {
    const share = (pc) => Math.max(pc.wt / v.payload, pc.vol / vVol(v));
    const near = nearestOrder(dc, pcs);
    const nearKm = routeKm(dc, near).km;
    const longHaul = nearKm >= o.longHaulKm;
    let policy = o.dropPolicy;
    if (policy === 'auto') policy = longHaul ? 'largest_last' : 'route';
    const bySize = pcs.slice().sort((a, b) => share(a) - share(b));
    const largest = bySize[bySize.length - 1];
    let order;
    if (policy === 'largest_last') order = bestWithLast(dc, pcs.filter((x) => x !== largest), largest, true, share);
    else if (policy === 'size_strict') order = bySize;
    else order = near;
    const r = routeKm(dc, order);
    const prof = profile(order, r.legs, v);
    // Comparison: the same drops with the largest load unloaded first.
    const rev = [largest].concat(bestWithLast(dc, pcs.filter((x) => x !== largest), null, false, share).filter((x) => x !== largest));
    const rr = routeKm(dc, rev);
    const alt = profile(rev, rr.legs, v);
    const labels = { largest_last: 'Largest load as last drop', size_strict: 'Strict smallest → largest', route: 'Route order (nearest first)' };
    return { order, km: r.km, legs: r.legs, policy, longHaul, profile: prof, alt: { label: 'Largest load first', km: rr.km, profile: alt }, label: labels[policy] };
  }

  // ---------- re-planning trigger ----------
  function triggerStatus(cfg, pending, elapsed) {
    const countMet = pending >= cfg.count;
    const timeMet = elapsed >= cfg.interval;
    const capMet = cfg.maxWait > 0 && elapsed >= cfg.maxWait && pending > 0;
    let fire, reason;
    if (cfg.logic === 'or') {
      fire = pending > 0 && (countMet || timeMet);
      reason = countMet ? `order count reached (${pending} ≥ ${cfg.count})` : timeMet ? `interval elapsed (${elapsed} ≥ ${cfg.interval} min)` : '';
    } else {
      fire = (countMet && timeMet) || capMet;
      reason = countMet && timeMet ? `${pending} orders ≥ ${cfg.count} AND ${elapsed} min ≥ ${cfg.interval} min` : capMet ? `max wait ${cfg.maxWait} min reached with ${pending} pending (safety net)` : '';
    }
    return { fire, countMet, timeMet, capMet, reason };
  }

  // ---------- sample / simulated orders ----------
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  // Simulated orders for the re-plan trigger demo: random customer, a few random SKUs from the master.
  function makeOrder(state, rand, id, createdAt, custId) {
    const custs = state.customers;
    const cust = custId ? custs.find((c) => c.id === custId) : custs[Math.floor(rand() * custs.length)];
    const n = 1 + Math.floor(rand() * Math.min(4, state.skus.length));
    const pool = state.skus.slice();
    const lines = [];
    for (let i = 0; i < n && pool.length; i++) {
      const s = pool.splice(Math.floor(rand() * pool.length), 1)[0];
      lines.push({ skuId: s.id, qty: 1 + Math.floor(rand() * 2) });
    }
    return { id, custId: cust.id, lines, createdAt, status: 'pending', ref: 'Simulated order' };
  }
  // Sample orders shipped with the master data.
  function sampleOrders(state) {
    const src = (root.DEFAULT_DATA && root.DEFAULT_DATA.orders) || [];
    const skuIds = new Set(state.skus.map((s) => s.id));
    return JSON.parse(JSON.stringify(src))
      .filter((o) => state.customers.some((c) => c.id === o.custId))
      .map((o) => Object.assign(o, { lines: o.lines.filter((l) => skuIds.has(l.skuId)), status: 'pending', createdAt: 0 }));
  }

  const api = { plan, roadKm, haversine, allowedFor, allowedForAll, effectiveMaxVehicle, coloadGroups, triggerStatus, makeOrder, sampleOrders, rng, POLICY, vVol };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Planner = api;
})(typeof window !== 'undefined' ? window : globalThis);
