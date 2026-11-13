/* RoaDo Optimizer – UI controller */
(function () {
  'use strict';
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 0) => (Number.isFinite(+n) ? Number(n).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d }) : '–');
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const KEY = 'roado-loadopt-v2';
  const DROP_COLORS = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#be185d', '#65a30d'];
  const NEW = (n) => `<span class="newtag" title="New constraint #${n}">New · #${n}</span>`;
  const PRESETS = {
    standard: { clearance: 0, supportRatio: 0.8 },
    tight: { clearance: 0, supportRatio: 0.7 },
    safety: { clearance: 3, supportRatio: 0.9 },
  };

  // ---------------- state ----------------
  function defaults() {
    const d = clone(window.DEFAULT_DATA);
    return {
      categories: d.categories, compat: d.compat, skus: d.skus, vehicles: d.vehicles, slabs: d.slabs, dc: d.dc,
      regionRules: d.regionRules, customers: d.customers, settings: d.settings,
      items: [], selectedVehicleId: '24-feet', custFilterId: '', orders: [], split: false, splitIds: null,
      sim: { clock: 0, lastPlanAt: 0, log: [], seq: 1 }, audit: [], seeded: false,
      ui: { tab: 'optimizer', mtab: 'skus', colorMode: 'sku', catFilter: '', search: '', planExpanded: null, hlCat: '', truck: 0 },
    };
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const s = JSON.parse(raw);
        const d = defaults();
        const out = Object.assign(d, s);
        const ss = s.settings || {};
        out.settings = { opt: Object.assign(d.settings.opt, ss.opt), plan: Object.assign(d.settings.plan, ss.plan), trigger: Object.assign(d.settings.trigger, ss.trigger), fleet: Object.assign(d.settings.fleet, ss.fleet), units: ss.units || d.settings.units };
        out.ui = Object.assign(d.ui, s.ui);
        out.sim = Object.assign(d.sim, s.sim);
        return out;
      }
    } catch (e) { /* storage unavailable */ }
    return defaults();
  }
  let S = load();
  let loadPlan = null, planResult = null, planStale = false, loadContext = '', autoTimer = null, playTimer = null;
  let fleetPlan = null; // multi-truck plan when the load is split across vehicles
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } }

  const skuMap = () => Object.fromEntries(S.skus.map((s) => [s.id, s]));
  const catMap = () => Object.fromEntries(S.categories.map((c) => [c.id, c]));
  const vehMap = () => Object.fromEntries(S.vehicles.map((v) => [v.id, v]));
  const custMap = () => Object.fromEntries(S.customers.map((c) => [c.id, c]));
  const catName = (id) => (catMap()[id] || { name: id }).name;
  const catBadge = (id) => { const c = catMap()[id] || { name: id, color: '#888' }; return `<span class="badge"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</span>`; };
  const vName = (id) => (vehMap()[id] || { name: id || '—' }).name;
  // Display units: lengths are stored in cm, shown in inches (default, as in the packing list) or cm.
  const UNIT = () => (S.settings.units === 'cm' ? 'cm' : 'in');
  const PER = () => (UNIT() === 'in' ? 2.54 : 1);
  const toU = (cm) => cm / PER();
  const fromU = (v) => v * PER();
  const r1 = (x) => Math.round(x * 10) / 10;
  const fmtL = (cm) => { const v = r1(toU(cm)); return fmt(v, Number.isInteger(v) ? 0 : 1); };
  const lenU = (cm) => `${fmtL(cm)} ${UNIT()}`;
  const dims = (o) => `${fmtL(o.l)}×${fmtL(o.w)}×${fmtL(o.h)} ${UNIT()}`;
  const vol = (cm3) => (UNIT() === 'in' ? cm3 / 28316.846592 : cm3 / 1e6);
  const volU = () => (UNIT() === 'in' ? 'ft³' : 'm³');
  const DOOR = { Left: 'End door', Top: 'Top-loading', None: 'Open body' };
  const doorText = (v) => (v.door === 'Left' && v.doorW ? `End door ${fmtL(v.doorW)}×${fmtL(v.doorH)} ${UNIT()}` : DOOR[v.door] || 'Open body');
  const LB = 0.45359237;
  function derivePayloads() { S.vehicles.forEach((v) => { if (v.payloadSrc != null) v.payload = Math.round(+v.payloadSrc * (S.settings.fleet.payloadUnit === 'lb' ? LB : 1)); }); }
  const simTime = (min) => { const t = 8 * 60 + Math.round(min); const h = Math.floor(t / 60) % 24, m = t % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
  const uid = (p) => p + Math.random().toString(36).slice(2, 8);

  function audit(action, entity, details) {
    S.audit.unshift({ t: new Date().toISOString(), action, entity, details: details || '' });
    if (S.audit.length > 600) S.audit.length = 600;
    save();
    if (S.ui.tab === 'audit') renderAudit();
  }
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------------- dialog ----------------
  const dlg = $('#dlg');
  function openDialog(title, body, footer, onMount) {
    dlg.innerHTML = `<div class="dlg-h"><span>${title}</span><button class="btn ghost xs" data-act="dlg-close" aria-label="Close">✕</button></div><div class="dlg-b">${body}</div>${footer ? `<div class="dlg-f">${footer}</div>` : ''}`;
    if (!dlg.open) dlg.showModal();
    if (onMount) onMount(dlg);
  }
  function closeDialog() { if (dlg.open) dlg.close(); }

  // ---------------- 3D ----------------
  const tip = $('#tip');
  const viz = new window.LoadViz($('#viz'), {
    onHover(b, e) {
      if (!b || !e) { tip.style.display = 'none'; return; }
      const u = b.u;
      tip.innerHTML = `<div style="font-weight:600;margin-bottom:3px">${esc(u.name)}</div>
        <div class="kv"><dt>SKU</dt><dd>${esc(u.skuId)}</dd><dt>Category</dt><dd>${esc(catName(u.cat))}</dd>
        <dt>Size</dt><dd>${dims(b)}</dd><dt>Weight</dt><dd>${fmt(u.wt, 1)} kg</dd>
        <dt>Drop</dt><dd>${u.drop}${u.dest ? ' · ' + esc(u.dest) : ''}</dd><dt>Position</dt><dd>x ${fmtL(b.x)} · y ${fmtL(b.y)} · z ${fmtL(b.z)} ${UNIT()}</dd>
        <dt>Layer</dt><dd>${b.layer} (max ${u.maxStack})</dd><dt>Load on top</dt><dd>${fmt(b.load, 1)} kg${Number.isFinite(u.maxTopKg) ? ' / ' + fmt(u.maxTopKg) : ''}</dd>
        <dt>Load step</dt><dd>${b.seq}</dd>${b.overWall ? `<dt>Above walls</dt><dd>top at ${lenU(b.top)} – lash &amp; tarp</dd>` : ''}</div>`;
      tip.style.display = 'block';
      const x = Math.min(e.clientX + 14, window.innerWidth - 290), y = Math.min(e.clientY + 14, window.innerHeight - 220);
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    },
  });
  function colorFor(b) {
    const m = S.ui.colorMode;
    if (m === 'category') return (catMap()[b.u.cat] || {}).color || '#888';
    if (m === 'drop') return DROP_COLORS[(b.u.drop - 1) % DROP_COLORS.length];
    return b.u.color || '#888';
  }

  // ---------------- packing ----------------
  function packOpts() {
    const f = S.settings.fleet;
    return Object.assign({}, S.settings.opt, { openTopH: Math.max(0, (+f.roadH || 0) - (+f.deckH || 0)), compat: S.compat, catNames: Object.fromEntries(S.categories.map((c) => [c.id, c.name])) });
  }
  /** Height limit for an open body: its own max load height, else the global road height − deck height. */
  const openLimit = (v) => (+v.maxLoadH > 0 ? +v.maxLoadH : packOpts().openTopH);
  const OPEN_MODES = { off: 'Off – keep loads inside the walls', large: 'Only pieces taller than the walls', all: 'All items, stacks too' };
  function optimize(silent) {
    if (S.split) { optimizeSplit(silent); return; }
    fleetPlan = null;
    const v = vehMap()[S.selectedVehicleId];
    if (!v) { toast('Choose a vehicle first'); return; }
    if (!S.items.length) { toast('Add items first'); return; }
    const btn = $('#btn-optimize');
    if (btn) { btn.disabled = true; btn.textContent = 'Optimizing…'; }
    setTimeout(() => {
      loadPlan = Packer.pack(v, S.items, skuMap(), packOpts());
      planStale = false;
      viz.setPlan(loadPlan, colorFor);
      applyHighlight();
      renderOptimizer();
      if (S.ui.tab === 'sequence') renderSequence();
      const st = loadPlan.stats;
      if (!silent) audit('Optimized load', v.name, `${st.packed}/${st.total} units · volume ${fmt(st.volPct, 1)}% · weight ${fmt(st.wtPct, 1)}% · binding ${st.binding}`);
    }, 30);
  }
  function markStale() { if (loadPlan || fleetPlan) planStale = true; }

  // ---------- multi-truck split ----------
  /** Vehicles the split may use: the ones picked in Suggest Vehicle, else every active vehicle the customer allows. */
  function splitCandidates() {
    const ok = S.vehicles.filter((v) => v.active !== false && vehicleAllowed(v).ok);
    const ids = Array.isArray(S.splitIds) && S.splitIds.length ? new Set(S.splitIds) : null;
    const c = ids ? ok.filter((v) => ids.has(v.id)) : ok;
    return c.length ? c : ok;
  }
  function optimizeSplit(silent) {
    if (!S.items.length) { toast('Add items first'); return; }
    const btn = $('#btn-optimize');
    if (btn) { btn.disabled = true; btn.textContent = 'Splitting across trucks…'; }
    toast('Planning trucks – this can take a few seconds…');
    setTimeout(() => {
      fleetPlan = Packer.splitPlan(splitCandidates(), S.items, skuMap(), packOpts());
      planStale = false;
      if (S.ui.truck >= fleetPlan.trucks.length) S.ui.truck = 0;
      const t = fleetPlan.trucks[S.ui.truck];
      loadPlan = t ? t.res : null;
      if (t) S.selectedVehicleId = t.vehicle.id;
      save();
      viz.setPlan(loadPlan, colorFor);
      applyHighlight();
      renderOptimizer();
      if (S.ui.tab === 'sequence') renderSequence();
      const st = fleetPlan.stats;
      if (!silent) audit('Split load across trucks', `${st.trucks} trucks`, `${st.packed}/${st.units} units · ${fleetPlan.trucks.map((x) => x.vehicle.name).join(' + ')}${st.oversizeUnits ? ` · ${st.oversizeUnits} oversize` : ''}`);
    }, 40);
  }
  function showTruck(i) {
    if (!fleetPlan || !fleetPlan.trucks[i]) return;
    S.ui.truck = i;
    loadPlan = fleetPlan.trucks[i].res;
    S.selectedVehicleId = loadPlan.vehicle.id;
    save();
    viz.setPlan(loadPlan, colorFor);
    applyHighlight();
    renderCurrent();
  }
  function exitSplit() { S.split = false; S.splitIds = null; fleetPlan = null; S.ui.truck = 0; }
  const truckLabel = () => (fleetPlan && loadPlan ? `Truck ${S.ui.truck + 1} of ${fleetPlan.trucks.length}` : '');

  // ---------------- tabs ----------------
  function setTab(t) {
    S.ui.tab = t;
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + t));
    save();
    renderCurrent();
    if (t === 'optimizer') setTimeout(() => viz.resize(), 0);
  }
  function renderCurrent() {
    ({ optimizer: renderOptimizer, planning: renderPlanning, sequence: renderSequence, compat: renderCompat, masters: renderMasters, audit: renderAudit }[S.ui.tab] || renderOptimizer)();
  }

  // =====================================================================
  //  LOAD OPTIMIZER
  // =====================================================================
  function renderOptimizer() {
    renderSummary();
    renderLeft();
    renderVizChrome();
    renderItems();
  }

  function pctBar(p, cls) { const c = Math.max(0, Math.min(100, p)); return `<div class="bar ${cls || ''} ${p > 100 ? 'hot' : ''}"><i style="width:${c}%"></i></div>`; }

  function fleetStrip() {
    const fp = fleetPlan, st = fp.stats;
    const n = st.trucks;
    const why = fp.byDest ? `${n} truck${n === 1 ? '' : 's'} in total; each is the smallest vehicle that still holds its share.`
      : n <= 1 ? 'The whole load fits one vehicle, so no split is needed.'
      : n > st.lowerBound ? `No single vehicle takes the whole load. Weight, volume and floor-only deck space alone would allow ${st.lowerBound}; piece shapes and stacking norms need ${n}. Each truck is the smallest vehicle that still holds its share.`
      : `No single vehicle takes the whole load. ${n} trucks is the minimum possible for this weight, volume and deck space, and each truck is the smallest vehicle that still holds its share.`;
    const leftN = st.oversizeUnits + st.leftoverUnits;
    const destNote = fp.byDest ? `Destinations ${st.dests.map((d) => d || '(none)').join(', ')} share a drop number, so each is planned on its own trucks. ` : '';
    return `<div class="card mb">
      ${planStale ? `<div class="callout warn" style="margin:10px 14px 0">Items or settings changed. <button class="btn xs" data-act="optimize">Re-plan trucks</button></div>` : ''}
      <div class="card-h"><div><div class="card-t">Multi-truck plan <span class="badge acc">${n} truck${n === 1 ? '' : 's'}</span> ${leftN ? `<span class="badge bad">${leftN} units not loaded</span>` : '<span class="badge ok">All units loaded</span>'}</div>
        <div class="card-d">${esc(destNote + why)}</div></div>
        <div class="row"><button class="btn sm" data-act="split-vehicles">Choose vehicles…</button><button class="btn sm" data-act="single-vehicle">Back to single vehicle</button></div></div>
      <div class="card-b">
        <div class="trucks" role="tablist" aria-label="Trucks">${fp.trucks.map((t, i) => { const ts = t.res.stats; return `<button class="truck ${i === S.ui.truck ? 'on' : ''}" role="tab" aria-selected="${i === S.ui.truck}" data-act="pick-truck" data-v="${i}">
          <div class="row between"><b>Truck ${i + 1}</b>${ts.aboveWall ? `<span class="badge acc" title="${ts.aboveWall} pieces above the side walls">↑ ${ts.aboveWall}</span>` : ''}</div>
          <div class="tv">${esc(t.vehicle.name)}</div>${t.dest ? `<div class="xs">→ ${esc(t.dest)}</div>` : ''}
          <div class="xs muted">${fmt(ts.packed)} units · ${fmt(ts.usedWt)} kg${ts.drops.length > 1 ? ` · drops ${ts.drops.join(', ')}` : ''}</div>
          <div class="tb"><span>Vol</span>${pctBar(ts.volPct)}<span class="num">${fmt(ts.volPct, 0)}%</span></div>
          <div class="tb"><span>Wt</span>${pctBar(ts.wtPct, 'w')}<span class="num">${fmt(ts.wtPct, 0)}%</span></div></button>`; }).join('')}</div>
        <div class="xs muted mt">${fmt(st.packed)} / ${fmt(st.units + st.oversizeUnits)} units · ${fmt(st.wt)} kg · average utilisation ${fmt(st.avgUtil, 0)}% (higher of weight and volume) · ${st.costBasis === 'rate' ? 'cheapest by market ₹/km' : 'smallest total capacity (set market ₹/km in Masters → Fleet to choose by cost)'} · ${fmt(st.ms)} ms</div>
        ${fp.oversize.length ? `<div class="callout warn mt"><b>${st.oversizeUnits} units fit no selected vehicle</b> and need an ODC / special vehicle: ${fp.oversize.map((o) => `${esc(o.sku.id)} ${esc(o.sku.name)} ×${o.qty} (${dims(o.sku)}, ${fmt(o.sku.wt)} kg – ${esc(o.why)})`).join('; ')}</div>` : ''}
        ${fp.leftover.length ? `<div class="callout warn mt">${st.leftoverUnits} units could not be placed in time: ${fp.leftover.map((o) => `${esc(o.item.skuId)} ×${o.qty}`).join(', ')}. Try fewer vehicle types or re-plan.</div>` : ''}
      </div></div>`;
  }

  function renderSummary() {
    const el = $('#lo-summary');
    if (!S.items.length) { el.innerHTML = ''; return; }
    const v = vehMap()[S.selectedVehicleId];
    const strip = fleetPlan ? fleetStrip() : '';
    if (!loadPlan) {
      el.innerHTML = strip || `<div class="card"><div class="card-b row between"><div><div class="card-t">Load Plan Summary</div><div class="card-d">Optimize your load to see summary</div></div><button class="btn primary" data-act="optimize">Optimize Loading</button></div></div>`;
      return;
    }
    const st = loadPlan.stats;
    const cogPct = st.cog ? (st.cog.x / loadPlan.vehicle.l) * 100 : 0;
    const lat = st.cog ? st.cog.y - loadPlan.vehicle.w / 2 : 0;
    const cogOk = cogPct >= 30 && cogPct <= 60 && Math.abs(lat) <= 15;
    const reasons = {};
    loadPlan.unplaced.forEach(({ u, why }) => { const k = why; (reasons[k] = reasons[k] || {}); reasons[k][u.name] = (reasons[k][u.name] || 0) + 1; });
    const priLabel = { auto: 'Auto', weight: 'Weight first', volume: 'Volume first' }[S.settings.opt.priority];
    const lv = loadPlan.vehicle;
    el.innerHTML = `${strip}<div class="card">
      ${planStale && !fleetPlan ? `<div class="callout warn" style="margin:10px 14px 0">Items or settings changed. <button class="btn xs" data-act="optimize">Apply and Repack</button></div>` : ''}
      <div class="summary">
        <div class="metric"><div class="k">${fleetPlan ? esc(truckLabel()) : 'Load Plan Summary'}</div>${loadContext ? `<div><span class="badge acc" style="white-space:normal">${esc(loadContext)}</span></div>` : ''}
          <div style="font-weight:600;font-size:15px">${esc(lv.name)}</div>
          <div class="s">${dims(lv)} · ${fmt(lv.payload)} kg payload · ${esc(doorText(lv))}${st.open ? ` · loads up to ${lenU(st.heightLimit)}` : ''}</div>
          ${fleetPlan ? '' : `<div class="row" style="margin-top:4px"><button class="btn xs" data-act="focus-vehicle">Change Vehicle</button><button class="btn xs" data-act="suggest">Suggest Vehicle</button></div>`}
        </div>
        <div class="metric" title="Share of the vehicle's volume filled"><div class="k">Volume Used</div><div class="v">${fmt(st.volPct, 1)}%</div>${pctBar(st.volPct)}<div class="s">${fmt(vol(st.usedVol), 1)} / ${fmt(vol(st.vehicleVol), 0)} ${volU()}</div></div>
        <div class="metric" title="Share of the vehicle's weight capacity used"><div class="k">Weight</div><div class="v">${fmt(st.wtPct, 1)}%</div>${pctBar(st.wtPct, 'w')}<div class="s">${fmt(st.usedWt)} / ${fmt(loadPlan.vehicle.payload)} kg</div></div>
        <div class="metric" title="Share of the vehicle's floor covered. Items that cannot be stacked need floor, so this can be high while space is low."><div class="k">Floor</div><div class="v">${fmt(st.floorPct, 0)}%</div>${pctBar(st.floorPct, 'f')}<div class="s">Load length ${lenU(st.loadLen)}</div></div>
        <div class="metric"><div class="k">Binding constraint ${NEW(3)}</div><div class="v" style="font-size:17px">${st.binding}</div>${st.binding === 'Floor space' ? '<div class="s">Floor-only / non-stackable pieces fill the deck</div>' : ''}
          <div class="s">Priority: ${priLabel}${S.settings.opt.priority === 'auto' ? ' → ' + (st.priorityUsed === 'weight' ? 'weight' : 'volume') : ''}</div></div>
        <div class="metric"><div class="k">Packed</div><div class="v">${fmt(st.packed)}<span class="muted" style="font-size:14px"> / ${fmt(st.total)}</span></div>
          <div class="s">${st.unpacked ? `<span class="badge bad">${st.unpacked} left out</span>` : '<span class="badge ok">All packed</span>'}</div>
          <div class="s">CoG ${fmt(cogPct, 0)}% from nose ${cogOk ? '<span class="badge ok">balanced</span>' : '<span class="badge warn">check axle</span>'}</div></div>
      </div>
      ${st.aboveWall ? `<div class="callout mt" style="margin:0 14px 12px"><b>${st.aboveWall} piece${st.aboveWall === 1 ? '' : 's'} above the side walls</b> (walls ${lenU(st.wallH)}, load reaches ${lenU(st.maxTop)} of the ${lenU(st.heightLimit)} limit). Lash and tarp them, and check bridges and overhead wires on the route.</div>` : ''}
      ${!fleetPlan && sharedDrop().length ? `<div class="callout warn" style="margin:0 14px 12px">${sharedDrop().map((x) => `Drop ${x.drop} has ${x.dests.length} destinations (${x.dests.map(esc).join(', ')})`).join('; ')} – they are loaded as one stop. Give each destination its own drop number for a multi-drop route, or use <button class="btn xs" data-act="split-run">Split across trucks</button> to send each destination on its own trucks.</div>` : ''}
      ${st.unpacked && !fleetPlan ? `<div class="callout warn" style="margin:0 14px 12px">${st.unpacked} unit${st.unpacked === 1 ? '' : 's'} do not fit in ${esc(lv.name)}. <button class="btn xs" data-act="suggest">Find a bigger vehicle</button> <button class="btn xs primary" data-act="split-run">Split across trucks</button></div>` : ''}
      ${st.unpacked ? `<details class="unpacked"><summary>Unpacked items: ${st.unpacked} units – why</summary><ul class="flags" style="margin-top:6px">${Object.keys(reasons).map((r) => `<li><b>${esc(r)}</b>: ${Object.keys(reasons[r]).map((n) => `${esc(n)} ×${reasons[r][n]}`).join(', ')}</li>`).join('')}</ul></details>` : ''}
    </div>`;
  }

  /** Drop numbers shared by more than one destination (usually a CSV with every row on drop 1). */
  function sharedDrop() {
    const by = {};
    S.items.forEach((it) => { if (it.dest) (by[it.drop] = by[it.drop] || new Set()).add(it.dest.trim()); });
    return Object.keys(by).filter((d) => by[d].size > 1).map((d) => ({ drop: +d, dests: [...by[d]] }));
  }

  function vehicleAllowed(v) {
    if (!S.custFilterId) return { ok: true };
    const cu = custMap()[S.custFilterId];
    if (!cu) return { ok: true };
    const allowed = Planner.allowedFor(cu, S).map((x) => x.id);
    const lim = Planner.effectiveMaxVehicle(cu, S);
    return allowed.includes(v.id) ? { ok: true } : { ok: false, why: lim ? `max ${vName(lim.id)} – ${lim.source}` : 'not allowed' };
  }

  function renderLeft() {
    const o = S.settings.opt;
    const v = vehMap()[S.selectedVehicleId];
    const cu = custMap()[S.custFilterId];
    const lim = cu ? Planner.effectiveMaxVehicle(cu, S) : null;
    $('#lo-left').innerHTML = `
    <div class="card" id="vehicle-card">
      <div class="card-h"><div class="card-t">Vehicle / Container</div></div>
      <div class="card-b">
        <div class="field"><label class="lbl" for="cust-filter">Deliver to customer (optional) ${NEW(2)}</label>
          <select id="cust-filter" data-act-change="cust-filter"><option value="">— Any customer (no restriction) —</option>
          ${S.customers.map((c) => `<option value="${esc(c.id)}" ${c.id === S.custFilterId ? 'selected' : ''}>${esc(c.name)} · ${esc(c.region)}</option>`).join('')}</select>
          ${lim ? `<div class="hint" style="color:var(--warn)">Vehicle limited to ${esc(vName(lim.id))} or smaller (${esc(lim.source)}).</div>` : ''}
        </div>
        <div class="field"><label class="lbl" for="veh-select">Vehicle</label>
          <select id="veh-select" data-act-change="vehicle">
          ${S.vehicles.map((x) => { const a = vehicleAllowed(x); return `<option value="${esc(x.id)}" ${x.id === S.selectedVehicleId ? 'selected' : ''} ${a.ok ? '' : 'disabled'}>${esc(x.name)}${a.ok ? '' : ' — ' + esc(a.why)}</option>`; }).join('')}
          </select></div>
        ${v ? `<div class="hint">${dims(v)} · ${fmt(vol(v.l * v.w * v.h), 0)} ${volU()} · ${fmt(v.payload)} kg · ${esc(doorText(v))}</div>` : ''}
        ${v && Packer.isOpen(v) ? `<div class="hint">Open top · ${o.openTop === 'off' ? `loads stay within the ${lenU(v.h)} walls` : `${o.openTop === 'all' ? 'loads' : 'tall pieces'} may rise to ${lenU(Math.max(v.h, openLimit(v)))}`}</div>` : ''}
        ${fleetPlan ? `<div class="callout mt">Multi-truck plan: ${fleetPlan.trucks.length} trucks. Showing ${esc(truckLabel())}. Picking a vehicle here goes back to a single vehicle.</div>` : ''}
        ${v && !vehicleAllowed(v).ok ? `<div class="callout warn" style="margin-top:8px">${esc(v.name)} is not allowed for ${esc(cu.name)}: ${esc(vehicleAllowed(v).why)}.</div>` : ''}
        <div class="row mt" style="gap:6px"><button class="btn sm" style="flex:1" data-act="suggest" ${S.items.length ? '' : 'disabled'}>✦ Suggest Vehicle</button><button class="btn sm" style="flex:1" data-act="split-run" ${S.items.length ? '' : 'disabled'} title="Split the load over as few, and as small, trucks as possible">⇶ Split across trucks</button></div>
      </div>
    </div>
    <div class="card">
      <div class="card-h"><div><div class="card-t">Optimization Settings</div><div class="card-d">${o.clearance}cm margin • ${o.direction === 'floor_to_top' ? 'Floor to top' : 'Nose → door (walls)'} • Compatibility ${o.overrideCompat ? 'overridden' : 'applied'}</div></div></div>
      <div class="card-b">
        <div class="field"><label class="lbl">Optimization Preset</label>
          <select data-act-change="preset">${[['standard', 'Standard'], ['tight', 'Tight packing'], ['safety', 'Safety first'], ['custom', 'Custom']].map(([k, n]) => `<option value="${k}" ${o.preset === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="field"><label class="lbl">Loading Direction</label>
          <select data-bind="settings.opt.direction"><option value="nose_to_door" ${o.direction !== 'floor_to_top' ? 'selected' : ''}>Nose → door (wall building)</option><option value="floor_to_top" ${o.direction === 'floor_to_top' ? 'selected' : ''}>Floor to top</option></select>
          <div class="hint">${o.direction === 'floor_to_top' ? 'Covers the whole floor first, then adds the next layer' : 'Builds full-height stacks from the nose towards the door, so the last drop sits deepest'}</div></div>
        <div class="field"><label class="lbl">When weight &amp; volume conflict ${NEW(3)}</label>
          <select data-bind="settings.opt.priority">
            <option value="auto" ${o.priority === 'auto' ? 'selected' : ''}>Auto – follow the binding constraint</option>
            <option value="weight" ${o.priority === 'weight' ? 'selected' : ''}>Weight priority – maximise tonnage</option>
            <option value="volume" ${o.priority === 'volume' ? 'selected' : ''}>Volume priority – maximise cube</option></select>
          <div class="hint">Payload is always a hard limit. When not everything fits, ${o.priority === 'weight' ? 'denser goods are loaded first' : o.priority === 'volume' ? 'bulkier (light) goods are loaded first' : 'the constraint that runs out first (weight for dense loads, volume for light loads) decides what is loaded'}; stacking is always heavy-at-bottom.</div></div>
        <div class="field"><label class="lbl">Open body: use the space above the side walls</label>
          <select data-bind="settings.opt.openTop">${Object.keys(OPEN_MODES).map((k) => `<option value="${k}" ${(o.openTop || 'off') === k ? 'selected' : ''}>${OPEN_MODES[k]}</option>`).join('')}</select>
          <div class="hint">${o.openTop === 'off' ? 'Open trucks are treated like closed ones: nothing rises above the walls.' : o.openTop === 'all' ? 'On open-top trucks, every piece and stack may rise above the walls up to the height limit.' : 'On open-top trucks, only pieces too tall to stand under the walls may rise above them, up to the height limit.'} Default limit ${lenU(packOpts().openTopH)} above the deck (${lenU(S.settings.fleet.roadH)} road height − ${lenU(S.settings.fleet.deckH)} deck). Set it per vehicle in Masters → Fleet.</div></div>
        <div class="field"><label class="lbl">Clearance between items: ${o.clearance} cm</label><input type="range" min="0" max="20" step="1" value="${o.clearance}" data-bind="settings.opt.clearance" data-type="num"></div>
        <div class="field"><label class="lbl">Minimum support under stacked items: ${Math.round(o.supportRatio * 100)}%</label><input type="range" min="0.5" max="1" step="0.05" value="${o.supportRatio}" data-bind="settings.opt.supportRatio" data-type="num"></div>
        <div class="field"><label class="check"><input type="checkbox" data-bind="settings.opt.multiDrop" ${o.multiDrop ? 'checked' : ''}><span>Multi-drop LIFO <span class="muted">– last drop loaded first (at the nose); an item never sits on one for an earlier drop</span></span></label></div>
        <div class="field"><label class="check"><input type="checkbox" data-bind="settings.opt.overrideCompat" ${o.overrideCompat ? 'checked' : ''}><span>Override Compatibility Rules <span class="muted">– bypass category co-loading &amp; stacking checks. Use with caution.</span></span></label></div>
      </div>
    </div>
    <button id="btn-optimize" class="btn primary lg block" data-act="optimize" ${S.items.length ? '' : 'disabled'}>▶ Optimize Loading</button>`;
  }

  function renderVizChrome() {
    const cats = loadPlan ? [...new Set(loadPlan.placed.map((b) => b.u.cat))] : [];
    $('#viz-toolbar').innerHTML = `
      <div class="seg" role="group" aria-label="Colour by">${[['sku', 'SKU'], ['category', 'Category'], ['drop', 'Drop']].map(([k, n]) => `<button data-act="color-mode" data-v="${k}" class="${S.ui.colorMode === k ? 'on' : ''}">${n}</button>`).join('')}</div>
      <div class="seg" role="group" aria-label="Camera">${[['iso', '3D'], ['top', 'Top'], ['side', 'Side'], ['door', 'Door']].map(([k, n]) => `<button data-act="view" data-v="${k}">${n}</button>`).join('')}</div>
      <select class="sel-sm" data-act-change="hl-cat" title="Highlight a product category">${'<option value="">Highlight: all categories</option>' + S.categories.map((c) => `<option value="${c.id}" ${S.ui.hlCat === c.id ? 'selected' : ''} ${cats.includes(c.id) ? '' : 'disabled'}>${esc(c.name)}</option>`).join('')}</select>
      <span style="flex:1"></span>
      <button class="btn xs" data-act="snapshot" ${loadPlan ? '' : 'disabled'}>⤓ PNG</button>`;
    const n = loadPlan ? loadPlan.placed.length : 0;
    $('#viz-steps').innerHTML = loadPlan
      ? `<button class="btn xs" data-act="play">${playTimer ? '❚❚' : '▶'}</button><input type="range" min="0" max="${n}" value="${viz.step == null ? n : Math.min(viz.step, n)}" data-act-input="step" aria-label="Loading step"><span class="small mono nowrap" id="step-lbl">${viz.step == null ? n : Math.min(viz.step, n)} / ${n}</span>`
      : '';
    let leg = '';
    if (loadPlan) {
      if (S.ui.colorMode === 'drop') leg = loadPlan.stats.drops.map((d) => { const b = loadPlan.placed.find((x) => x.u.drop === d); return `<span><i class="dot" style="background:${DROP_COLORS[(d - 1) % DROP_COLORS.length]}"></i>Drop ${d}${b && b.u.dest ? ' · ' + esc(b.u.dest) : ''}</span>`; }).join('');
      else if (S.ui.colorMode === 'category') leg = cats.map((c) => `<span><i class="dot" style="background:${esc((catMap()[c] || {}).color || '#888')}"></i>${esc(catName(c))}</span>`).join('');
      else leg = [...new Set(loadPlan.placed.map((b) => b.u.skuId))].map((id) => { const s = skuMap()[id]; return `<span title="${esc(s.name)}"><i class="dot" style="background:${esc(s.color)}"></i>${esc(s.id)} · ${esc(s.name.length > 28 ? s.name.slice(0, 27) + '…' : s.name)}</span>`; }).join('');
    }
    let legEl = $('#viz-legend');
    if (!legEl) { legEl = document.createElement('div'); legEl.id = 'viz-legend'; legEl.className = 'legend'; $('.viz-card').appendChild(legEl); }
    legEl.innerHTML = leg;
    legEl.classList.toggle('hidden', !leg);
    if (!loadPlan) {
      let e = $('#viz .viz-empty');
      if (!e) { e = document.createElement('div'); e.className = 'viz-empty'; $('#viz').appendChild(e); }
      e.innerHTML = S.items.length ? '<div><div style="font-weight:600;color:var(--fg)">Ready to optimize</div><div>Press “Optimize Loading” to see the 3D load plan.</div></div>' : '<div><div style="font-weight:600;color:var(--fg)">No load plan available</div><div>Add items or load a sample template to start.</div></div>';
    } else { const e = $('#viz .viz-empty'); if (e && viz.ok) e.remove(); }
  }
  function applyHighlight() { if (loadPlan) viz.highlight(S.ui.hlCat ? (b) => b.u.cat === S.ui.hlCat : null); }

  function normsText(s) {
    const parts = [`max ${s.maxStack} layer${s.maxStack > 1 ? 's' : ''}`];
    if (+s.maxTopKg > 0) parts.push(`≤${s.maxTopKg} kg on top`);
    if (+s.maxHeight > 0) parts.push(`≤${lenU(s.maxHeight)} high`);
    if (s.onTop === false) parts.push('floor only');
    if (s.under === false) parts.push('nothing on top');
    if (s.rotate === false) parts.push('no rotation');
    if (s.tip) parts.push('can tip');
    return parts.join(' · ');
  }

  function renderItems() {
    const el = $('#lo-items');
    const sm = skuMap();
    if (!S.items.length) {
      el.innerHTML = `<div class="card"><div class="empty"><div style="font-size:28px">▣</div><h3>Start by adding your items</h3>
        <p>Add items one by one, upload a CSV, or load a sample template to see how the optimizer works</p>
        <div class="row" style="justify-content:center;margin-top:10px"><button class="btn primary" data-act="add-item">＋ Add Item</button><button class="btn" data-act="upload">⇪ Bulk Upload Items</button><button class="btn" data-act="templates">Load Sample Template</button></div></div></div>`;
      return;
    }
    const packedBy = {}, truckBy = {};
    if (fleetPlan) fleetPlan.trucks.forEach((t, ti) => t.res.placed.forEach((b) => { packedBy[b.u.lineId] = (packedBy[b.u.lineId] || 0) + 1; const m = truckBy[b.u.lineId] || (truckBy[b.u.lineId] = {}); m[ti + 1] = (m[ti + 1] || 0) + 1; }));
    else if (loadPlan) loadPlan.placed.forEach((b) => (packedBy[b.u.lineId] = (packedBy[b.u.lineId] || 0) + 1));
    const q = S.ui.search.trim().toLowerCase();
    const rows = S.items.filter((it) => {
      const s = sm[it.skuId];
      if (!s) return true;
      if (S.ui.catFilter && s.cat !== S.ui.catFilter) return false;
      if (!q) return true;
      return [it.id, s.id, s.name, it.dest, catName(s.cat), dims(s), s.wt].join(' ').toLowerCase().includes(q);
    });
    const cats = [...new Set(S.items.map((it) => (sm[it.skuId] || {}).cat).filter(Boolean))];
    const tot = S.items.reduce((a, it) => { const s = sm[it.skuId]; if (s) { a.q += +it.qty; a.w += s.wt * it.qty; a.v += s.l * s.w * s.h * it.qty; } return a; }, { q: 0, w: 0, v: 0 });
    el.innerHTML = `<div class="card">
      <div class="card-h"><div><div class="card-t">Item Inventory <span class="badge">${S.items.length} lines · ${fmt(tot.q)} units · ${fmt(tot.w)} kg · ${fmt(vol(tot.v), 1)} ${volU()}</span></div></div>
        <div class="row"><button class="btn sm primary" data-act="add-item">＋ Add Item</button><button class="btn sm" data-act="upload">⇪ Bulk Upload</button><button class="btn sm" data-act="templates">Load Template</button><button class="btn sm" data-act="export-items">⤓ Export CSV</button><button class="btn sm danger" data-act="clear-items">Clear</button></div></div>
      <div class="card-b">
        <div class="row mb"><input type="search" placeholder="Search items by name, SKU, dimensions, weight, destination..." value="${esc(S.ui.search)}" data-act-input="search" style="flex:1;min-width:200px">
          <div class="chips" aria-label="Filter by product category">${NEW(1)}<button class="chip ${!S.ui.catFilter ? 'on' : ''}" data-act="cat-filter" data-v="">All Categories</button>${S.categories.map((c) => `<button class="chip ${S.ui.catFilter === c.id ? 'on' : ''}" data-act="cat-filter" data-v="${c.id}" ${cats.includes(c.id) ? '' : 'disabled style="opacity:.45"'}><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</button>`).join('')}</div></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>SKU / Item</th><th>Category</th><th>Dimensions (L×W×H)</th><th class="num">Weight/unit</th><th class="num">Qty</th><th class="num">Total (kg)</th><th>Drop</th><th>Stacking norms ${NEW(7)}</th><th>Packed</th><th></th></tr></thead><tbody>
        ${rows.map((it) => {
          const s = sm[it.skuId];
          if (!s) return `<tr><td colspan="10" class="muted">Unknown SKU ${esc(it.skuId)}</td></tr>`;
          const p = packedBy[it.id] || 0;
          const tb = truckBy[it.id];
          const tt = tb ? `<div class="xs muted nowrap">${Object.keys(tb).map((k) => `T${k} ×${tb[k]}`).join(' · ')}</div>` : '';
          const st = (!loadPlan && !fleetPlan) ? '<span class="muted small">—</span>' : (p >= it.qty ? '<span class="badge ok">Packed</span>' : p > 0 ? `<span class="badge warn">${p}/${it.qty}</span>` : '<span class="badge bad">Unpacked</span>') + tt;
          return `<tr><td><div style="font-weight:500">${esc(s.name)}</div><div class="xs muted mono">${esc(s.id)}${s.code ? ' · ' + esc(s.code) : ''}${s.pack ? ' · ' + (s.pack === 'WC' ? 'Wooden case' : s.pack === 'L' ? 'Loose' : esc(s.pack)) : ''}</div></td><td>${catBadge(s.cat)}</td><td class="mono">${dims(s)}</td><td class="num">${fmt(s.wt, 1)}</td>
            <td class="num"><input type="number" min="0" step="1" value="${it.qty}" data-act-change="item-qty" data-id="${esc(it.id)}" style="width:76px;text-align:right"></td><td class="num">${fmt(s.wt * it.qty)}</td>
            <td><span class="badge" style="border-color:${DROP_COLORS[(it.drop - 1) % DROP_COLORS.length]}">${it.drop}${it.dest ? ' · ' + esc(it.dest) : ''}</span></td>
            <td class="small muted">${esc(normsText(s))}</td><td>${st}</td>
            <td class="nowrap"><button class="btn xs ghost" data-act="edit-item" data-id="${esc(it.id)}" title="Edit">✎</button><button class="btn xs ghost danger" data-act="del-item" data-id="${esc(it.id)}" title="Delete">🗑</button></td></tr>`;
        }).join('') || '<tr><td colspan="10" class="empty">No items match your search criteria</td></tr>'}
        </tbody></table></div>
      </div></div>`;
  }

  function itemDialog(id) {
    const it = id ? S.items.find((x) => x.id === id) : { skuId: S.skus[0].id, qty: 10, drop: 1, dest: '' };
    const sm = skuMap();
    const opts = S.categories.map((c) => `<optgroup label="${esc(c.name)}">${S.skus.filter((s) => s.cat === c.id).map((s) => `<option value="${esc(s.id)}" ${s.id === it.skuId ? 'selected' : ''}>${esc(s.id)} – ${esc(s.name)}</option>`).join('')}</optgroup>`).join('');
    openDialog(id ? 'Edit Item' : 'Add New Item', `
      <div class="field"><label class="lbl">SKU *</label><select id="f-sku">${opts}</select><div class="hint" id="f-norms"></div></div>
      <div class="grid3 mt"><div class="field"><label class="lbl">Quantity *</label><input type="number" id="f-qty" min="1" step="1" value="${it.qty}"></div>
      <div class="field" style="margin-top:0"><label class="lbl">Drop # (stop order)</label><input type="number" id="f-drop" min="1" step="1" value="${it.drop}"></div>
      <div class="field" style="margin-top:0"><label class="lbl">Destination (optional)</label><input type="text" id="f-dest" value="${esc(it.dest)}" placeholder="Drop location or zone"></div></div>
      <div class="hint mt">Dimensions, weight, category and stacking norms come from the SKU master (Masters &amp; Rules → SKU stacking norms).</div>`,
      `<button class="btn" data-act="dlg-close">Cancel</button><button class="btn primary" data-act="save-item" data-id="${esc(id || '')}">${id ? 'Update Item' : 'Add Item'}</button>`,
      () => {
        const upd = () => { const s = sm[$('#f-sku').value]; $('#f-norms').innerHTML = s ? `${catBadge(s.cat)} ${dims(s)} · ${fmt(s.wt, 1)} kg · ${esc(normsText(s))}` : ''; };
        $('#f-sku').addEventListener('change', upd); upd();
      });
  }

  function suggestDialog() {
    const cands = S.vehicles.filter((v) => vehicleAllowed(v).ok);
    openDialog('Suggest Vehicle', `<p class="muted small" style="margin-top:0">Finds the smallest vehicle that takes all ${fmt(S.items.reduce((a, b) => a + +b.qty, 0))} units with your current settings${S.custFilterId ? ` and the restrictions of <b>${esc(custMap()[S.custFilterId].name)}</b>` : ''}. If none does, it splits the load across the fewest and smallest trucks from the ticked vehicles.</p>
      <div class="grid2">${S.vehicles.map((v) => { const a = vehicleAllowed(v); return `<label class="check"><input type="checkbox" class="sv-c" value="${v.id}" ${a.ok ? 'checked' : 'disabled'}><span>${esc(v.name)}<span class="xs muted" style="display:block">${a.ok ? `${dims(v)} • ${fmt(v.payload)} kg` : 'Ruled out: ' + esc(a.why)}</span></span></label>`; }).join('')}</div>
      <div id="sv-out" class="mt"></div>`,
      `<button class="btn" data-act="dlg-close">Close</button><button class="btn primary" data-act="sv-run" ${cands.length ? '' : 'disabled'}>Find Vehicle</button>`);
  }
  function runSuggest() {
    const ids = $$('.sv-c').filter((c) => c.checked).map((c) => c.value);
    if (!ids.length) { toast('Select at least one vehicle to consider'); return; }
    $('#sv-out').innerHTML = '<div class="muted">Finding vehicle...</div>';
    setTimeout(() => {
      const res = Packer.suggest(S.vehicles.filter((v) => ids.includes(v.id)), S.items, skuMap(), packOpts());
      let splitHtml = '';
      if (!res.best) {
        const fp = Packer.splitPlan(S.vehicles.filter((v) => ids.includes(v.id)), S.items, skuMap(), packOpts());
        const st = fp.stats;
        splitHtml = `<div class="callout warn mb"><b>No single vehicle takes the whole load.</b> Best split: <b>${st.trucks} truck${st.trucks === 1 ? '' : 's'}</b> – ${fp.trucks.map((t) => esc(t.vehicle.name)).join(' + ')} (${fmt(st.packed)}/${fmt(st.units + st.oversizeUnits)} units, avg ${fmt(st.avgUtil, 0)}% used)${st.oversizeUnits ? `; ${st.oversizeUnits} units fit no selected vehicle` : ''}.
          <div class="mt"><button class="btn sm primary" data-act="use-split" data-v="${esc(ids.join(','))}">Use this multi-truck plan</button></div></div>`;
      }
      $('#sv-out').innerHTML = `${splitHtml}
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Vehicle</th><th class="num">Packed</th><th class="num">Volume</th><th class="num">Weight</th><th></th></tr></thead><tbody>
        ${res.results.map((r) => `<tr><td><b>${esc(r.vehicle.name)}</b> ${res.best && r.vehicle.id === res.best.vehicle.id ? '<span class="badge ok">Best fit</span>' : ''} ${!r.fitsAll ? '<span class="badge bad">Partial</span>' : ''} ${r.vehicle.id === S.selectedVehicleId ? '<span class="badge">Current</span>' : ''}</td>
          <td class="num">${r.stats.packed}/${r.stats.total}</td><td class="num">${fmt(r.stats.volPct, 0)}%</td><td class="num">${fmt(r.stats.wtPct, 0)}%</td><td><button class="btn xs ${res.best && r.vehicle.id === res.best.vehicle.id ? 'primary' : ''}" data-act="use-vehicle" data-id="${r.vehicle.id}">Use this vehicle</button></td></tr>`).join('')}
        </tbody></table></div>`;
    }, 30);
  }

  function templatesDialog() {
    const tpl = window.DEFAULT_DATA.templates;
    openDialog('Load Sample Template', `<div class="stack">${tpl.map((t) => `<div class="card"><div class="card-b row between"><div style="flex:1;min-width:200px"><div style="font-weight:600">${esc(t.name)}</div><div class="small muted">${esc(t.description)}</div><div class="xs muted">${esc(vName(t.vehicleId))} · ${t.items.length} lines</div></div><button class="btn sm primary" data-act="load-template" data-id="${t.id}">Load</button></div></div>`).join('')}</div>`, '');
  }
  function loadTemplate(id, silent) {
    const t = window.DEFAULT_DATA.templates.find((x) => x.id === id);
    if (!t) return;
    exitSplit();
    S.items = t.items.filter((it) => skuMap()[it.skuId]).map((it, i) => Object.assign({ id: 'L' + (i + 1) }, it));
    if (vehMap()[t.vehicleId]) S.selectedVehicleId = t.vehicleId;
    S.custFilterId = '';
    loadContext = 'Template: ' + t.name;
    save();
    closeDialog();
    if (!silent) audit('Loaded template', t.name, `${S.items.length} lines`);
    optimize(true);
  }

  // ---------- CSV ----------
  function parseCSV(text) {
    const rows = [];
    let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim() !== ''));
  }
  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/csv' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const ITEM_COLS = ['sku', 'name', 'length', 'width', 'height', 'weight', 'quantity', 'drop', 'destination', 'category', 'maxStack', 'maxTopLoadKg', 'maxStackHeight', 'stackOnTop', 'stackUnder', 'rotationAllowed'];
  function uploadDialog() {
    openDialog('Bulk Upload Items', `<p class="small muted" style="margin-top:0">Upload a CSV file with item details. If <b>sku</b> matches the SKU master, the row's non-blank values (size, weight, category, norms) update that SKU. Blank cells keep the master's values, except stacking norms when the size or weight changed (a different package gets default norms); otherwise a new SKU is created from the row.</p>
      <div class="field"><input type="file" id="csv-file" accept=".csv,text/csv"></div>
      <div class="field"><label class="check"><input type="checkbox" id="csv-replace" checked><span>Replace current items</span></label></div>
      <div class="hint">Lengths in ${UNIT()} (header toggle), weights in kg. Columns: ${ITEM_COLS.map((c) => `<code>${c}</code>`).join(', ')}. Category accepts: ${S.categories.map((c) => esc(c.name)).join(', ')}.</div>
      <button class="btn sm mt" data-act="csv-template">⤓ Download Template (with sample rows)</button><div id="csv-msg" class="mt small"></div>`,
      `<button class="btn" data-act="dlg-close">Cancel</button><button class="btn primary" data-act="csv-import">Upload</button>`);
  }
  function importCSV() {
    const f = $('#csv-file').files[0];
    if (!f) { $('#csv-msg').textContent = 'Please select a CSV file first'; return; }
    const replace = $('#csv-replace').checked;
    f.text().then((text) => {
      const rows = parseCSV(text);
      if (rows.length < 2) { $('#csv-msg').textContent = 'No data rows found'; return; }
      const head = rows[0].map((h) => h.trim().toLowerCase());
      const col = (r, ...names) => { for (const n of names) { const i = head.indexOf(n.toLowerCase()); if (i >= 0 && r[i] != null && r[i].trim() !== '') return r[i].trim(); } return ''; };
      const bool = (v, d) => (v === '' ? d : /^(true|1|yes|y)$/i.test(v));
      // Unknown or blank categories are created, so every SKU points at a real category.
      const PALETTE = ['#64748b', '#0ea5e9', '#a855f7', '#f97316', '#14b8a6', '#e11d48'];
      const ensureCat = (id, name) => { if (!S.categories.some((x) => x.id === id)) { S.categories.push({ id, name, color: PALETTE[S.categories.length % PALETTE.length] }); newCats.push(name); } return id; };
      const findCat = (v) => {
        if (!v) return ensureCat('general', 'General / unclassified');
        const l = v.toLowerCase();
        const c = S.categories.find((x) => x.id === l || x.name.toLowerCase() === l || x.name.toLowerCase().startsWith(l));
        return c ? c.id : ensureCat(l.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'general', v);
      };
      const items = [], created = [], updated = [], errors = [], newCats = [];
      rows.slice(1).forEach((r, i) => {
        let skuId = col(r, 'sku', 'id', 'item id');
        const name = col(r, 'name');
        const qty = Math.floor(+col(r, 'quantity', 'qty') || 1);
        let s = skuMap()[skuId];
        if (s) {
          // The file is the truth for this shipment: non-blank cells override the master SKU.
          const num = (n) => { const v = col(r, n); return v === '' ? null : +v; };
          const ch = {};
          const L = num('length'), Wd = num('width'), Hh = num('height'), wt = num('weight');
          if (L > 0) ch.l = r1(fromU(L));
          if (Wd > 0) ch.w = r1(fromU(Wd));
          if (Hh > 0) ch.h = r1(fromU(Hh));
          if (wt > 0) ch.wt = wt;
          if (name) ch.name = name;
          if (col(r, 'category')) ch.cat = findCat(col(r, 'category'));
          if (num('maxStack') > 0) ch.maxStack = num('maxStack');
          if (num('maxTopLoadKg') != null) ch.maxTopKg = num('maxTopLoadKg');
          if (num('maxStackHeight') != null) ch.maxHeight = r1(fromU(num('maxStackHeight')));
          if (col(r, 'stackOnTop')) ch.onTop = bool(col(r, 'stackOnTop'), true);
          if (col(r, 'stackUnder')) ch.under = bool(col(r, 'stackUnder'), true);
          if (col(r, 'rotationAllowed')) ch.rotate = bool(col(r, 'rotationAllowed'), true);
          // A different size or weight means a different package: the old SKU's stacking norms don't apply,
          // so they come from the row, else the defaults for a new SKU.
          if (['l', 'w', 'h', 'wt'].some((k) => k in ch && Math.abs(ch[k] - s[k]) > 0.05)) {
            const d = { maxStack: 6, maxTopKg: 0, maxHeight: 0, onTop: true, under: true, rotate: true, tip: false };
            Object.keys(d).forEach((k) => { if (!(k in ch)) ch[k] = d[k]; });
          }
          const diff = Object.keys(ch).filter((k) => String(ch[k]) !== String(s[k]));
          if (diff.length) { diff.forEach((k) => (s[k] = ch[k])); delete s.assumed; updated.push(s.id); }
        }
        if (!s) {
          const l = r1(fromU(+col(r, 'length'))), w = r1(fromU(+col(r, 'width'))), h = r1(fromU(+col(r, 'height'))), wt = +col(r, 'weight');
          if (!(l > 0 && w > 0 && h > 0 && wt > 0)) { errors.push(`Row ${i + 2}: unknown SKU and missing dimensions/weight`); return; }
          skuId = skuId || ('SKU-' + (name || i + 1)).replace(/\s+/g, '-').toUpperCase();
          s = { id: skuId, name: name || skuId, cat: findCat(col(r, 'category')), l, w, h, wt, maxStack: +col(r, 'maxStack') || 6, maxTopKg: +col(r, 'maxTopLoadKg') || 0, maxHeight: r1(fromU(+col(r, 'maxStackHeight') || 0)),
            onTop: bool(col(r, 'stackOnTop'), true), under: bool(col(r, 'stackUnder'), true), rotate: bool(col(r, 'rotationAllowed'), true), tip: false, color: '#' + Math.floor(0x404040 + Math.random() * 0xa0a0a0).toString(16).padStart(6, '0') };
          S.skus.push(s); created.push(s.id);
        }
        items.push({ id: uid('L'), skuId: s.id, qty, drop: Math.max(1, Math.floor(+col(r, 'drop') || 1)), dest: col(r, 'destination') });
      });
      if (replace) S.items = items; else S.items.push(...items);
      markStale(); save();
      const extra = `${created.length ? ` · ${created.length} new SKUs` : ''}${updated.length ? ` · ${updated.length} master SKUs updated from file (${updated.join(', ')})` : ''}${newCats.length ? ` · new categories: ${newCats.join(', ')}` : ''}`;
      audit('Bulk upload', f.name, `${items.length} lines${extra}${errors.length ? `, ${errors.length} errors` : ''}`);
      if (errors.length) { $('#csv-msg').innerHTML = `<div class="callout warn">${items.length} lines imported. ${errors.slice(0, 5).map(esc).join('<br>')}</div>`; renderOptimizer(); return; }
      closeDialog(); toast(`${items.length} lines imported${extra}`);
      loadContext = 'CSV: ' + f.name;
      optimize(true);
    }).catch(() => { $('#csv-msg').textContent = 'Failed to process CSV file'; });
  }
  function exportItems() {
    const sm = skuMap();
    const lines = [ITEM_COLS.join(',')].concat(S.items.map((it) => { const s = sm[it.skuId] || {}; return [s.id, s.name, r1(toU(s.l)), r1(toU(s.w)), r1(toU(s.h)), s.wt, it.qty, it.drop, it.dest, catName(s.cat), s.maxStack, s.maxTopKg, r1(toU(s.maxHeight || 0)), s.onTop !== false, s.under !== false, s.rotate !== false].map(csvCell).join(','); }));
    download(`items-export-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'));
  }

  // =====================================================================
  //  ORDER PLANNING
  // =====================================================================
  function orderStats(o) {
    const sm = skuMap();
    let wt = 0, vol = 0;
    const cats = new Set();
    o.lines.forEach((l) => { const s = sm[l.skuId]; if (s) { wt += s.wt * l.qty; vol += s.l * s.w * s.h * l.qty; cats.add(s.cat); } });
    return { wt, vol, cats: [...cats] };
  }
  // Orders that have not been part of any planning run yet.
  function newSinceLast() { return S.orders.filter((o) => o.status === 'pending' && !o.inPlan).length; }

  function runPlanning(source, reason) {
    const pending = S.orders.filter((o) => o.status === 'pending');
    if (!pending.length) { toast('No pending orders to plan'); return; }
    const btn = $('#btn-plan');
    if (btn) { btn.disabled = true; btn.textContent = 'Planning…'; }
    setTimeout(() => {
      planResult = Planner.plan(S, Object.assign({}, S.settings.plan, { priority: S.settings.opt.priority, openTop: S.settings.opt.openTop, openTopH: packOpts().openTopH }));
      S.sim.lastPlanAt = S.sim.clock;
      S.orders.forEach((o) => { if (o.status === 'pending') o.inPlan = true; });
      const sm = planResult.summary;
      const msg = `${sm.trips} trip${sm.trips === 1 ? '' : 's'} (${sm.owned} owned / ${sm.market} market) · ${fmt(sm.wt)} kg${sm.cost ? ' · ₹' + fmt(sm.cost) : ''}`;
      S.sim.log.unshift({ t: S.sim.clock, msg: (source === 'trigger' ? '⚡ Auto re-plan: ' + reason : '▶ Manual plan') + ' → ' + msg });
      S.sim.log = S.sim.log.slice(0, 40);
      audit(source === 'trigger' ? 'Re-plan triggered' : 'Planning run', `${pending.length} pending orders`, (reason ? reason + ' · ' : '') + msg);
      save();
      if (S.ui.tab === 'planning') renderPlanning();
    }, 30);
  }
  function checkTrigger() {
    const st = Planner.triggerStatus(S.settings.trigger, newSinceLast(), S.sim.clock - S.sim.lastPlanAt);
    if (st.fire) runPlanning('trigger', st.reason);
    return st;
  }
  function addSimOrders(n) {
    const rand = Planner.rng(1000 + S.sim.seq * 7919);
    for (let i = 0; i < n; i++) {
      const o = Planner.makeOrder(S, rand, 'SO-' + (2000 + S.sim.seq), S.sim.clock);
      S.sim.seq++;
      if (o.lines.length) S.orders.push(o);
    }
    S.sim.log.unshift({ t: S.sim.clock, msg: `+${n} order${n > 1 ? 's' : ''} received` });
    save();
    checkTrigger();
    renderPlanning();
  }
  function advanceClock(min) {
    S.sim.clock += min;
    save();
    checkTrigger();
    renderPlanning();
  }
  function toggleAuto() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; renderPlanning(); return; }
    autoTimer = setInterval(() => {
      S.sim.clock += 5;
      const rand = Math.random();
      if (rand < 0.45) {
        const o = Planner.makeOrder(S, Planner.rng(1000 + S.sim.seq * 7919), 'SO-' + (2000 + S.sim.seq), S.sim.clock);
        S.sim.seq++;
        if (o.lines.length) { S.orders.push(o); S.sim.log.unshift({ t: S.sim.clock, msg: `+1 order received (${o.id} · ${custMap()[o.custId].city})` }); }
      }
      save();
      checkTrigger();
      if (S.ui.tab === 'planning') renderPlanning();
    }, 900);
    renderPlanning();
  }

  function profileSvg(seq, prof, km, v) {
    const W = 320, H = 92, pad = 18;
    const total = prof.perLeg.reduce((a, l) => a + l.km, 0) || 1;
    let x = pad;
    const bars = prof.perLeg.map((l, i) => {
      const w = Math.max(2, ((W - pad * 2) * l.km) / total);
      const h = (H - 34) * l.util;
      const cx = x;
      x += w;
      const col = l.util >= 0.6 ? 'var(--ok)' : l.util >= 0.3 ? 'var(--warn)' : 'var(--bad)';
      const to = seq[i] ? seq[i].cust.city : '';
      return `<rect x="${cx + 1}" y="${H - 18 - h}" width="${w - 2}" height="${h}" fill="${col}" opacity=".8"><title>Leg ${i + 1} → ${esc(to)}: ${l.km} km, ${Math.round(l.util * 100)}% on board</title></rect>
        <text x="${cx + w / 2}" y="${H - 22 - h}" font-size="9" text-anchor="middle" fill="currentColor">${Math.round(l.util * 100)}%</text>
        <text x="${cx + w / 2}" y="${H - 6}" font-size="8.5" text-anchor="middle" fill="currentColor" opacity=".7">${esc(to.slice(0, 10))}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Utilisation along route"><line x1="${pad}" x2="${W - pad}" y1="${H - 18}" y2="${H - 18}" stroke="currentColor" opacity=".3"/>${bars}</svg>
      <div class="xs muted">${fmt(km)} km · km-weighted utilisation <b style="color:var(--fg)">${Math.round(prof.tkm * 100)}%</b></div>`;
  }

  function renderPlanning() {
    const p = S.settings.plan, tr = S.settings.trigger;
    const cm = custMap();
    const pending = S.orders.filter((o) => o.status === 'pending');
    const newCnt = newSinceLast();
    const elapsed = S.sim.clock - S.sim.lastPlanAt;
    const st = Planner.triggerStatus(tr, newCnt, elapsed);
    const waiting = [];
    if (!st.countMet) waiting.push(`${tr.count - newCnt} more order${tr.count - newCnt === 1 ? '' : 's'}`);
    if (!st.timeMet) waiting.push(`${tr.interval - elapsed} more min`);
    const r = planResult;
    const el = $('#tab-planning');
    el.innerHTML = `
    <div class="plan-grid mb">
      <div class="card">
        <div class="card-h"><div><div class="card-t">Planning scope &amp; rules</div><div class="card-d">Clubs pending orders into trips per route corridor, then checks every trip with the 3D packer.</div></div></div>
        <div class="card-b">
          <div class="field"><label class="lbl">Product categories to plan ${NEW(1)}</label>
            <div class="chips"><button class="chip ${!p.scope.length ? 'on' : ''}" data-act="scope" data-v="">All</button>${S.categories.map((c) => `<button class="chip ${p.scope.includes(c.id) ? 'on' : ''}" data-act="scope" data-v="${c.id}"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</button>`).join('')}</div>
            <div class="hint">Plan one segment (e.g. only Ash Handling) or several. Lines outside the scope stay pending.</div></div>
          <div class="grid2 mt">
            <div class="field" style="margin:0"><label class="lbl">Category segregation ${NEW(1)}</label><select data-bind="settings.plan.segregation"><option value="mixed" ${p.segregation === 'mixed' ? 'selected' : ''}>Mix in a vehicle (respect compatibility)</option><option value="separate" ${p.segregation === 'separate' ? 'selected' : ''}>Separate vehicle per category</option></select></div>
            <div class="field" style="margin:0"><label class="lbl">Drop sequence on clubbed loads ${NEW(4)}</label><select data-bind="settings.plan.dropPolicy">
              ${[['auto', 'Auto: long haul → largest load last'], ['largest_last', 'Always largest load last'], ['size_strict', 'Strict smallest → largest'], ['route', 'Route order (nearest first)']].map(([k, n]) => `<option value="${k}" ${p.dropPolicy === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
            <div class="field" style="margin:0"><label class="lbl">Long-haul threshold (km)</label><input type="number" min="0" step="50" value="${p.longHaulKm}" data-bind="settings.plan.longHaulKm" data-type="num"></div>
            <div class="field" style="margin:0"><label class="lbl">Max drops per trip</label><input type="number" min="1" max="8" value="${p.maxDrops}" data-bind="settings.plan.maxDrops" data-type="num"></div>
            <div class="field" style="margin:0"><label class="lbl">Max detour for clubbing (%)</label><input type="number" min="0" max="200" step="5" value="${p.maxDetourPct}" data-bind="settings.plan.maxDetourPct" data-type="num"></div>
            <div class="field" style="margin:0"><label class="lbl">Weight vs volume ${NEW(3)}</label><select data-bind="settings.opt.priority">${[['auto', 'Auto (binding constraint)'], ['weight', 'Weight priority'], ['volume', 'Volume priority']].map(([k, n]) => `<option value="${k}" ${S.settings.opt.priority === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
          </div>
          <div class="field mt"><label class="check"><input type="checkbox" data-bind="settings.plan.verify" ${p.verify ? 'checked' : ''}><span>Verify every trip with the 3D packer (stacking norms, LIFO, segregation) and move spill-over to another vehicle</span></label></div>
          <div class="callout mt small">Also applied: customer / region vehicle limits ${NEW(2)} · owned vs market by KM slab ${NEW(6)} · SKU stacking norms ${NEW(7)} — edit them in <a href="#" data-act="goto-masters" data-v="customers">Masters &amp; Rules</a>.</div>
          <div class="row mt"><button id="btn-plan" class="btn primary" data-act="run-plan" ${pending.length ? '' : 'disabled'}>▶ Run planning (${pending.length} pending)</button>
            ${r ? `<button class="btn" data-act="dispatch">✓ Confirm &amp; dispatch plan</button>` : ''}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><div><div class="card-t">Re-plan trigger ${NEW(5)}</div><div class="card-d">Re-run planning on new order volume <b>and</b> elapsed time together – not either alone.</div></div></div>
        <div class="card-b">
          <div class="grid2">
            <div class="field" style="margin:0"><label class="lbl">New orders threshold</label><input type="number" min="1" value="${tr.count}" data-bind="settings.trigger.count" data-type="num"></div>
            <div class="field" style="margin:0"><label class="lbl">Time interval (min)</label><input type="number" min="5" step="5" value="${tr.interval}" data-bind="settings.trigger.interval" data-type="num"></div>
            <div class="field" style="margin:0"><label class="lbl">Logic</label><select data-bind="settings.trigger.logic"><option value="and" ${tr.logic === 'and' ? 'selected' : ''}>Both: count AND time (recommended)</option><option value="or" ${tr.logic === 'or' ? 'selected' : ''}>Either one (legacy)</option></select></div>
            <div class="field" style="margin:0"><label class="lbl">Max wait safety net (min, 0 = off)</label><input type="number" min="0" step="15" value="${tr.maxWait}" data-bind="settings.trigger.maxWait" data-type="num"></div>
          </div>
          <hr class="sep">
          <div class="trig">
            <div><div class="xs muted">Simulated clock</div><div class="clock">${simTime(S.sim.clock)}</div><div class="xs muted">Last plan at ${simTime(S.sim.lastPlanAt)}</div></div>
            <div class="stack" style="font-size:12px">
              <div><div class="row between"><span>New orders (not yet planned)</span><b class="mono">${newCnt} / ${tr.count}</b></div>${pctBar((newCnt / tr.count) * 100)}</div>
              <div><div class="row between"><span>Minutes since last plan</span><b class="mono">${elapsed} / ${tr.interval}</b></div>${pctBar((elapsed / tr.interval) * 100, 'w')}</div>
            </div>
          </div>
          <div class="trig-state mt ${st.fire ? 'fire' : ''}">${st.fire ? '⚡ Trigger condition met: ' + esc(st.reason) : `Waiting for ${tr.logic === 'or' ? 'either: ' : ''}${esc(waiting.join(tr.logic === 'or' ? ' or ' : ' and ')) || 'new orders'}${tr.logic === 'and' && tr.maxWait ? ` · safety net at ${tr.maxWait} min` : ''}`}</div>
          <div class="row mt"><button class="btn sm" data-act="sim-order" data-v="1">＋1 order</button><button class="btn sm" data-act="sim-order" data-v="5">＋5 orders</button><button class="btn sm" data-act="sim-time" data-v="15">＋15 min</button><button class="btn sm" data-act="sim-time" data-v="60">＋60 min</button><button class="btn sm ${autoTimer ? 'accent' : ''}" data-act="sim-auto">${autoTimer ? '❚❚ Stop' : '▶ Auto-run'}</button></div>
          <div class="log mt">${S.sim.log.length ? S.sim.log.map((l) => `<div><span class="mono muted">${simTime(l.t)}</span> ${esc(l.msg)}</div>`).join('') : '<span class="muted">Add orders or advance the clock to see the trigger fire.</span>'}</div>
        </div>
      </div>
    </div>

    ${r ? renderPlanResult(r) : ''}

    <div class="card">
      <div class="card-h"><div class="card-t">Orders <span class="badge">${pending.length} pending</span> <span class="badge">${S.orders.filter((o) => o.status === 'dispatched').length} dispatched</span></div>
        <div class="row"><button class="btn sm primary" data-act="add-order">＋ Add Order</button><button class="btn sm" data-act="sample-orders">Reload case orders</button><button class="btn sm danger" data-act="clear-orders">Clear</button></div></div>
      <div class="card-b"><div class="tbl-wrap scroll-y"><table class="tbl"><thead><tr><th>Order</th><th>Customer</th><th>Corridor</th><th>Categories</th><th class="num">kg</th><th class="num">${volU()}</th><th>Vehicle limit ${NEW(2)}</th><th>Received</th><th>Status</th><th></th></tr></thead><tbody>
      ${S.orders.length ? S.orders.slice().reverse().map((o) => {
        const c = cm[o.custId] || { name: o.custId };
        const os = orderStats(o);
        const lim = cm[o.custId] ? Planner.effectiveMaxVehicle(c, S) : null;
        const trip = r && r.trips.find((t) => t.orderIds.includes(o.id));
        return `<tr><td><div class="mono">${esc(o.id)}</div>${o.ref ? `<div class="xs muted">${esc(o.ref)}</div>` : ''}</td><td><div>${esc(c.name)}</div><div class="xs muted">${esc(c.city || '')} · ${esc(c.region || '')}</div></td><td class="small">${esc(c.corridor || '')}</td>
          <td><div class="chips">${os.cats.map((x) => `<span class="dot" title="${esc(catName(x))}" style="background:${esc((catMap()[x] || {}).color)}"></span>`).join('')}</div></td>
          <td class="num">${fmt(os.wt)}</td><td class="num">${fmt(vol(os.vol), 1)}</td><td class="small">${lim ? `<span class="badge warn" title="${esc(lim.source)}">≤ ${esc(vName(lim.id))}</span>` : '<span class="muted">Any</span>'}</td>
          <td class="mono small">${simTime(o.createdAt)}</td><td>${o.status === 'dispatched' ? '<span class="badge ok">Dispatched</span>' : trip ? `<span class="badge acc">${trip.id}</span>` : '<span class="badge">Pending</span>'}</td>
          <td>${o.status === 'pending' ? `<button class="btn xs ghost danger" data-act="del-order" data-id="${esc(o.id)}" title="Delete">🗑</button>` : ''}</td></tr>`;
      }).join('') : '<tr><td colspan="10" class="empty">No orders yet – reload the case orders or add one.</td></tr>'}
      </tbody></table></div></div>
    </div>`;
  }

  function renderPlanResult(r) {
    const sm = r.summary;
    const exp = S.ui.planExpanded;
    return `<div class="tiles mb">
      <div class="tile"><div class="k">Trips</div><div class="v">${sm.trips}</div><div class="xs muted">${sm.orders} orders · ${fmt(sm.ms)} ms</div></div>
      <div class="tile"><div class="k">Owned / Market ${NEW(6)}</div><div class="v"><span style="color:var(--owned)">${sm.owned}</span> / <span style="color:var(--market)">${sm.market}</span></div><div class="xs muted">by KM slab policy</div></div>
      <div class="tile"><div class="k">Freight cost</div>${sm.cost ? `<div class="v">₹${fmt(sm.cost)}</div><div class="xs muted">₹${fmt(sm.wt ? sm.cost / sm.wt : 0, 2)} / kg</div>` : '<div class="v">—</div><div class="xs muted">set ₹/km rates in Masters → Fleet</div>'}</div>
      <div class="tile"><div class="k">Avg utilisation</div><div class="v">${fmt(sm.avgUtil, 0)}%</div><div class="xs muted">max(weight, volume)</div></div>
      <div class="tile"><div class="k">Tonnage</div><div class="v">${fmt(sm.wt / 1000, 1)} t</div><div class="xs muted">${r.outOfScope.length ? r.outOfScope.length + ' orders out of scope' : 'all pending in scope'}</div></div>
    </div>
    <div class="card mb"><div class="card-h"><div class="card-t">Trip plan</div><div class="card-d">Click a trip for route utilisation, fleet decision and flags. “3D” opens it in the Load Optimizer.</div></div>
    <div class="card-b"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Trip</th><th>Corridor</th><th>Vehicle</th><th>Fleet</th><th>Drop sequence (kg)</th><th class="num">km</th><th>Weight</th><th>Volume</th><th>Binding</th><th class="num">Cost ₹</th><th></th></tr></thead><tbody>
    ${r.trips.map((t) => {
      const bind = t.binding || (t.wtPct >= t.volPct ? 'Weight' : 'Volume');
      const open = exp === t.id;
      return `<tr data-act="expand-trip" data-id="${t.id}" style="cursor:pointer">
        <td><b>${t.id}</b> ${t.flags.length ? `<span class="badge warn" title="${esc(t.flags.join('\n'))}">⚑ ${t.flags.length}</span>` : ''}</td>
        <td class="small">${esc(t.corridor)}</td>
        <td class="nowrap">${esc(t.vehicle.name)}</td>
        <td><span class="badge ${t.fleet}" title="${esc(t.fleetReason)}">${t.fleet === 'owned' ? 'Owned' : 'Market'}</span></td>
        <td><div class="drops">${t.seq.order.map((pc, i) => `${i ? '<span class="arrow">→</span>' : ''}<span class="drop" title="${esc(pc.cust.name)}">${i + 1}. ${esc(pc.cust.city)} <b>${fmt(pc.wt)}</b></span>`).join('')}</div>
          <div class="xs muted">${esc(t.seq.label)}${t.seq.longHaul ? ' · long haul' : ''}</div></td>
        <td class="num">${fmt(t.seq.km)}</td>
        <td class="nowrap"><span class="minibar">${pctBar(t.wtPct, 'w')}</span>${fmt(t.wtPct, 0)}%</td>
        <td class="nowrap"><span class="minibar">${pctBar(t.volPct)}</span>${fmt(t.volPct, 0)}%</td>
        <td><span class="badge">${bind}</span></td>
        <td class="num">${t.cost ? fmt(t.cost) : '—'}</td>
        <td><button class="btn xs" data-act="trip-3d" data-id="${t.id}">3D</button></td></tr>
        ${open ? `<tr class="expand"><td colspan="11">${tripDetail(t)}</td></tr>` : ''}`;
    }).join('')}
    </tbody></table></div>
    ${r.failed.length ? `<div class="callout warn mt">${r.failed.length} consignments could not be planned: ${r.failed.map((f) => esc(f.flags.join('; '))).join(' | ')}</div>` : ''}
    </div></div>`;
  }

  function tripDetail(t) {
    const gain = Math.round((t.seq.profile.tkm - t.seq.alt.profile.tkm) * 100);
    const multi = t.seq.order.length > 1;
    return `<div class="prof" style="padding:6px 2px">
      <div><h4>Utilisation along the route – chosen: ${esc(t.seq.label)} ${NEW(4)}</h4>${profileSvg(t.seq.order, t.seq.profile, t.seq.km, t.vehicle)}
        ${multi ? `<div class="small" style="margin-top:6px">${gain > 0 ? `<b style="color:var(--ok)">+${gain} pts</b> utilisation vs unloading the largest load first` : gain < 0 ? `<b style="color:var(--warn)">${gain} pts</b> vs largest-first (route order chosen for a short haul)` : 'Same as largest-first'} · ${t.seq.km === t.seq.alt.km ? 'same distance' : fmt(Math.abs(t.seq.km - t.seq.alt.km)) + ' km ' + (t.seq.km < t.seq.alt.km ? 'shorter' : 'longer')}</div>` : ''}</div>
      <div>${multi ? `<h4>For comparison – ${esc(t.seq.alt.label)}</h4>${profileSvg([...t.seq.order].sort((a, b) => Math.max(b.wt / t.vehicle.payload, b.vol / Planner.vVol(t.vehicle)) - Math.max(a.wt / t.vehicle.payload, a.vol / Planner.vVol(t.vehicle))), t.seq.alt.profile, t.seq.alt.km, t.vehicle)}` : '<h4>Single drop</h4><div class="small muted">No clubbing on this trip.</div>'}</div>
      <div><h4>Fleet decision ${NEW(6)}</h4><div class="small">${esc(t.fleetReason)}</div><div class="xs muted">${esc(t.costNote)}</div>
        <h4 style="margin-top:10px">Categories</h4><div class="chips">${t.cats.map(catBadge).join('')}</div></div>
      <div><h4>Constraints &amp; flags</h4>${t.flags.length ? `<ul class="flags">${t.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '<div class="small muted">No exceptions on this trip.</div>'}
        ${t.packStats ? `<div class="xs muted" style="margin-top:6px">3D check: ${t.packStats.packed}/${t.packStats.total} units placed · floor ${fmt(t.packStats.floorPct, 0)}%</div>` : ''}</div>
    </div>`;
  }

  function orderDialog() {
    const rows = [0, 1, 2].map(() => `<div class="grid2 ord-line" style="grid-template-columns:3fr 1fr;margin-top:6px"><select class="ol-sku"><option value="">— SKU —</option>${S.skus.map((s) => `<option value="${esc(s.id)}">${esc(s.id)} – ${esc(s.name)}</option>`).join('')}</select><input type="number" class="ol-qty" min="1" placeholder="Qty"></div>`).join('');
    openDialog('Add Order', `<div class="field"><label class="lbl">Customer</label><select id="o-cust">${S.customers.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} · ${esc(c.city)}</option>`).join('')}</select><div class="hint" id="o-lim"></div></div>
      <label class="lbl mt">Lines</label><div id="o-lines">${rows}</div>`,
      `<button class="btn" data-act="dlg-close">Cancel</button><button class="btn primary" data-act="save-order">Add Order</button>`,
      () => {
        const upd = () => { const c = custMap()[$('#o-cust').value]; const l = c && Planner.effectiveMaxVehicle(c, S); $('#o-lim').textContent = l ? `Vehicle limit: ${vName(l.id)} or smaller (${l.source})` : 'No vehicle restriction'; };
        $('#o-cust').addEventListener('change', upd); upd();
      });
  }

  // =====================================================================
  //  LOAD SEQUENCE
  // =====================================================================
  function renderSequence() {
    const el = $('#tab-sequence');
    if (!loadPlan || !loadPlan.placed.length) {
      el.innerHTML = `<div class="card"><div class="empty"><div style="font-size:28px">↹</div><h3>No Load Plan Available</h3><p>Please optimize a load plan first by adding items and running the optimizer in the “Load Optimizer” tab.</p></div></div>`;
      return;
    }
    const P = loadPlan.placed, v = loadPlan.vehicle;
    // group consecutive placements of the same SKU & drop into steps
    const steps = [];
    P.forEach((b, i) => {
      const last = steps[steps.length - 1];
      if (last && last.sku === b.u.skuId && last.drop === b.u.drop) { last.n++; last.end = i + 1; last.x0 = Math.min(last.x0, b.x); last.x1 = Math.max(last.x1, b.x + b.l); last.l0 = Math.min(last.l0, b.layer); last.l1 = Math.max(last.l1, b.layer); last.wt += b.u.wt; }
      else steps.push({ sku: b.u.skuId, name: b.u.name, drop: b.u.drop, dest: b.u.dest, n: 1, start: i + 1, end: i + 1, x0: b.x, x1: b.x + b.l, l0: b.layer, l1: b.layer, wt: b.u.wt, cat: b.u.cat });
    });
    // LIFO check: a box for a later drop sitting between the door and an earlier-drop box
    let blocking = 0;
    if (loadPlan.stats.drops.length > 1) {
      P.forEach((a) => {
        if (P.some((b) => b.u.drop > a.u.drop && b.x >= a.x + a.l - 0.5 && b.y < a.y + a.w && a.y < b.y + b.w && b.z < a.z + a.h && a.z < b.z + b.h)) blocking++;
      });
    }
    const drops = loadPlan.stats.drops;
    const byDrop = drops.map((d) => { const bs = P.filter((b) => b.u.drop === d); return { d, n: bs.length, wt: bs.reduce((a, b) => a + b.u.wt, 0), dest: (bs[0] || {}).u ? bs[0].u.dest : '', x0: Math.min(...bs.map((b) => b.x)), x1: Math.max(...bs.map((b) => b.x + b.l)) }; });
    let onboard = byDrop.reduce((a, b) => a + b.wt, 0);
    el.innerHTML = `<div class="plan-grid">
      <div class="card"><div class="card-h"><div><div class="card-t">Loading sequence <span class="badge">${steps.length} steps · ${P.length} units</span></div><div class="card-d">${fleetPlan ? esc(truckLabel()) + ' · ' : ''}${esc(v.name)}${loadContext ? ' · ' + esc(loadContext) : ''} — load in this order, starting at the nose.</div>
          ${fleetPlan && fleetPlan.trucks.length > 1 ? `<div class="chips mt">${fleetPlan.trucks.map((t, i) => `<button class="chip ${i === S.ui.truck ? 'on' : ''}" data-act="pick-truck" data-v="${i}">T${i + 1} · ${esc(t.vehicle.name)}</button>`).join('')}</div>` : ''}</div>
        <div class="row"><button class="btn sm" data-act="export-sheet">⤓ Loading sheet CSV</button><button class="btn sm" data-act="print">Print</button></div></div>
        <div class="card-b scroll-y" style="max-height:640px"><ol class="steps">${steps.map((s, i) => `<li><span class="n">${i + 1}</span><div><div><b>Load ${s.n} × ${esc(s.name)}</b> <span class="xs muted mono">${esc(s.sku)}</span></div>
          <div class="xs muted">Drop ${s.drop}${s.dest ? ' · ' + esc(s.dest) : ''} · ${fmtL(s.x0)}–${fmtL(s.x1)} ${UNIT()} from nose · layer${s.l0 !== s.l1 ? 's' : ''} ${s.l0}${s.l0 !== s.l1 ? '–' + s.l1 : ''} · ${fmt(s.wt)} kg</div></div>
          <button class="btn xs" data-act="show-step" data-v="${s.end}">Show in 3D</button></li>`).join('')}</ol></div></div>
      <div class="stack">
        <div class="card"><div class="card-h"><div class="card-t">Unloading plan by stop ${NEW(4)}</div></div><div class="card-b">
          ${drops.length > 1 ? `<div class="${blocking ? 'callout warn' : 'callout'} mb">${blocking ? `LIFO check: ${blocking} units are blocked by goods for a later drop.` : 'LIFO check passed: every drop is reachable from the door without moving goods for later drops.'}</div>` : ''}
          <table class="tbl"><thead><tr><th>Stop</th><th>Destination</th><th class="num">Units</th><th class="num">Unload kg</th><th>Zone from nose</th><th>On board after</th></tr></thead><tbody>
          ${byDrop.map((d) => { onboard -= d.wt; const pct = (onboard / v.payload) * 100; return `<tr><td><span class="badge" style="border-color:${DROP_COLORS[(d.d - 1) % DROP_COLORS.length]}">${d.d}</span></td><td>${esc(d.dest || '—')}</td><td class="num">${d.n}</td><td class="num">${fmt(d.wt)}</td><td class="small mono">${fmtL(d.x0)}–${fmtL(d.x1)} ${UNIT()}</td><td class="nowrap"><span class="minibar">${pctBar(pct, 'w')}</span>${fmt(pct, 0)}%</td></tr>`; }).join('')}
          </tbody></table>
          ${drops.length > 1 ? `<div class="hint">The vehicle stays well utilised for longer when the largest load is the last drop – see Order Planning for the km-weighted comparison.</div>` : ''}
        </div></div>
        <div class="card"><div class="card-h"><div class="card-t">Stacking norm check ${NEW(7)}</div></div><div class="card-b">${stackCheck()}</div></div>
      </div></div>`;
  }
  function stackCheck() {
    const by = {};
    loadPlan.placed.forEach((b) => {
      const k = b.u.skuId;
      const r = by[k] || (by[k] = { s: b.u, n: 0, maxLayer: 0, maxAbove: 0, maxLoad: 0, maxTop: 0 });
      r.n++; r.maxLayer = Math.max(r.maxLayer, b.layer); r.maxAbove = Math.max(r.maxAbove, b.above); r.maxLoad = Math.max(r.maxLoad, b.load); r.maxTop = Math.max(r.maxTop, b.z + b.h);
    });
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>SKU</th><th class="num">Units</th><th class="num">Items above (max)</th><th class="num">Load on top (max)</th><th class="num">Top height</th></tr></thead><tbody>
      ${Object.values(by).map((r) => `<tr><td><div>${esc(r.s.skuId)} · ${esc(r.s.name)}</div><div class="xs muted">${esc(normsText(Object.assign({}, r.s, { maxTopKg: Number.isFinite(r.s.maxTopKg) ? r.s.maxTopKg : 0, maxHeight: Number.isFinite(r.s.maxHeight) ? r.s.maxHeight : 0 })))}</div></td><td class="num">${r.n}</td>
        <td class="num">${r.maxAbove} <span class="muted">/ ${r.s.maxStack - 1}</span></td><td class="num">${fmt(r.maxLoad, 0)}${Number.isFinite(r.s.maxTopKg) ? ` <span class="muted">/ ${fmt(r.s.maxTopKg)}</span>` : ''} kg</td><td class="num">${fmtL(r.maxTop)}${Number.isFinite(r.s.maxHeight) ? ` <span class="muted">/ ${fmtL(r.s.maxHeight)}</span>` : ''} ${UNIT()}</td></tr>`).join('')}
    </tbody></table></div>`;
  }
  function exportSheet() {
    const rows = [['truck', 'vehicle', 'step', 'sku', 'name', 'category', 'drop', 'destination', 'x_cm', 'y_cm', 'z_cm', 'l_cm', 'w_cm', 'h_cm', 'weight_kg', 'layer', 'above_walls']];
    const plans = fleetPlan ? fleetPlan.trucks.map((t) => t.res) : [loadPlan];
    plans.forEach((pl, ti) => pl.placed.forEach((b) => rows.push([ti + 1, pl.vehicle.name, b.seq, b.u.skuId, b.u.name, catName(b.u.cat), b.u.drop, b.u.dest, Math.round(b.x), Math.round(b.y), Math.round(b.z), b.l, b.w, b.h, b.u.wt, b.layer, b.overWall ? 'yes' : ''])));
    download(fleetPlan ? `loading-sheet-${plans.length}-trucks.csv` : `loading-sheet-${loadPlan.vehicle.id}.csv`, rows.map((r) => r.map(csvCell).join(',')).join('\n'));
  }

  // =====================================================================
  //  CATEGORIES & COMPATIBILITY
  // =====================================================================
  function renderCompat() {
    const cats = S.categories;
    const inLoad = [...new Set(S.items.map((it) => (skuMap()[it.skuId] || {}).cat).filter(Boolean))];
    const issues = [];
    for (let i = 0; i < inLoad.length; i++) for (let j = i + 1; j < inLoad.length; j++) { const c = Packer.compatOf(S.compat, inLoad[i], inLoad[j]); if (c !== 'ok') issues.push({ a: inLoad[i], b: inLoad[j], c }); }
    const lbl = { ok: 'Safe to transport together', seg: 'Together, but never stacked on each other', no: 'Should not be transported together' };
    $('#tab-compat').innerHTML = `<div class="plan-grid">
      <div class="card"><div class="card-h"><div><div class="card-t">Product categories ${NEW(1)}</div><div class="card-d">Tag every SKU with a category; planning can then filter, segregate and apply category-specific stacking rules.</div></div><button class="btn sm" data-act="add-cat">＋ Category</button></div>
        <div class="card-b"><table class="tbl"><thead><tr><th>Colour</th><th>Name</th><th>ID</th><th class="num">SKUs</th><th class="num">In current load</th><th></th></tr></thead><tbody>
        ${cats.map((c, i) => { const n = S.skus.filter((s) => s.cat === c.id).length; return `<tr><td><input type="color" value="${esc(c.color)}" data-bind="categories.${i}.color" style="width:36px;height:26px;border:0;background:none;padding:0"></td><td><input type="text" value="${esc(c.name)}" data-bind="categories.${i}.name"></td><td class="mono small">${esc(c.id)}</td><td class="num">${n}</td><td class="num">${inLoad.includes(c.id) ? '✓' : ''}</td><td>${n ? '' : `<button class="btn xs ghost danger" data-act="del-cat" data-id="${esc(c.id)}">🗑</button>`}</td></tr>`; }).join('')}
        </tbody></table></div></div>
      <div class="card"><div class="card-h"><div><div class="card-t">Current Load Analysis</div><div class="card-d">Categories in load: ${inLoad.length ? inLoad.map(catBadge).join(' ') : '<span class="muted">none</span>'}</div></div></div>
        <div class="card-b">${!inLoad.length ? '<div class="muted">Add items to see compatibility issues.</div>' : issues.length ? `<div class="callout warn mb">Compatibility Issues (${issues.length})</div><ul class="flags">${issues.map((x) => `<li><b>${esc(catName(x.a))}</b> + <b>${esc(catName(x.b))}</b>: ${lbl[x.c]}${x.c === 'no' && !S.settings.opt.overrideCompat ? ' – the lighter category is left out of the vehicle' : ''}</li>`).join('')}</ul>` : '<div class="callout">All categories in your load are compatible.</div>'}
        <div class="hint mt">Rules are ${S.settings.opt.overrideCompat ? '<b>overridden</b>' : 'applied'} in Optimization Settings.</div></div></div>
    </div>
    <div class="card mt"><div class="card-h"><div><div class="card-t">Item Compatibility Matrix ${NEW(1)} ${NEW(7)}</div><div class="card-d">Shows whether two categories may share a vehicle, and whether they may be stacked on each other (category-specific stacking rule). The packing list states no restrictions, so all pairs start as OK.</div></div></div>
      <div class="card-b"><div class="tbl-wrap"><table class="tbl matrix"><thead><tr><th></th>${cats.map((c) => `<th><span class="dot" style="background:${esc(c.color)}"></span> ${esc(c.name)}</th>`).join('')}</tr></thead><tbody>
      ${cats.map((a) => `<tr><th class="rowh"><span class="dot" style="background:${esc(a.color)}"></span> ${esc(a.name)}</th>${cats.map((b) => {
        if (a.id === b.id) return '<td class="mx-ok small muted">SAME</td>';
        const v = Packer.compatOf(S.compat, a.id, b.id);
        return `<td class="mx-${v}"><select data-act-change="compat" data-a="${a.id}" data-b="${b.id}" aria-label="${esc(a.name)} with ${esc(b.name)}"><option value="ok" ${v === 'ok' ? 'selected' : ''}>✓ OK</option><option value="seg" ${v === 'seg' ? 'selected' : ''}>⚠ No stacking</option><option value="no" ${v === 'no' ? 'selected' : ''}>✕ Not together</option></select></td>`;
      }).join('')}</tr>`).join('')}
      </tbody></table></div>
      <div class="legend" style="border:0;padding:8px 0 0"><span><span class="dot" style="background:var(--ok)"></span>OK – load and stack together</span><span><span class="dot" style="background:var(--warn)"></span>No stacking – same vehicle, never stacked on each other</span><span><span class="dot" style="background:var(--bad)"></span>Not together – separate vehicles</span></div></div></div>`;
  }

  // =====================================================================
  //  MASTERS & RULES
  // =====================================================================
  function renderMasters() {
    const t = S.ui.mtab;
    $('#tab-masters').innerHTML = `<div class="subtabs">${[['skus', 'SKU stacking norms'], ['customers', 'Customers & exceptions'], ['fleet', 'Fleet & KM slabs']].map(([k, n]) => `<button class="${t === k ? 'active' : ''}" data-act="mtab" data-v="${k}">${n}</button>`).join('')}</div><div id="mbody"></div>`;
    if (t === 'skus') renderSkus(); else if (t === 'customers') renderCustomers(); else renderFleet();
  }
  const vOpts = (sel, blank) => (blank ? `<option value="">${blank}</option>` : '') + S.vehicles.map((v) => `<option value="${v.id}" ${v.id === sel ? 'selected' : ''}>${esc(v.name)}</option>`).join('');

  function renderSkus() {
    $('#mbody').innerHTML = `<div class="card"><div class="card-h"><div><div class="card-t">SKU master – stacking norms ${NEW(7)}</div><div class="card-d">One SKU per package from the sample packing list. Sizes &amp; gross weights are from the list; <b>stacking norms are not in the list and are assumed</b> – wooden cases stack 2 high and carry up to their own weight, loose items take nothing on top, anything ≥ 500 kg stays on the floor. Please confirm or edit. Lengths in ${UNIT()}.</div></div>
      <div class="row"><button class="btn sm primary" data-act="add-sku">＋ SKU</button><button class="btn sm" data-act="export-skus">⤓ Export CSV</button></div></div>
      <div class="card-b"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Pkg</th><th>Item code</th><th>Type</th><th>Description</th><th>Category ${NEW(1)}</th><th>L (${UNIT()})</th><th>W</th><th>H</th><th>Gross kg</th><th title="Max layers of this SKU in a column (items allowed on top = layers − 1)">Max layers</th><th title="Max kg that may rest on one unit (0 = no limit)">Max kg on top</th><th title="Top of the unit may not exceed this height from the floor (0 = no limit)">Max stack ht (${UNIT()})</th><th title="May sit on top of other items">On top</th><th title="Other items may be placed on it">Takes load</th><th title="May be turned 90° on the floor">Rotate</th><th title="May be laid on its side">Tip</th><th>Colour</th><th></th></tr></thead><tbody>
      ${S.skus.map((s, i) => `<tr><td class="mono small">${esc(s.id)}</td><td><input type="text" class="w-md" value="${esc(s.code || '')}" data-bind="skus.${i}.code"></td>
        <td><select class="w-sm" data-bind="skus.${i}.pack" title="WC = wooden case, L = loose"><option value="WC" ${s.pack === 'WC' ? 'selected' : ''}>WC</option><option value="L" ${s.pack === 'L' ? 'selected' : ''}>L</option><option value="" ${!s.pack ? 'selected' : ''}>–</option></select></td>
        <td><input type="text" class="w-lg" value="${esc(s.name)}" data-bind="skus.${i}.name"></td>
        <td><select class="w-md" data-bind="skus.${i}.cat">${S.categories.map((c) => `<option value="${c.id}" ${c.id === s.cat ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></td>
        ${['l', 'w', 'h', 'wt', 'maxStack', 'maxTopKg', 'maxHeight'].map((f) => { const len = ['l', 'w', 'h', 'maxHeight'].includes(f); return `<td><input type="number" class="w-sm" min="0" step="${len ? '0.1' : f === 'wt' ? '0.1' : '1'}" value="${len ? r1(toU(s[f])) : s[f]}" data-bind="skus.${i}.${f}" data-type="${len ? 'len' : 'num'}"></td>`; }).join('')}
        ${['onTop', 'under', 'rotate', 'tip'].map((f) => `<td style="text-align:center"><input type="checkbox" ${s[f] !== false && (f !== 'tip' || s.tip) ? 'checked' : ''} data-bind="skus.${i}.${f}"></td>`).join('')}
        <td><input type="color" value="${esc(s.color)}" data-bind="skus.${i}.color" style="width:32px;height:24px;border:0;background:none;padding:0"></td>
        <td><button class="btn xs ghost danger" data-act="del-sku" data-id="${esc(s.id)}" title="Delete">🗑</button></td></tr>`).join('')}
      </tbody></table></div></div></div>`;
  }

  function renderCustomers() {
    const vm = vehMap();
    $('#mbody').innerHTML = `<div class="card mb"><div class="card-h"><div><div class="card-t">Region rules ${NEW(2)}</div><div class="card-d">Default vehicle limit for every customer in a region (e.g. a hilly region where large vehicles can't ply). Planning then splits loads into several smaller vehicles instead of defaulting to the largest truck. None set for this case.</div></div><button class="btn sm" data-act="add-region">＋ Region rule</button></div>
      <div class="card-b"><table class="tbl"><thead><tr><th>Region</th><th>Largest vehicle allowed</th><th>Reason</th><th class="num">Customers</th><th></th></tr></thead><tbody>
      ${S.regionRules.map((r, i) => `<tr><td><input type="text" class="w-lg" value="${esc(r.region)}" data-bind="regionRules.${i}.region" list="regions"></td><td><select data-bind="regionRules.${i}.maxVehicleId">${vOpts(r.maxVehicleId, 'No limit')}</select></td><td><input type="text" value="${esc(r.note || '')}" data-bind="regionRules.${i}.note"></td><td class="num">${S.customers.filter((c) => c.region === r.region).length}</td><td><button class="btn xs ghost danger" data-act="del-region" data-i="${i}">🗑</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No region rules.</td></tr>'}
      </tbody></table></div></div>
      <div class="card"><div class="card-h"><div><div class="card-t">Customers – customer-level exceptions ${NEW(2)}</div><div class="card-d">A customer-level limit overrides the region rule (e.g. a plant gate or site road that only takes up to a 24 ft truck).</div></div><button class="btn sm primary" data-act="add-customer">＋ Customer</button></div>
      <div class="card-b"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>ID</th><th>Name</th><th>City</th><th>Region</th><th>Route corridor</th><th>Vehicle limit (override)</th><th>Effective limit</th><th class="num">km from DC</th><th>Note</th><th></th></tr></thead><tbody>
      ${S.customers.map((c, i) => { const lim = Planner.effectiveMaxVehicle(c, S); return `<tr><td class="mono small">${esc(c.id)}</td><td><input type="text" class="w-lg" value="${esc(c.name)}" data-bind="customers.${i}.name"></td><td><input type="text" class="w-md" value="${esc(c.city)}" data-bind="customers.${i}.city"></td>
        <td><input type="text" class="w-md" value="${esc(c.region)}" data-bind="customers.${i}.region" list="regions"></td><td><input type="text" class="w-lg" value="${esc(c.corridor)}" data-bind="customers.${i}.corridor" list="corridors"></td>
        <td><select data-bind="customers.${i}.maxVehicleId">${vOpts(c.maxVehicleId, '— Inherit region rule —')}</select></td>
        <td class="small">${lim ? `<span class="badge warn">≤ ${esc((vm[lim.id] || {}).name || lim.id)}</span><div class="xs muted">${esc(lim.source)}</div>` : '<span class="muted">Any vehicle</span>'}</td>
        <td class="num">${fmt(Planner.roadKm(S.dc, c))}</td><td><input type="text" value="${esc(c.note || '')}" data-bind="customers.${i}.note"></td>
        <td><button class="btn xs ghost danger" data-act="del-customer" data-id="${esc(c.id)}">🗑</button></td></tr>`; }).join('')}
      </tbody></table></div>
      <datalist id="regions">${[...new Set(S.customers.map((c) => c.region).concat(S.regionRules.map((r) => r.region)))].map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
      <datalist id="corridors">${[...new Set(S.customers.map((c) => c.corridor))].map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
      <div class="hint">Distances are road estimates from ${esc(S.dc.name)} (straight line × 1.3). Customers on the same corridor can be clubbed into one trip.</div></div></div>`;
  }

  function slabIssues() {
    const s = S.slabs.slice().sort((a, b) => a.from - b.from);
    const out = [];
    if (!s.length) return ['No slabs defined – all trips default to owned-first.'];
    if (s[0].from > 0) out.push(`No slab covers 0–${s[0].from} km`);
    for (let i = 1; i < s.length; i++) { if (s[i].from > s[i - 1].to) out.push(`Gap ${s[i - 1].to}–${s[i].from} km`); if (s[i].from < s[i - 1].to) out.push(`Overlap at ${s[i].from}–${s[i - 1].to} km`); }
    return out;
  }
  function renderFleet() {
    const issues = slabIssues();
    $('#mbody').innerHTML = `<div class="card mb"><div class="card-h"><div><div class="card-t">Owned vs market – KM slabs ${NEW(6)}</div><div class="card-d">Long-haul trips go to market (hired) vehicles; shorter trips use the owned fleet first. If no owned vehicle of the right size is free, the trip falls back to market.</div></div><button class="btn sm" data-act="add-slab">＋ Slab</button></div>
      <div class="card-b"><table class="tbl"><thead><tr><th>From km</th><th>To km</th><th>Fleet priority</th><th></th></tr></thead><tbody>
      ${S.slabs.map((s, i) => `<tr><td><input type="number" min="0" value="${s.from}" data-bind="slabs.${i}.from" data-type="num"></td><td><input type="number" min="0" value="${s.to}" data-bind="slabs.${i}.to" data-type="num"> ${s.to >= 99999 ? '<span class="xs muted">(∞)</span>' : ''}</td>
        <td><select data-bind="slabs.${i}.policy">${Object.keys(Planner.POLICY).map((k) => `<option value="${k}" ${s.policy === k ? 'selected' : ''}>${Planner.POLICY[k]}</option>`).join('')}</select></td><td><button class="btn xs ghost danger" data-act="del-slab" data-i="${i}">🗑</button></td></tr>`).join('')}
      </tbody></table>${issues.length ? `<div class="callout warn mt">${issues.map(esc).join(' · ')}</div>` : ''}</div></div>
      <div class="card"><div class="card-h"><div><div class="card-t">Vehicle types &amp; fleet</div><div class="card-d">From “Predefined equipment (1).xlsx”. Inner dimensions and door opening in ${UNIT()}; for open-top vehicles H is the side-wall height. End-door vehicles only take items whose width × height passes the door, unless marked open top. Owned counts and ₹/km rates are not in the sheet – fill them in to enable cost and owned/market choice.</div></div>
        <div class="row"><label class="small" title="Used for open-top vehicles without their own max load height">Open-body limit: road height <input type="number" min="0" step="0.1" style="width:72px" value="${r1(toU(S.settings.fleet.roadH))}" data-bind="settings.fleet.roadH" data-type="len"> − deck <input type="number" min="0" step="0.1" style="width:64px" value="${r1(toU(S.settings.fleet.deckH))}" data-bind="settings.fleet.deckH" data-type="len"> ${UNIT()} = ${lenU(packOpts().openTopH)}</label>
        <label class="small">Sheet “Max. payload” unit <select class="sel-sm" data-act-change="payload-unit"><option value="lb" ${S.settings.fleet.payloadUnit === 'lb' ? 'selected' : ''}>lb (→ converted to kg)</option><option value="kg" ${S.settings.fleet.payloadUnit === 'kg' ? 'selected' : ''}>kg</option></select></label><button class="btn sm" data-act="add-vehicle">＋ Vehicle</button></div></div>
      <div class="card-b"><div class="tbl-wrap scroll-y" style="max-height:620px"><table class="tbl"><thead><tr><th>Active</th><th>Equipment name</th><th>Door</th><th>L (${UNIT()})</th><th>W</th><th>H</th><th>Door W</th><th>Door H</th><th title="Open top: crane / top loaded, loads may rise above the side walls">Open top</th><th title="Highest point a load may reach above the deck on an open top. Blank = global limit.">Max load ht</th><th>Max. payload (${S.settings.fleet.payloadUnit})</th><th class="num">Payload kg</th><th class="num">${volU()}</th><th>Owned count</th><th>Owned ₹/km</th><th>Market ₹/km</th><th>Market min ₹</th><th></th></tr></thead><tbody>
      ${S.vehicles.map((v, i) => `<tr><td style="text-align:center"><input type="checkbox" ${v.active !== false ? 'checked' : ''} data-bind="vehicles.${i}.active"></td><td><input type="text" class="w-lg" value="${esc(v.name)}" data-bind="vehicles.${i}.name"></td>
        <td><select style="width:150px" data-bind="vehicles.${i}.door">${['Left', 'Top', 'None'].map((d) => `<option value="${d}" ${v.door === d ? 'selected' : ''}>${d} – ${DOOR[d]}</option>`).join('')}</select></td>
        ${['l', 'w', 'h', 'doorW', 'doorH'].map((f) => `<td><input type="number" min="0" step="0.1" value="${r1(toU(v[f] || 0))}" data-bind="vehicles.${i}.${f}" data-type="len" ${(f === 'doorW' || f === 'doorH') && v.door !== 'Left' ? 'disabled title="Only used for end-door vehicles"' : ''}></td>`).join('')}
        <td style="text-align:center"><input type="checkbox" ${Packer.isOpen(v) ? 'checked' : ''} data-bind="vehicles.${i}.open"></td>
        <td><input type="number" min="0" step="0.1" value="${+v.maxLoadH > 0 ? r1(toU(v.maxLoadH)) : ''}" placeholder="${fmtL(packOpts().openTopH)}" data-bind="vehicles.${i}.maxLoadH" data-type="len" ${Packer.isOpen(v) ? '' : 'disabled title="Only used for open-top vehicles"'}></td>
        <td><input type="number" min="0" value="${v.payloadSrc != null ? v.payloadSrc : v.payload}" data-bind="vehicles.${i}.payloadSrc" data-type="num" style="width:96px"></td><td class="num">${fmt(v.payload)}</td><td class="num">${fmt(vol(v.l * v.w * v.h), 0)}</td>
        ${['ownedCount', 'ownedRate', 'marketRate', 'marketMin'].map((f) => `<td><input type="number" min="0" value="${v[f] || 0}" data-bind="vehicles.${i}.${f}" data-type="num"></td>`).join('')}
        <td><button class="btn xs ghost danger" data-act="del-vehicle" data-id="${esc(v.id)}">🗑</button></td></tr>`).join('')}
      </tbody></table></div></div></div>`;
  }

  // =====================================================================
  //  AUDIT
  // =====================================================================
  function renderAudit() {
    const q = (S.ui.auditQ || '').toLowerCase();
    const rows = S.audit.filter((a) => !q || [a.action, a.entity, a.details].join(' ').toLowerCase().includes(q));
    const actions = [...new Set(S.audit.map((a) => a.action))];
    $('#tab-audit').innerHTML = `<div class="tiles mb" style="grid-template-columns:repeat(3,1fr)"><div class="tile"><div class="k">Total Actions</div><div class="v">${S.audit.length}</div></div><div class="tile"><div class="k">Optimizations</div><div class="v">${S.audit.filter((a) => /Optimi|Planning|Re-plan/.test(a.action)).length}</div></div><div class="tile"><div class="k">Rule / master changes</div><div class="v">${S.audit.filter((a) => a.action === 'Updated').length}</div></div></div>
    <div class="card"><div class="card-h"><div class="card-t">Audit Trail</div><div class="row"><input type="search" placeholder="Filter actions..." value="${esc(S.ui.auditQ || '')}" data-act-input="audit-q" style="width:220px"><button class="btn sm" data-act="export-audit">⤓ Export CSV</button><button class="btn sm danger" data-act="clear-audit">Clear</button></div></div>
      <div class="card-b"><div class="xs muted mb">${actions.length} action types: ${actions.map(esc).join(', ')}</div><div class="tbl-wrap scroll-y" style="max-height:620px"><table class="tbl"><thead><tr><th>Time</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>
      ${rows.length ? rows.map((a) => `<tr><td class="mono small nowrap">${esc(new Date(a.t).toLocaleString('en-IN'))}</td><td><span class="badge">${esc(a.action)}</span></td><td class="small">${esc(a.entity)}</td><td class="small">${esc(a.details)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No audit logs found</td></tr>'}
      </tbody></table></div></div></div>`;
  }

  // =====================================================================
  //  EVENTS
  // =====================================================================
  function setPath(obj, path, val) {
    const ks = path.split('.');
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
    o[ks[ks.length - 1]] = val;
  }
  function readVal(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.dataset.type === 'len') { const n = parseFloat(el.value); return Number.isFinite(n) ? r1(fromU(n)) : 0; }
    if (el.dataset.type === 'num' || el.type === 'number' || el.type === 'range') { const n = parseFloat(el.value); return Number.isFinite(n) ? n : 0; }
    return el.value;
  }
  function rerenderKeepFocus() {
    const a = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.bind : null;
    renderCurrent();
    if (a) { const el = document.querySelector(`[data-bind="${a}"]`); if (el) el.focus(); }
  }

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.bind) {
      const path = el.dataset.bind;
      let val = readVal(el);
      if (path.startsWith('slabs.') && path.endsWith('.to') && val === 0) val = 99999;
      setPath(S, path, val);
      if (path.startsWith('settings.opt.') && !path.endsWith('preset')) { if (['clearance', 'supportRatio'].some((k) => path.endsWith(k))) S.settings.opt.preset = 'custom'; markStale(); }
      if (/^(skus|categories|compat|vehicles|settings\.fleet)\./.test(path)) markStale();
      if (/^vehicles\.\d+\.payloadSrc$/.test(path)) derivePayloads();
      save();
      audit('Updated', path.replace(/\.(\d+)\./, (m, i) => { const arr = S[path.split('.')[0]]; const x = arr && arr[+i]; return ` [${x ? x.id || x.region || x.name || i : i}] `; }), String(val));
      setTimeout(rerenderKeepFocus, 0);
      return;
    }
    const act = el.dataset.actChange;
    if (!act) return;
    if (act === 'vehicle') { if (S.split) { exitSplit(); planStale = false; loadPlan = null; } S.selectedVehicleId = el.value; loadContext = loadContext.startsWith('Trip') ? '' : loadContext; markStale(); save(); audit('Changed vehicle', vName(el.value)); renderOptimizer(); }
    else if (act === 'cust-filter') {
      S.custFilterId = el.value;
      const v = vehMap()[S.selectedVehicleId];
      if (v && !vehicleAllowed(v).ok) {
        const allowed = S.vehicles.filter((x) => vehicleAllowed(x).ok).sort((a, b) => Planner.vVol(b) - Planner.vVol(a));
        if (allowed[0]) { S.selectedVehicleId = allowed[0].id; toast(`Vehicle changed to ${allowed[0].name} – customer restriction`); markStale(); }
      }
      save(); renderOptimizer();
    }
    else if (act === 'preset') { const p = el.value; S.settings.opt.preset = p; if (PRESETS[p]) Object.assign(S.settings.opt, PRESETS[p]); markStale(); save(); renderOptimizer(); }
    else if (act === 'item-qty') { const it = S.items.find((x) => x.id === el.dataset.id); if (it) { it.qty = Math.max(0, Math.floor(+el.value || 0)); markStale(); save(); renderOptimizer(); } }
    else if (act === 'payload-unit') { S.settings.fleet.payloadUnit = el.value; derivePayloads(); markStale(); save(); audit('Updated', 'fleet payload unit', el.value); renderMasters(); }
    else if (act === 'hl-cat') { S.ui.hlCat = el.value; save(); applyHighlight(); }
    else if (act === 'compat') { const k = el.dataset.a + '|' + el.dataset.b, k2 = el.dataset.b + '|' + el.dataset.a; delete S.compat[k2]; S.compat[k] = el.value; markStale(); save(); audit('Updated', 'compatibility ' + catName(el.dataset.a) + ' × ' + catName(el.dataset.b), el.value); renderCompat(); }
  });

  document.addEventListener('input', (e) => {
    const el = e.target;
    const act = el.dataset.actInput;
    if (act === 'search') { S.ui.search = el.value; const pos = el.selectionStart; renderItems(); const n = $('#lo-items input[type=search]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
    else if (act === 'step') { viz.setStep(+el.value); const l = $('#step-lbl'); if (l) l.textContent = `${el.value} / ${loadPlan.placed.length}`; }
    else if (act === 'audit-q') { S.ui.auditQ = el.value; const pos = el.selectionStart; renderAudit(); const n = $('#tab-audit input[type=search]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
    else if (el.type === 'range' && el.dataset.bind) { const lbl = el.closest('.field').querySelector('.lbl'); if (lbl) lbl.textContent = el.dataset.bind.endsWith('clearance') ? `Clearance between items: ${el.value} cm` : `Minimum support under stacked items: ${Math.round(el.value * 100)}%`; }
  });

  document.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { setTab(tabBtn.dataset.tab); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const act = a.dataset.act, id = a.dataset.id, v = a.dataset.v;
    if (a.tagName === 'A') e.preventDefault();
    switch (act) {
      case 'dlg-close': closeDialog(); break;
      case 'theme': {
        const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        document.documentElement.dataset.theme = cur === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(KEY + '-theme', document.documentElement.dataset.theme); } catch (er) { /* ignore */ }
        viz.applyTheme();
        break;
      }
      case 'reset-all':
        openDialog('Reset all data?', '<p>This restores the default SKU master, customers, fleet, rules and sample data. Your current items, orders and audit trail are cleared.</p>', '<button class="btn" data-act="dlg-close">Cancel</button><button class="btn primary" data-act="reset-confirm">Reset</button>');
        break;
      case 'reset-confirm': {
        try { localStorage.removeItem(KEY); } catch (er) { /* ignore */ }
        S = defaults(); planResult = null; loadPlan = null; fleetPlan = null; closeDialog(); seed(); setTab('optimizer'); toast('Data reset to defaults');
        break;
      }
      case 'units': S.settings.units = UNIT() === 'in' ? 'cm' : 'in'; save(); a.textContent = 'Units: ' + UNIT(); renderCurrent(); break;
      case 'optimize': optimize(); break;
      case 'focus-vehicle': $('#vehicle-card').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#veh-select').focus(); break;
      case 'suggest': suggestDialog(); break;
      case 'sv-run': runSuggest(); break;
      case 'use-vehicle': exitSplit(); S.selectedVehicleId = id; save(); closeDialog(); audit('Changed vehicle', vName(id), 'from suggestion'); optimize(true); break;
      case 'split-run': if (!S.split) S.splitIds = null; S.split = true; S.ui.truck = 0; save(); optimize(); break;
      case 'use-split': S.split = true; S.splitIds = (v || '').split(',').filter(Boolean); S.ui.truck = 0; save(); closeDialog(); optimize(); break;
      case 'split-vehicles': suggestDialog(); break;
      case 'pick-truck': showTruck(+v); break;
      case 'single-vehicle': { const cur = S.selectedVehicleId; exitSplit(); S.selectedVehicleId = cur; save(); optimize(true); break; }
      case 'add-item': itemDialog(); break;
      case 'edit-item': itemDialog(id); break;
      case 'save-item': {
        const qty = Math.floor(+$('#f-qty').value), drop = Math.max(1, Math.floor(+$('#f-drop').value || 1));
        if (!(qty >= 1)) { toast('Quantity must be a whole number of 1 or more'); return; }
        const data = { skuId: $('#f-sku').value, qty, drop, dest: $('#f-dest').value.trim() };
        if (id) { Object.assign(S.items.find((x) => x.id === id), data); audit('Edited item', data.skuId, `qty ${qty}, drop ${drop}`); }
        else { S.items.push(Object.assign({ id: uid('L') }, data)); audit('Added item', data.skuId, `qty ${qty}, drop ${drop}`); }
        markStale(); save(); closeDialog(); renderOptimizer();
        break;
      }
      case 'del-item': { const it = S.items.find((x) => x.id === id); S.items = S.items.filter((x) => x.id !== id); markStale(); save(); audit('Deleted item', it ? it.skuId : id); if (!S.items.length) { loadPlan = null; exitSplit(); viz.setPlan(null); } renderOptimizer(); break; }
      case 'clear-items': exitSplit(); S.items = []; loadPlan = null; loadContext = ''; viz.setPlan(null); save(); audit('Cleared items', 'Item inventory'); renderOptimizer(); break;
      case 'templates': templatesDialog(); break;
      case 'load-template': loadTemplate(id); break;
      case 'upload': uploadDialog(); break;
      case 'csv-import': importCSV(); break;
      case 'csv-template': download('items-template.csv', [ITEM_COLS.join(','), 'PKG-01,,,,,,1,1,Bidar,,,,,,,', 'PKG-05,,,,,,1,1,Bidar,,,,,,,', 'PKG-13,New wooden case,40,30,25,220,1,1,Bidar,Ash Handling,2,220,0,true,true,true'].join('\n')); break;
      case 'export-items': exportItems(); break;
      case 'cat-filter': S.ui.catFilter = v; save(); renderItems(); break;
      case 'color-mode': S.ui.colorMode = v; save(); viz.recolor(colorFor); renderVizChrome(); break;
      case 'view': viz.view(v); break;
      case 'snapshot': { const url = viz.snapshot(); if (url) { const l = document.createElement('a'); l.href = url; l.download = `load-plan-${loadPlan.vehicle.id}.png`; l.click(); } break; }
      case 'play': {
        if (playTimer) { clearInterval(playTimer); playTimer = null; renderVizChrome(); break; }
        const n = loadPlan.placed.length;
        let s = viz.step >= n ? 0 : viz.step;
        const inc = Math.max(1, Math.round(n / 120));
        playTimer = setInterval(() => {
          s = Math.min(n, s + inc); viz.setStep(s);
          const r = $('#viz-steps input'); if (r) r.value = s; const l = $('#step-lbl'); if (l) l.textContent = `${s} / ${n}`;
          if (s >= n) { clearInterval(playTimer); playTimer = null; renderVizChrome(); }
        }, 60);
        renderVizChrome();
        break;
      }
      case 'show-step': setTab('optimizer'); viz.setStep(+v); renderVizChrome(); break;
      case 'export-sheet': exportSheet(); break;
      case 'print': window.print(); break;
      // planning
      case 'scope': {
        const sc = S.settings.plan.scope;
        if (!v) S.settings.plan.scope = [];
        else S.settings.plan.scope = sc.includes(v) ? sc.filter((x) => x !== v) : sc.concat(v);
        save(); audit('Updated', 'planning scope', S.settings.plan.scope.map(catName).join(', ') || 'All'); renderPlanning();
        break;
      }
      case 'run-plan': runPlanning('manual'); break;
      case 'dispatch': {
        if (!planResult) break;
        const ids = new Set(planResult.plannedOrderIds);
        S.orders.forEach((o) => { if (ids.has(o.id)) o.status = 'dispatched'; });
        audit('Plan dispatched', `${planResult.trips.length} trips`, `${ids.size} orders`);
        planResult = null; save(); renderPlanning(); toast('Plan confirmed – orders marked dispatched');
        break;
      }
      case 'expand-trip': if (e.target.closest('button')) break; S.ui.planExpanded = S.ui.planExpanded === id ? null : id; renderPlanning(); break;
      case 'trip-3d': {
        const t = planResult && planResult.trips.find((x) => x.id === id);
        if (!t) break;
        exitSplit();
        S.items = t.items.map((it) => ({ id: uid('L'), skuId: it.skuId, qty: it.qty, drop: it.drop, dest: it.dest }));
        S.selectedVehicleId = t.vehicle.id;
        S.custFilterId = '';
        S.ui.colorMode = t.seq.order.length > 1 ? 'drop' : 'category';
        loadContext = `Trip ${t.id} · ${t.corridor}`;
        save(); setTab('optimizer'); optimize(true);
        break;
      }
      case 'sim-order': addSimOrders(+v); break;
      case 'sim-time': advanceClock(+v); break;
      case 'sim-auto': toggleAuto(); break;
      case 'add-order': orderDialog(); break;
      case 'save-order': {
        const lines = $$('.ord-line').map((r) => ({ skuId: $('.ol-sku', r).value, qty: Math.floor(+$('.ol-qty', r).value || 0) })).filter((l) => l.skuId && l.qty > 0);
        if (!lines.length) { toast('Add at least one SKU line'); return; }
        const o = { id: 'SO-' + (2000 + S.sim.seq++), custId: $('#o-cust').value, lines, createdAt: S.sim.clock, status: 'pending' };
        S.orders.push(o); S.sim.log.unshift({ t: S.sim.clock, msg: `+1 order received (${o.id}, manual)` });
        save(); closeDialog(); audit('Added order', o.id, custMap()[o.custId].name); checkTrigger(); renderPlanning();
        break;
      }
      case 'sample-orders': S.orders = Planner.sampleOrders(S); S.sim = { clock: 0, lastPlanAt: 0, log: [{ t: 0, msg: `${S.orders.length} order${S.orders.length === 1 ? '' : 's'} loaded (${S.orders.map((o) => o.id).join(', ')})` }], seq: 1 }; planResult = null; save(); audit('Loaded sample orders', `${S.orders.length} orders`); renderPlanning(); break;
      case 'clear-orders': S.orders = []; planResult = null; save(); audit('Cleared orders', 'Orders'); renderPlanning(); break;
      case 'del-order': S.orders = S.orders.filter((o) => o.id !== id); save(); audit('Deleted order', id); renderPlanning(); break;
      case 'goto-masters': S.ui.mtab = v || 'skus'; setTab('masters'); break;
      // masters
      case 'mtab': S.ui.mtab = v; save(); renderMasters(); break;
      case 'add-sku': {
        let n = 1; while (S.skus.some((s) => s.id === 'NEW-' + n)) n++;
        S.skus.push({ id: 'NEW-' + n, name: 'New SKU ' + n, cat: 'general', l: 40, w: 30, h: 30, wt: 10, maxStack: 6, maxTopKg: 0, maxHeight: 0, onTop: true, under: true, rotate: true, tip: false, color: '#64748b' });
        save(); audit('Added SKU', 'NEW-' + n); renderMasters();
        break;
      }
      case 'del-sku': {
        if (S.items.some((it) => it.skuId === id) || S.orders.some((o) => o.status === 'pending' && o.lines.some((l) => l.skuId === id))) { toast('SKU is used by items or pending orders'); break; }
        S.skus = S.skus.filter((s) => s.id !== id); save(); audit('Deleted SKU', id); renderMasters();
        break;
      }
      case 'export-skus': {
        const cols = ['id', 'name', 'cat', 'l', 'w', 'h', 'wt', 'maxStack', 'maxTopKg', 'maxHeight', 'onTop', 'under', 'rotate', 'tip'];
        download('sku-stacking-norms.csv', [cols.join(',')].concat(S.skus.map((s) => cols.map((c) => csvCell(c === 'cat' ? catName(s.cat) : s[c])).join(','))).join('\n'));
        break;
      }
      case 'add-region': S.regionRules.push({ region: 'New region', maxVehicleId: 't17', note: '' }); save(); renderMasters(); break;
      case 'del-region': S.regionRules.splice(+a.dataset.i, 1); save(); audit('Deleted region rule', a.dataset.i); renderMasters(); break;
      case 'add-customer': customerDialog(); break;
      case 'save-customer': {
        const c = { id: $('#c-id').value.trim(), name: $('#c-name').value.trim(), city: $('#c-city').value.trim(), region: $('#c-region').value.trim() || 'Karnataka', corridor: $('#c-corr').value.trim() || 'Pune → Solapur → Bidar (NH-65)', lat: +$('#c-lat').value, lng: +$('#c-lng').value, maxVehicleId: $('#c-max').value, note: '' };
        if (!c.id || !c.name || !Number.isFinite(c.lat) || !Number.isFinite(c.lng) || !c.lat || !c.lng) { toast('ID, name, latitude and longitude are required'); return; }
        if (S.customers.some((x) => x.id === c.id)) { toast('Customer ID already exists'); return; }
        S.customers.push(c); save(); closeDialog(); audit('Added customer', c.id, c.name); renderMasters();
        break;
      }
      case 'del-customer': {
        if (S.orders.some((o) => o.custId === id && o.status === 'pending')) { toast('Customer has pending orders'); break; }
        S.customers = S.customers.filter((c) => c.id !== id); save(); audit('Deleted customer', id); renderMasters();
        break;
      }
      case 'add-slab': { const last = S.slabs.slice().sort((x, y) => x.to - y.to).pop(); S.slabs.push({ from: last ? Math.min(last.to, 99998) : 0, to: 99999, policy: 'market_first' }); save(); renderMasters(); break; }
      case 'del-slab': S.slabs.splice(+a.dataset.i, 1); save(); audit('Deleted KM slab', a.dataset.i); renderMasters(); break;
      case 'add-vehicle': S.vehicles.push({ id: uid('v'), name: 'New vehicle', l: 400, w: 200, h: 200, payload: 3000, ownedCount: 0, ownedRate: 15, marketRate: 30, marketMin: 3000 }); save(); renderMasters(); break;
      case 'del-vehicle': {
        if (S.vehicles.length <= 1) break;
        S.vehicles = S.vehicles.filter((x) => x.id !== id);
        if (S.selectedVehicleId === id) S.selectedVehicleId = S.vehicles[0].id;
        save(); audit('Deleted vehicle', id); renderMasters();
        break;
      }
      case 'add-cat': {
        let n = 1; while (S.categories.some((c) => c.id === 'cat_' + n)) n++;
        S.categories.push({ id: 'cat_' + n, name: 'New category ' + n, color: '#0ea5e9' }); save(); audit('Added category', 'cat_' + n); renderCompat();
        break;
      }
      case 'del-cat': S.categories = S.categories.filter((c) => c.id !== id); Object.keys(S.compat).forEach((k) => { if (k.split('|').includes(id)) delete S.compat[k]; }); save(); audit('Deleted category', id); renderCompat(); break;
      case 'export-audit': download('audit-trail.csv', [['time', 'action', 'entity', 'details'].join(',')].concat(S.audit.map((x) => [x.t, x.action, x.entity, x.details].map(csvCell).join(','))).join('\n')); break;
      case 'clear-audit': S.audit = []; save(); renderAudit(); break;
      default: break;
    }
  });

  function customerDialog() {
    openDialog('Add Customer', `<div class="grid2"><div class="field" style="margin:0"><label class="lbl">Customer ID *</label><input type="text" id="c-id" placeholder="e.g. C020"></div><div class="field" style="margin:0"><label class="lbl">Name *</label><input type="text" id="c-name"></div>
      <div class="field" style="margin:0"><label class="lbl">City</label><input type="text" id="c-city"></div><div class="field" style="margin:0"><label class="lbl">Region</label><input type="text" id="c-region" list="regions" placeholder="e.g. North East"></div>
      <div class="field" style="margin:0"><label class="lbl">Route corridor</label><input type="text" id="c-corr" list="corridors"></div><div class="field" style="margin:0"><label class="lbl">Vehicle limit (override)</label><select id="c-max">${vOpts('', '— Inherit region rule —')}</select></div>
      <div class="field" style="margin:0"><label class="lbl">Latitude *</label><input type="number" id="c-lat" step="0.01" placeholder="26.14"></div><div class="field" style="margin:0"><label class="lbl">Longitude *</label><input type="number" id="c-lng" step="0.01" placeholder="91.74"></div></div>`,
      `<button class="btn" data-act="dlg-close">Cancel</button><button class="btn primary" data-act="save-customer">Add Customer</button>`);
  }

  // ---------------- boot ----------------
  function seed() {
    if (!S.seeded) {
      S.orders = Planner.sampleOrders(S);
      S.sim.log = [{ t: 0, msg: `${S.orders.length} order${S.orders.length === 1 ? '' : 's'} loaded (${S.orders.map((o) => o.id).join(', ')})` }];
      S.seeded = true;
      save();
      loadTemplate('sample-bidar', true);
      audit('Session started', 'Case data', 'Sample packing list (12 packages) and Excel equipment master loaded');
    } else if (S.items.length) {
      optimize(true);
    }
  }
  derivePayloads();
  const ub = document.querySelector('[data-act="units"]'); if (ub) ub.textContent = 'Units: ' + UNIT();
  try { const th = localStorage.getItem(KEY + '-theme'); if (th) { document.documentElement.dataset.theme = th; viz.applyTheme(); } } catch (e) { /* ignore */ }
  seed();
  setTab(S.ui.tab || 'optimizer');
})();
