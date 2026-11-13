/* 3D truck load packer — extreme-point heuristic with SKU stacking norms,
 * category segregation, multi-drop LIFO and weight-vs-volume priority.
 *
 * Axes: x = length (0 = nose / cab end, L = door), y = width, z = height.
 */
(function (root) {
  const EPS = 0.01;
  const BUCKET = 40; // cm, x-axis spatial bucket for fast overlap queries

  function compatOf(compat, a, b) {
    if (a === b) return 'ok';
    return compat[a + '|' + b] || compat[b + '|' + a] || 'ok';
  }

  function orientations(u) {
    const raw = [[u.l, u.w, u.h]];
    if (u.tip) {
      raw.push([u.w, u.l, u.h], [u.l, u.h, u.w], [u.h, u.l, u.w], [u.w, u.h, u.l], [u.h, u.w, u.l]);
    } else if (u.rotate) {
      raw.push([u.w, u.l, u.h]);
    }
    const seen = new Set();
    return raw.filter((o) => {
      const k = o.join('x');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // ---------- open bodies: usable height above the side walls ----------
  /** Default for vehicles without an explicit flag: no end door, and not a closed container box. */
  function defaultOpen(v) {
    const n = String(v.name || '');
    if (/\b(FR|FT|OT|ODC|open|flat)\b/i.test(n) || /open/i.test(n)) return true;
    if (v.door === 'Left') return false;
    if (/container|coontainer|\bHC\b|\bGP\b|\bDC\b/i.test(n)) return false;
    return true;
  }
  const isOpen = (v) => (v.open != null ? !!v.open : defaultOpen(v));

  /** Height rules for this vehicle and mode.
   *  H = body / side-wall height, Hmax = highest point a load may reach on an open body.
   *  mode: 'off' | 'large' (only pieces that cannot stand under the walls may stick out) | 'all'. */
  function heightCaps(vehicle, opts) {
    const H = +vehicle.h;
    const mode = (opts && opts.openTop) || 'off';
    const open = isOpen(vehicle) && mode !== 'off';
    const lim = +vehicle.maxLoadH > 0 ? +vehicle.maxLoadH : +(opts && opts.openTopH) || H;
    const Hmax = open ? Math.max(H, lim) : H;
    const minStand = (u) => Math.min(...orientations(u).map((o) => o[2]));
    const ceilFor = (u) => (!open || Hmax <= H + EPS ? H : mode === 'all' ? Hmax : minStand(u) > H + EPS ? Hmax : H);
    return { H, Hmax, open, mode, ceilFor, Heff: open && mode === 'all' ? Hmax : H };
  }

  /** Can one unit physically go into this vehicle at all (size, door, payload, height mode)? */
  function unitFits(vehicle, u, opts) {
    const hc = heightCaps(vehicle, opts);
    const ceil = hc.ceilFor(u);
    let ors = orientations(u).filter((o) => o[0] <= vehicle.l + EPS && o[1] <= vehicle.w + EPS && o[2] <= ceil + EPS);
    if (!ors.length) return { ok: false, why: 'Larger than vehicle body' };
    if (vehicle.door === 'Left' && !isOpen(vehicle) && +vehicle.doorW > 0 && +vehicle.doorH > 0) {
      ors = ors.filter((o) => o[1] <= vehicle.doorW + EPS && o[2] <= vehicle.doorH + EPS);
      if (!ors.length) return { ok: false, why: 'Cannot pass the door' };
    }
    if (u.wt > vehicle.payload + EPS) return { ok: false, why: 'Heavier than payload' };
    return { ok: true };
  }

  /** Expand item lines into individual units using the SKU master. */
  function expandUnits(items, skuMap) {
    const units = [];
    items.forEach((it) => {
      const s = skuMap[it.skuId];
      if (!s) return;
      const qty = Math.max(0, Math.floor(it.qty || 0));
      for (let i = 0; i < qty; i++) {
        units.push({
          uid: it.id + '#' + (i + 1), lineId: it.id, skuId: s.id, name: s.name, cat: s.cat,
          l: +s.l, w: +s.w, h: +s.h, wt: +s.wt,
          maxStack: Math.max(1, +s.maxStack || 1), maxTopKg: +s.maxTopKg > 0 ? +s.maxTopKg : Infinity,
          maxHeight: +s.maxHeight > 0 ? +s.maxHeight : Infinity,
          onTop: s.onTop !== false, under: s.under !== false, rotate: s.rotate !== false, tip: !!s.tip,
          drop: +it.drop || 1, dest: it.dest || '', color: s.color,
        });
      }
    });
    return units;
  }

  /** Decide which constraint should drive the packing order. */
  function resolvePriority(priority, units, vehicle) {
    if (priority === 'weight' || priority === 'volume') return priority;
    const wt = units.reduce((a, u) => a + u.wt, 0);
    const vol = units.reduce((a, u) => a + u.l * u.w * u.h, 0);
    const vVol = vehicle.l * vehicle.w * vehicle.h;
    // Load denser than the vehicle → payload runs out first → weight is binding.
    return wt / vehicle.payload >= vol / vVol ? 'weight' : 'volume';
  }

  function packOnce(vehicle, items, skuMap, opts) {
    const t0 = Date.now();
    opts = Object.assign({ direction: 'nose_to_door', clearance: 0, priority: 'auto', multiDrop: true, overrideCompat: false, supportRatio: 0.8, compat: {}, timeLimitMs: 8000 }, opts || {});
    const L = vehicle.l, W = vehicle.w, H = vehicle.h;
    const c = Math.max(0, +opts.clearance || 0);
    const units = expandUnits(items, skuMap);
    // Open bodies: pieces may rise above the side walls (H) up to Hmax, per the open-top mode.
    const hc = heightCaps(vehicle, opts);
    const Hmax = hc.Hmax;
    units.forEach((u) => (u.ceil = hc.ceilFor(u)));
    const pri = resolvePriority(opts.priority, units, Object.assign({}, vehicle, { h: hc.Heff }));

    // 1) Weight vs volume priority decides WHAT gets loaded when everything cannot fit.
    //    weight → densest units first (maximise tonnage); volume → bulkiest-per-kg first (maximise cube).
    //    Payload is always a hard limit; the volume cap is a planning estimate, the packer has the final say.
    const vVolCap = L * W * hc.Heff * (opts.volCap || 0.92);
    const reqWt0 = units.reduce((a, u) => a + u.wt, 0);
    const reqVol0 = units.reduce((a, u) => a + u.l * u.w * u.h, 0);
    let primary = units, deferred = [];
    if (reqWt0 > vehicle.payload + EPS || reqVol0 > vVolCap) {
      const dens = (u) => u.wt / (u.l * u.w * u.h);
      const ranked = units.slice().sort((a, b) => (pri === 'weight' ? dens(b) - dens(a) : dens(a) - dens(b)) || (opts.multiDrop ? b.drop - a.drop : 0));
      primary = []; let cw = 0, cv = 0;
      for (const u of ranked) {
        const v = u.l * u.w * u.h;
        if (cw + u.wt <= vehicle.payload + EPS && cv + v <= vVolCap) { primary.push(u); cw += u.wt; cv += v; } else { u.deferred = true; deferred.push(u); }
      }
    }
    // 2) Loading order for stability & unloading: last drop first (nose), floor-only items first,
    //    heavy before light, "nothing on top" items last.
    const stab = (a, b) => {
      if (opts.multiDrop && a.drop !== b.drop) return b.drop - a.drop;
      const fa = a.onTop ? 1 : 0, fb = b.onTop ? 1 : 0;
      if (fa !== fb) return fa - fb;
      const na = a.under ? 0 : 1, nb = b.under ? 0 : 1;
      if (na !== nb) return na - nb;
      if (Math.abs(b.wt - a.wt) > EPS) return b.wt - a.wt;
      const va = a.l * a.w * a.h, vb = b.l * b.w * b.h;
      if (Math.abs(vb - va) > EPS) return vb - va;
      return a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0;
    };
    primary.sort(stab);
    // Alternative orders (used by the multi-start search for small loads). Drop order and floor-only-first are kept.
    if (opts._order && opts._order !== 'stab') {
      const key = {
        area: (u) => -Math.max(u.l * u.w, u.l * u.h, u.w * u.h),
        long: (u) => -Math.max(u.l, u.w, u.h),
        vol: (u) => -u.l * u.w * u.h,
      }[opts._order];
      let rnd = null;
      if (!key) { let a0 = parseInt(String(opts._order).slice(1), 10) * 2654435761 >>> 0; rnd = () => { a0 = (a0 * 1664525 + 1013904223) >>> 0; return a0 / 4294967296; }; }
      const r = new Map(primary.map((u) => [u, rnd ? rnd() : key(u)]));
      primary.sort((a, b) => {
        if (opts.multiDrop && a.drop !== b.drop) return b.drop - a.drop;
        const fa = a.onTop ? 1 : 0, fb = b.onTop ? 1 : 0;
        if (fa !== fb) return fa - fb;
        return r.get(a) - r.get(b) || stab(a, b);
      });
    }
    // 3) Top-up with deferred units (only for single-drop loads so LIFO is never broken).
    const singleDrop = new Set(units.map((u) => u.drop)).size <= 1 || !opts.multiDrop;
    const queue = singleDrop ? primary.concat(deferred) : primary;
    if (!singleDrop) deferred.forEach((u) => (u.skip = true));

    const placed = [];
    const unplaced = [];
    const buckets = [];
    let stamp = 0;
    let totalWt = 0;
    const wallMode = opts.direction !== 'floor_to_top';

    const NZ = Math.ceil(Hmax / BUCKET) + 1;
    function addToBuckets(b) {
      const i0 = Math.floor(b.x / BUCKET), i1 = Math.floor((b.x + b.ol - EPS) / BUCKET);
      const k0 = Math.floor(b.z / BUCKET), k1 = Math.floor((b.top - EPS) / BUCKET);
      for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) {
        const id = i * NZ + k;
        (buckets[id] || (buckets[id] = [])).push(b);
      }
    }
    // Boxes whose x-range touches [x0,x1] and z-range touches [z0,z1] (superset).
    function near(x0, x1, z0, z1) {
      stamp++;
      const out = [];
      const i0 = Math.max(0, Math.floor((x0 - EPS) / BUCKET)), i1 = Math.floor((x1 + EPS) / BUCKET);
      const k0 = Math.max(0, Math.floor((z0 - EPS) / BUCKET)), k1 = Math.min(NZ - 1, Math.floor((z1 + EPS) / BUCKET));
      for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) {
        const bk = buckets[i * NZ + k];
        if (!bk) continue;
        for (const b of bk) if (b._s !== stamp) { b._s = stamp; out.push(b); }
      }
      return out;
    }
    function collides(x, y, z, l, w, h) {
      const cand = near(x, x + l, z, z + h);
      for (const a of cand) {
        if (a.x < x + l - EPS && x < a.x + a.ol - EPS && a.y < y + w - EPS && y < a.y + a.ow - EPS && a.z < z + h - EPS && z < a.top - EPS) return true;
      }
      return false;
    }
    function insideAny(p) {
      const cand = near(p.x, p.x, p.z, p.z);
      for (const a of cand) {
        if (p.x >= a.x - EPS && p.x < a.x + a.ol - EPS && p.y >= a.y - EPS && p.y < a.y + a.ow - EPS && p.z >= a.z - EPS && p.z < a.top - EPS) return true;
      }
      return false;
    }

    // Can box b (and everything under it) take `kg` more and `levels` more layers above?
    function canBear(b, kg, levels) {
      if (b.load + kg > b.u.maxTopKg + EPS) return false;
      if (levels > b.u.maxStack - 1) return false;
      for (const s of b.sup) if (!canBear(s.b, kg * s.f, levels + 1)) return false;
      return true;
    }
    function addLoad(b, kg, levels) {
      b.load += kg;
      if (levels > b.above) b.above = levels;
      for (const s of b.sup) addLoad(s.b, kg * s.f, levels + 1);
    }

    function supportFor(u, x, y, z, l, w) {
      if (z < EPS) return { ok: true, sup: [] };
      if (!u.onTop) return { ok: false, why: 'floor' };
      const cand = near(x, x + l, z - 1, z - 1);
      const sup = [];
      let area = 0;
      for (const a of cand) {
        if (Math.abs(a.top - z) > 0.5) continue;
        const ox = Math.min(x + l, a.x + a.l) - Math.max(x, a.x);
        const oy = Math.min(y + w, a.y + a.w) - Math.max(y, a.y);
        if (ox <= EPS || oy <= EPS) continue;
        if (!a.u.under) return { ok: false, why: 'under' };
        if (!opts.overrideCompat && compatOf(opts.compat, a.u.cat, u.cat) !== 'ok') return { ok: false, why: 'seg' };
        if (opts.multiDrop && u.drop > a.u.drop) return { ok: false, why: 'drop' };
        sup.push({ b: a, area: ox * oy });
        area += ox * oy;
      }
      if (area < l * w * opts.supportRatio - EPS) return { ok: false, why: 'support' };
      for (const s of sup) {
        s.f = s.area / area;
        if (!canBear(s.b, u.wt * s.f, 1)) return { ok: false, why: 'load' };
      }
      return { ok: true, sup };
    }

    // LIFO: goods for a later drop must never sit between this unit and the door.
    const multiStop = opts.multiDrop && new Set(units.map((u) => u.drop)).size > 1;
    function blockedToDoor(u, x, y, z, l, w, h) {
      for (const a of near(x + l - 0.5, L, z, z + h)) {
        if (a.u.drop > u.drop && a.x >= x + l - 0.5 && a.y < y + w - EPS && y < a.y + a.w - EPS && a.z < z + h - EPS && z < a.top - EPS) return true;
      }
      return false;
    }

    let points = [{ x: 0, y: 0, z: 0 }];
    const pkey = (p) => Math.round(p.x * 10) + ',' + Math.round(p.y * 10) + ',' + Math.round(p.z * 10);
    const cmp = wallMode
      ? (a, b) => a.x - b.x || a.z - b.z || a.y - b.y
      : (a, b) => a.z - b.z || a.x - b.x || a.y - b.y;

    function projDown(p) {
      let best = 0;
      for (const a of near(p.x, p.x, 0, p.z)) {
        if (p.x >= a.x - EPS && p.x < a.x + a.ol - EPS && p.y >= a.y - EPS && p.y < a.y + a.ow - EPS && a.top <= p.z + EPS && a.top > best) best = a.top;
      }
      return { x: p.x, y: p.y, z: best };
    }
    function projY(p) {
      let best = 0;
      for (const a of near(p.x, p.x, p.z, p.z)) {
        const e = a.y + a.ow;
        if (p.x >= a.x - EPS && p.x < a.x + a.ol - EPS && p.z >= a.z - EPS && p.z < a.top - EPS && e <= p.y + EPS && e > best) best = e;
      }
      return { x: p.x, y: best, z: p.z };
    }
    function projX(p) {
      let best = 0;
      for (const a of near(0, p.x, p.z, p.z)) {
        const e = a.x + a.ol;
        if (p.y >= a.y - EPS && p.y < a.y + a.ow - EPS && p.z >= a.z - EPS && p.z < a.top - EPS && e <= p.x + EPS && e > best) best = e;
      }
      return { x: best, y: p.y, z: p.z };
    }

    // Smallest box any unit could ever occupy — points where even this collides are dead forever.
    let minF = Infinity, minH = Infinity;
    units.forEach((u) => orientations(u).forEach((o) => { minF = Math.min(minF, o[0], o[1]); minH = Math.min(minH, o[2]); }));
    const deadBy = (q, b) => q.x + minF > L + EPS || q.y + minF > W + EPS || q.z + minH > Hmax + EPS ||
      (b.x < q.x + minF - EPS && q.x < b.x + b.ol - EPS && b.y < q.y + minF - EPS && q.y < b.y + b.ow - EPS && b.z < q.z + minH - EPS && q.z < b.top - EPS);

    // Categories that must not share a vehicle: keep the heaviest compatible set, reject the rest.
    const catName = (id) => (opts.catNames && opts.catNames[id]) || id;
    const rejectedCats = new Map();
    if (!opts.overrideCompat) {
      const catWt = {};
      units.forEach((u) => { catWt[u.cat] = (catWt[u.cat] || 0) + u.wt; });
      const keep = [];
      Object.keys(catWt).sort((a, b) => catWt[b] - catWt[a]).forEach((ct) => {
        const bad = keep.find((k) => compatOf(opts.compat, k, ct) === 'no');
        if (bad) rejectedCats.set(ct, bad); else keep.push(ct);
      });
    }

    let lastFailKey = null, lastFailWhy = null;
    let timedOut = false;

    const leftMsg = pri === 'weight' ? 'Left out – weight priority (denser goods loaded first)' : 'Left out – volume priority (bulkier goods loaded first)';
    if (!singleDrop) deferred.forEach((u) => unplaced.push({ u, why: leftMsg }));
    // End-door vehicles: the item's cross-section (width × height as it travels in) must pass the door.
    //    An open-top body is crane / top loaded, so its door does not limit what goes in.
    const endDoor = vehicle.door === 'Left' && !isOpen(vehicle) && +vehicle.doorW > 0 && +vehicle.doorH > 0;
    for (const u of queue) {
      let ors = orientations(u);
      const fitsAny = ors.some((o) => o[0] <= L + EPS && o[1] <= W + EPS && o[2] <= u.ceil + EPS);
      if (!fitsAny) {
        const tallOnly = ors.some((o) => o[0] <= L + EPS && o[1] <= W + EPS);
        const why = !tallOnly ? 'Larger than vehicle body'
          : isOpen(vehicle) && hc.mode === 'off' ? 'Taller than the side walls – allow open-body height to load it'
          : isOpen(vehicle) ? 'Taller than the open-body height limit' : 'Taller than the vehicle body';
        unplaced.push({ u, why }); continue;
      }
      if (endDoor) {
        ors = ors.filter((o) => o[1] <= vehicle.doorW + EPS && o[2] <= vehicle.doorH + EPS);
        if (!ors.length) { unplaced.push({ u, why: `Cannot pass the door (${vehicle.doorW}×${vehicle.doorH} cm)` }); continue; }
      }
      if (totalWt + u.wt > vehicle.payload + EPS) { unplaced.push({ u, why: u.deferred ? leftMsg + ' – payload full' : 'Over payload (weight limit)' }); continue; }
      if (rejectedCats.has(u.cat)) { unplaced.push({ u, why: 'Not co-loadable with ' + catName(rejectedCats.get(u.cat)) }); continue; }
      const fk = u.skuId + '|' + u.drop + '|' + !!u.deferred;
      if (fk === lastFailKey) { unplaced.push({ u, why: lastFailWhy }); continue; }
      if (Date.now() - t0 > opts.timeLimitMs) { timedOut = true; unplaced.push({ u, why: 'Time limit reached' }); continue; }

      let chosen = null;
      const whyCount = {};
      for (const p of points) {
        let best = null;
        for (const o of ors) {
          const [l, w, h] = o;
          const ok = o.key || (o.key = l + 'x' + w + 'x' + h);
          // Collisions and wall limits are permanent, so remember them per point.
          if (p.bad && p.bad.has(ok)) continue;
          if (p.x + l > L + EPS || p.y + w > W + EPS || p.z + h > Hmax + EPS) { (p.bad || (p.bad = new Set())).add(ok); continue; }
          if (p.z + h > u.ceil + EPS) { whyCount.wall = (whyCount.wall || 0) + 1; continue; }
          if (p.z + h > u.maxHeight + EPS) { whyCount.height = (whyCount.height || 0) + 1; continue; }
          const ol = Math.min(l + c, L - p.x), ow = Math.min(w + c, W - p.y);
          if (collides(p.x, p.y, p.z, ol, ow, h)) { (p.bad || (p.bad = new Set())).add(ok); continue; }
          if (multiStop && blockedToDoor(u, p.x, p.y, p.z, l, w, h)) { whyCount.drop = (whyCount.drop || 0) + 1; continue; }
          const s = supportFor(u, p.x, p.y, p.z, l, w);
          if (!s.ok) { whyCount[s.why] = (whyCount[s.why] || 0) + 1; continue; }
          // Prefer the orientation that spans more width (wall mode) / lower height (floor mode).
          const score = wallMode ? l - w * 0.001 : h * 1000 + l;
          if (!best || score < best.score) best = { p, l, w, h, ol, ow, sup: s.sup, score };
        }
        if (best) { chosen = best; break; }
      }

      if (!chosen) {
        const topWhy = Object.keys(whyCount).sort((a, b) => whyCount[b] - whyCount[a])[0];
        const msg = {
          floor: 'No floor space left (floor-only item)', under: 'No space (items below take nothing on top)',
          seg: 'No space (category must not be stacked on others)', drop: 'No space reachable from the door for this drop (LIFO)',
          support: 'No space with enough support', load: 'Stacking norm: max load on top / max layers', height: 'Stacking norm: max stack height',
          wall: 'No space below the side walls (only tall pieces may rise above them)',
        }[topWhy] || 'Not enough space (volume)';
        lastFailKey = fk; lastFailWhy = u.deferred ? leftMsg : msg;
        unplaced.push({ u, why: lastFailWhy });
        continue;
      }
      lastFailKey = null;

      const { p, l, w, h, ol, ow, sup } = chosen;
      const b = { u, x: p.x, y: p.y, z: p.z, l, w, h, ol, ow, top: p.z + h, load: 0, above: 0, sup, seq: placed.length + 1 };
      b.layer = sup.length ? 1 + Math.max(...sup.map((s) => s.b.layer)) : 1;
      for (const s of sup) addLoad(s.b, u.wt * s.f, 1);
      placed.push(b);
      addToBuckets(b);
      totalWt += u.wt;

      // Update extreme points.
      const fresh = [
        { x: p.x + ol, y: p.y, z: p.z }, { x: p.x, y: p.y + ow, z: p.z }, { x: p.x, y: p.y, z: p.z + h },
      ];
      const extra = [];
      fresh.forEach((q, i) => {
        if (i !== 2 && q.z > EPS) extra.push(projDown(q));
        if (i !== 1) extra.push(projY(q));
        if (i !== 0) extra.push(projX(q));
      });
      const keys = new Set();
      const next = [];
      for (const q of points.concat(fresh, extra)) {
        if (q.x >= L - EPS || q.y >= W - EPS || q.z >= Hmax - EPS) continue;
        const k = pkey(q);
        if (keys.has(k)) continue;
        keys.add(k);
        if (deadBy(q, b)) continue;
        if (q._new !== false && insideAny(q)) continue;
        q._new = false;
        next.push(q);
      }
      next.sort(cmp);
      points = next;
    }

    // Statistics
    const vVol = L * W * hc.Heff;
    const usedVol = placed.reduce((a, b) => a + b.l * b.w * b.h, 0);
    const aboveWall = placed.filter((b) => b.top > H + EPS);
    aboveWall.forEach((b) => (b.overWall = true));
    const floorArea = placed.filter((b) => b.z < EPS).reduce((a, b) => a + b.l * b.w, 0);
    const cog = placed.length
      ? {
          x: placed.reduce((a, b) => a + (b.x + b.l / 2) * b.u.wt, 0) / totalWt,
          y: placed.reduce((a, b) => a + (b.y + b.w / 2) * b.u.wt, 0) / totalWt,
          z: placed.reduce((a, b) => a + (b.z + b.h / 2) * b.u.wt, 0) / totalWt,
        }
      : null;
    const loadLen = placed.reduce((a, b) => Math.max(a, b.x + b.l), 0);
    const reqWt = units.reduce((a, u) => a + u.wt, 0);
    const reqVol = units.reduce((a, u) => a + u.l * u.w * u.h, 0);
    const volPct = (usedVol / vVol) * 100, wtPct = (totalWt / vehicle.payload) * 100;
    const stats = {
      vehicleVol: vVol, usedVol, volPct, usedWt: totalWt, wtPct,
      floorPct: (floorArea / (L * W)) * 100,
      packed: placed.length, unpacked: unplaced.length, total: units.length,
      reqWt, reqVol, cog, loadLen,
      // Floor counts as binding when floor-only / non-stackable items cover more of the deck than weight or volume use.
      binding: (() => { const fl = (floorArea / (L * W)) * 100; const ff = placed.some((b) => !b.u.onTop || !b.u.under); if (ff && fl >= 85 && fl > wtPct && fl > volPct) return 'Floor space'; return wtPct >= volPct ? 'Weight' : 'Volume'; })(),
      priorityUsed: pri, ms: Date.now() - t0, timedOut,
      open: hc.open, openMode: hc.mode, wallH: H, heightLimit: Hmax, aboveWall: aboveWall.length,
      maxTop: placed.reduce((a, b) => Math.max(a, b.top), 0),
      drops: [...new Set(units.map((u) => u.drop))].sort((a, b) => a - b),
    };
    return { vehicle, placed, unplaced, stats };
  }

  /** Small loads (few, large pieces such as project cargo): try several orders and both directions, keep the best. */
  function pack(vehicle, items, skuMap, opts) {
    opts = opts || {};
    const n = items.reduce((a, it) => a + Math.max(0, Math.floor(it.qty || 0)), 0);
    if (opts._single || n === 0 || n > 80) return packOnce(vehicle, items, skuMap, opts);
    const t0 = Date.now();
    const dirs = [opts.direction || 'nose_to_door', opts.direction === 'floor_to_top' ? 'nose_to_door' : 'floor_to_top'];
    const orders = ['stab', 'area', 'long', 'vol', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
    let best = null, tries = 0;
    const score = (r) => [r.stats.packed, r.stats.usedWt, -r.stats.loadLen];
    const better = (a, b) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) { if (x[i] > y[i] + 1e-6) return true; if (x[i] < y[i] - 1e-6) return false; } return false; };
    outer: for (const d of dirs) {
      for (const ord of orders) {
        const r = packOnce(vehicle, items, skuMap, Object.assign({}, opts, { direction: d, _order: ord, timeLimitMs: 1500 }));
        tries++;
        if (!best || better(r, best)) { best = r; best.stats.search = { direction: d, order: ord }; }
        if (best.stats.unpacked === 0 && d === dirs[0] && ord === 'stab') break outer; // default already perfect
        if (Date.now() - t0 > (opts.timeLimitMs || 8000)) break outer;
      }
      if (best.stats.unpacked === 0) break;
    }
    best.stats.ms = Date.now() - t0;
    best.stats.tries = tries;
    return best;
  }

  /** Usable volume: open bodies in "all items" mode count the space up to the height limit. */
  const effVol = (v, opts) => v.l * v.w * heightCaps(v, opts).Heff;
  const bySizeFor = (opts) => (a, b) => effVol(a, opts) - effVol(b, opts) || a.payload - b.payload;

  /** Smallest vehicle (by volume) that takes every unit. */
  function suggest(vehicles, items, skuMap, opts) {
    const sorted = vehicles.slice().sort(bySizeFor(opts));
    const results = [];
    for (const v of sorted) {
      const r = pack(v, items, skuMap, Object.assign({}, opts, { timeLimitMs: 4000 }));
      results.push({ vehicle: v, fitsAll: r.unplaced.length === 0, stats: r.stats });
    }
    const best = results.find((r) => r.fitsAll) || null;
    return { results, best };
  }

  // ---------- splitting a load across several trucks ----------
  const skuUnit = (s) => ({ l: +s.l, w: +s.w, h: +s.h, wt: +s.wt, rotate: s.rotate !== false, tip: !!s.tip });
  function totals(items, skuMap) {
    return items.reduce((a, it) => { const s = skuMap[it.skuId]; if (s) { a.wt += s.wt * it.qty; a.vol += s.l * s.w * s.h * it.qty; a.n += it.qty; } return a; }, { wt: 0, vol: 0, n: 0 });
  }
  function placedByLine(res) { const m = {}; res.placed.forEach((b) => (m[b.u.lineId] = (m[b.u.lineId] || 0) + 1)); return m; }
  const minus = (items, m) => items.map((it) => Object.assign({}, it, { qty: it.qty - (m[it.id] || 0) })).filter((it) => it.qty > 0);
  const only = (items, m) => items.filter((it) => m[it.id]).map((it) => Object.assign({}, it, { qty: m[it.id] }));

  /** Smallest vehicle that takes all of `items`, verified in 3D. Quick weight / volume / piece-size checks skip hopeless ones. */
  function smallestFitting(vehicles, items, skuMap, opts, deadline) {
    const t = totals(items, skuMap);
    const skus = [...new Set(items.map((it) => it.skuId))].map((id) => skuUnit(skuMap[id]));
    for (const v of vehicles.slice().sort(bySizeFor(opts))) {
      if (t.wt > v.payload + EPS || t.vol > effVol(v, opts) + EPS) continue;
      if (!skus.every((u) => unitFits(v, u, opts).ok)) continue;
      if (Date.now() > deadline) return null;
      const res = pack(v, items, skuMap, Object.assign({}, opts, { timeLimitMs: 2500 }));
      if (!res.unplaced.length) return { vehicle: v, res, items };
    }
    return null;
  }

  /** Split a load that no single vehicle can take across several trucks.
   *  Greedy: while the remainder is too big for one vehicle, fill a "filler" truck as full as the 3D packer can;
   *  the last part goes into the smallest vehicle that takes it. Each full truck is then downsized if a smaller
   *  vehicle still holds its contents. Several filler types are tried; the plan with the fewest trucks
   *  (then lowest ₹/km, or smallest total capacity when rates are missing) wins. */
  function splitPlan(vehicles, items, skuMap, opts) {
    const t0 = Date.now();
    opts = Object.assign({}, opts || {});
    // Lines for different destinations that share a drop number are separate shipments: plan each destination
    // on its own trucks. (Distinct drop numbers mean a deliberate multi-drop route, so those stay together.)
    if (!opts._group) {
      const byDrop = {};
      items.forEach((it) => { if (it.dest) (byDrop[it.drop] = byDrop[it.drop] || new Set()).add(String(it.dest).trim()); });
      if (Object.values(byDrop).some((set) => set.size > 1)) {
        const groups = new Map();
        items.forEach((it) => { const k = String(it.dest || '').trim(); (groups.get(k) || groups.set(k, []).get(k)).push(it); });
        const budget = opts.budgetMs || 20000;
        const parts = [...groups.entries()].map(([dest, its]) => {
          const p = splitPlan(vehicles, its, skuMap, Object.assign({}, opts, { _group: true, budgetMs: Math.max(4000, budget / groups.size) }));
          p.trucks.forEach((t) => (t.dest = dest));
          return p;
        });
        const sum = (f) => parts.reduce((a, p) => a + f(p), 0);
        const trucks = parts.flatMap((p) => p.trucks);
        return {
          trucks, oversize: parts.flatMap((p) => p.oversize), leftover: parts.flatMap((p) => p.leftover), byDest: true,
          stats: {
            trucks: trucks.length, lowerBound: sum((p) => p.stats.lowerBound), units: sum((p) => p.stats.units), packed: sum((p) => p.stats.packed),
            wt: sum((p) => p.stats.wt), oversizeUnits: sum((p) => p.stats.oversizeUnits), leftoverUnits: sum((p) => p.stats.leftoverUnits),
            cost: sum((p) => p.stats.cost), costBasis: parts[0] ? parts[0].stats.costBasis : 'capacity', filler: null, tried: sum((p) => p.stats.tried), ms: Date.now() - t0,
            avgUtil: trucks.length ? trucks.reduce((a, t) => a + Math.max(t.res.stats.volPct, t.res.stats.wtPct), 0) / trucks.length : 0,
            dests: [...groups.keys()],
          },
        };
      }
    }
    const deadline = t0 + (opts.budgetMs || 20000);
    vehicles = vehicles.filter((v) => v.active !== false && v.l > 0 && v.w > 0 && v.h > 0 && v.payload > 0);

    // 1) pieces no vehicle can carry at all (needs an ODC / special vehicle)
    const oversize = [], load = [];
    items.forEach((it) => {
      const s = skuMap[it.skuId];
      if (!s || !(it.qty > 0)) return;
      const checks = vehicles.map((v) => unitFits(v, skuUnit(s), opts));
      if (checks.some((c) => c.ok)) { load.push(Object.assign({}, it)); return; }
      const cnt = {};
      checks.forEach((c) => (cnt[c.why] = (cnt[c.why] || 0) + 1));
      oversize.push({ item: it, sku: s, qty: it.qty, why: Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0] || 'No vehicle selected' });
    });
    const T = totals(load, skuMap);
    const maxPay = Math.max(0, ...vehicles.map((v) => v.payload)), maxVol = Math.max(0, ...vehicles.map((v) => effVol(v, opts)));
    // Floor-only pieces (nothing may go under them) each need their own deck area.
    const maxDeck = Math.max(0, ...vehicles.map((v) => v.l * v.w));
    const floorNeed = load.reduce((a, it) => { const s = skuMap[it.skuId]; if (s.onTop !== false) return a; const fp = Math.min(...orientations(skuUnit(s)).map((o) => o[0] * o[1])); return a + fp * it.qty; }, 0);
    const lowerBound = T.n ? Math.max(1, Math.ceil(T.wt / maxPay - 1e-9), Math.ceil(T.vol / maxVol - 1e-9), Math.ceil(floorNeed / maxDeck - 1e-9)) : 0;
    const useRate = vehicles.length && vehicles.every((v) => +v.marketRate > 0);
    const costOf = (trucks) => trucks.reduce((a, t) => a + (useRate ? +t.vehicle.marketRate : effVol(t.vehicle, opts) / 1e6), 0);
    const finish = (trucks, leftover, filler, tried) => {
      const packed = trucks.reduce((a, t) => a + t.res.placed.length, 0);
      return {
        trucks, oversize, leftover,
        stats: {
          trucks: trucks.length, lowerBound, units: T.n, packed, wt: trucks.reduce((a, t) => a + t.res.stats.usedWt, 0),
          oversizeUnits: oversize.reduce((a, o) => a + o.qty, 0), leftoverUnits: leftover.reduce((a, o) => a + o.qty, 0),
          cost: costOf(trucks), costBasis: useRate ? 'rate' : 'capacity', filler, tried, ms: Date.now() - t0,
          avgUtil: trucks.length ? trucks.reduce((a, t) => a + Math.max(t.res.stats.volPct, t.res.stats.wtPct), 0) / trucks.length : 0,
        },
      };
    };
    if (!load.length) return finish([], [], null, 0);

    // 2) the whole load fits one vehicle → no split needed
    const one = smallestFitting(vehicles, load, skuMap, opts, deadline);
    if (one) return finish([one], [], null, 0);

    // 3) filler candidates: vehicles that carry the biggest share of this load (distinct sizes, best 3)
    const share = (v) => Math.min(v.payload / T.wt, effVol(v, opts) / T.vol);
    const seen = new Set();
    const fillers = vehicles.slice().sort((a, b) => share(b) - share(a) || bySizeFor(opts)(a, b)).filter((v) => {
      const k = [v.l, v.w, v.h, v.payload, isOpen(v)].join('|');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const fillOpts = Object.assign({}, opts, { timeLimitMs: 2500 });
    const absorbOpts = Object.assign({}, opts, { timeLimitMs: 1200 });

    // Merge lines that share an id (the same item line split over several trucks).
    const combine = (list) => { const m = new Map(); list.forEach((it) => { const c = m.get(it.id); if (c) c.qty += it.qty; else m.set(it.id, Object.assign({}, it)); }); return [...m.values()]; };

    /** Load `rem` onto more trucks: the smallest vehicle that takes all of it, else fill one (preferring `order[0]`)
     *  as full as the packer can and repeat. Then merge and downsize. */
    function complete(trucks, rem, order) {
      let guard = 0;
      while (rem.length && guard++ < 60) {
        const last = smallestFitting(vehicles, rem, skuMap, opts, deadline);
        if (last) { trucks.push(last); rem = []; break; }
        let step = null;
        for (const v of order) {
          const res = pack(v, rem, skuMap, fillOpts);
          if (res.placed.length) { step = { vehicle: v, res, items: only(rem, placedByLine(res)) }; break; }
          if (Date.now() > deadline) break;
        }
        if (!step) break;
        trucks.push(step);
        rem = minus(rem, placedByLine(step.res));
        if (Date.now() > deadline) break;
      }
      absorb(trucks, order);
      // Downsize trucks whose contents fit a smaller vehicle.
      trucks.forEach((t, i) => {
        if (Date.now() > deadline) return;
        const smaller = vehicles.filter((v) => effVol(v, opts) < effVol(t.vehicle, opts) - EPS || (effVol(v, opts) <= effVol(t.vehicle, opts) + EPS && v.payload < t.vehicle.payload));
        if (!smaller.length) return;
        const d = smallestFitting(smaller, t.items, skuMap, opts, deadline);
        if (d) trucks[i] = d;
      });
      const leftover = rem.map((it) => ({ item: it, qty: it.qty, why: 'Could not be placed in any truck' }));
      return { trucks, leftover };
    }

    /** Greedy: fill one truck at a time, densest goods first (per the weight/volume priority). */
    function greedy(first) {
      const order = [first].concat(fillers.filter((v) => v !== first));
      const rem = load.map((it) => Object.assign({}, it));
      // The whole load does not fit one vehicle (checked above), so start by filling.
      const res = pack(first, rem, skuMap, fillOpts);
      const trucks = res.placed.length ? [{ vehicle: first, res, items: only(rem, placedByLine(res)) }] : [];
      return complete(trucks, res.placed.length ? minus(rem, placedByLine(res)) : rem, order);
    }

    /** Balanced: share every item line evenly over k trucks of type V, so each truck gets the same mix of
     *  floor-only, heavy and stackable goods; leftovers go into spare room or extra trucks. */
    function balanced(V, k) {
      const order = [V].concat(fillers.filter((v) => v !== V));
      const parts = Array.from({ length: k }, () => []);
      let rot = 0;
      load.slice().sort((a, b) => b.qty - a.qty).forEach((it) => {
        const base = Math.floor(it.qty / k), extra = it.qty % k;
        for (let i = 0; i < k; i++) {
          const q = base + ((i - rot + k) % k < extra ? 1 : 0);
          if (q > 0) parts[i].push(Object.assign({}, it, { qty: q }));
        }
        rot = (rot + extra) % k;
      });
      const trucks = [];
      let rem = [];
      for (const p of parts) {
        if (!p.length) continue;
        if (Date.now() > deadline) { rem = rem.concat(p); continue; }
        const res = pack(V, p, skuMap, absorbOpts);
        const m = placedByLine(res);
        if (res.placed.length) trucks.push({ vehicle: V, res, items: only(p, m) });
        rem = rem.concat(minus(p, m));
      }
      rem = combine(rem);
      // Leftovers: first into the spare room of the balanced trucks, then onto extra trucks.
      for (let j = 0; j < trucks.length && rem.length && Date.now() < deadline; j++) {
        const t = trucks[j];
        const combo = combine(t.items.concat(rem));
        const res = pack(V, combo, skuMap, fillOpts);
        const m = placedByLine(res);
        const ownOk = t.items.every((it) => (m[it.id] || 0) >= it.qty);
        const gained = res.placed.length - t.res.placed.length;
        if (!ownOk || gained <= 0) continue;
        const extra = {};
        combo.forEach((it) => { const own = (t.items.find((x) => x.id === it.id) || { qty: 0 }).qty; const e = (m[it.id] || 0) - own; if (e > 0) extra[it.id] = e; });
        trucks[j] = { vehicle: V, res, items: only(combo, m) };
        rem = minus(rem, extra);
      }
      return complete(trucks, rem, order);
    }

    /** Try to empty the least-used truck into the spare room of the others (moving a truck up to a bigger
     *  vehicle when that helps). A truck is removed only when every one of its units found a new place. */
    function absorb(trucks, fl) {
      const fill = (t) => Math.max(t.res.stats.volPct, t.res.stats.wtPct, t.res.stats.floorPct);
      let changed = true;
      while (changed && trucks.length > 1 && Date.now() < deadline) {
        changed = false;
        const byFill = trucks.map((t, i) => i).sort((a, b) => fill(trucks[a]) - fill(trucks[b])).slice(0, 2);
        for (const i of byFill) {
          if (Date.now() > deadline) return;
          let rem = trucks[i].items.map((it) => Object.assign({}, it));
          const next = trucks.slice();
          const others = trucks.map((t, j) => j).filter((j) => j !== i).sort((a, b) => fill(trucks[a]) - fill(trucks[b]));
          for (const j of others) {
            if (!rem.length || Date.now() > deadline) break;
            const own = next[j].items;
            const bigger = fl.filter((v) => effVol(v, opts) > effVol(next[j].vehicle, opts) + EPS || v.payload > next[j].vehicle.payload + EPS).sort(bySizeFor(opts)).slice(0, 2);
            for (const v of [next[j].vehicle].concat(bigger)) {
              const combo = own.map((it) => Object.assign({}, it));
              rem.forEach((r) => { const c = combo.find((x) => x.id === r.id); if (c) c.qty += r.qty; else combo.push(Object.assign({}, r)); });
              const res = pack(v, combo, skuMap, absorbOpts);
              const m = placedByLine(res);
              if (!own.every((it) => (m[it.id] || 0) >= own.filter((x) => x.id === it.id).reduce((a, x) => a + x.qty, 0))) continue;
              const extra = {};
              combo.forEach((it) => { const ownQ = own.filter((x) => x.id === it.id).reduce((a, x) => a + x.qty, 0); const e = (m[it.id] || 0) - ownQ; if (e > 0) extra[it.id] = e; });
              if (!Object.keys(extra).length) continue;
              next[j] = { vehicle: v, res, items: only(combo, m) };
              rem = minus(rem, extra);
              break;
            }
          }
          if (!rem.length) { next.splice(i, 1); trucks.length = 0; trucks.push(...next); changed = true; break; }
        }
      }
    }

    let best = null, tried = 0;
    const score = (p) => [p.leftover.reduce((a, o) => a + o.qty, 0), p.trucks.length, costOf(p.trucks)];
    const better = (a, b) => { const x = score(a), y = score(b); for (let i = 0; i < 3; i++) { if (x[i] < y[i] - 1e-9) return true; if (x[i] > y[i] + 1e-9) return false; } return false; };
    const consider = (p, label) => {
      p.filler = label;
      tried++;
      if (!best || better(p, best)) best = p;
      return !best.leftover.length && best.trucks.length <= lowerBound; // cannot do better than the bound
    };
    // Balanced split on the two best filler types, at the fewest trucks each could manage and one more.
    const need = (v) => {
      const deck = v.l * v.w;
      return Math.max(1, Math.ceil(T.wt / v.payload - 1e-9), Math.ceil(T.vol / effVol(v, opts) - 1e-9), Math.ceil(floorNeed / deck - 1e-9));
    };
    let done = false;
    for (const f of fillers.slice(0, 2)) {
      if (done || (best && Date.now() > deadline)) break;
      const k0 = need(f);
      for (const k of [k0, k0 + 1]) {
        if (best && (Date.now() > deadline || k >= best.trucks.length)) break;
        if (consider(balanced(f, k), f.name + ' ×' + k + ' (balanced)')) { done = true; break; }
      }
    }
    // Greedy fill on the three best filler types.
    for (const f of fillers.slice(0, 3)) {
      if (done || (best && Date.now() > deadline)) break;
      if (consider(greedy(f), f.name + ' (greedy)')) break;
    }
    best.trucks.forEach((t) => { const ds = [...new Set(t.items.map((it) => it.dest).filter(Boolean))]; if (ds.length && !t.dest) t.dest = ds.join(', '); });
    // Heaviest / largest trucks first, so truck 1 is the main load.
    best.trucks.sort((a, b) => effVol(b.vehicle, opts) - effVol(a.vehicle, opts) || b.res.stats.usedWt - a.res.stats.usedWt);
    return finish(best.trucks, best.leftover, best.filler, tried);
  }

  const api = { pack, suggest, splitPlan, smallestFitting, expandUnits, compatOf, orientations, resolvePriority, isOpen, defaultOpen, heightCaps, unitFits, effVol };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Packer = api;
})(typeof window !== 'undefined' ? window : globalThis);
