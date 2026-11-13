/* Three.js load visualisation. Packer axes → three axes:
 *   packer x (length, 0 = nose) → three X,  packer y (width) → three Z,  packer z (height) → three Y.
 */
(function (root) {
  const S = 0.01; // cm → m

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function textSprite(text, color) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.font = '600 30px Inter, system-ui, sans-serif';
    g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 128, 32);
    const tex = new THREE.CanvasTexture(c);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.scale.set(1.6, 0.4, 1);
    return sp;
  }

  class LoadViz {
    constructor(el, opts) {
      this.el = el;
      this.opts = opts || {};
      this.ok = typeof THREE !== 'undefined';
      if (!this.ok) { el.innerHTML = '<div class="viz-empty">3D library could not be loaded (offline?). The plan and tables still work.</div>'; return; }
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 500);
      this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      el.appendChild(this.renderer.domElement);
      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.85));
      const dl = new THREE.DirectionalLight(0xffffff, 0.55);
      dl.position.set(5, 10, 7);
      this.scene.add(dl);
      this.truck = new THREE.Group();
      this.boxes = new THREE.Group();
      this.scene.add(this.truck, this.boxes);
      this.meshes = [];
      this.raycaster = new THREE.Raycaster();
      this.mouse = new THREE.Vector2();
      this.hovered = null;
      this.applyTheme();
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(el);
      this.resize();
      this.renderer.domElement.addEventListener('pointermove', (e) => this.onMove(e));
      this.renderer.domElement.addEventListener('pointerleave', () => this.setHover(null, null));
      const loop = () => { requestAnimationFrame(loop); this.controls.update(); this.renderer.render(this.scene, this.camera); };
      loop();
    }

    applyTheme() {
      if (!this.ok) return;
      this.scene.background = new THREE.Color(cssVar('--viz-bg', '#f1f5f9'));
      this.lineColor = cssVar('--viz-line', '#334155');
      this.labelColor = cssVar('--viz-label', '#0f172a');
      if (this.vehicle) this.drawTruck(this.vehicle, this.plan && this.plan.stats);
    }

    resize() {
      if (!this.ok) return;
      const w = this.el.clientWidth || 600, h = this.el.clientHeight || 400;
      this.renderer.setSize(w, h, false);
      this.renderer.domElement.style.width = '100%';
      this.renderer.domElement.style.height = '100%';
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    clearGroup(g) {
      while (g.children.length) {
        const c = g.children.pop();
        c.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
      }
    }

    drawTruck(v, st) {
      this.clearGroup(this.truck);
      const L = v.l * S, W = v.w * S, H = v.h * S;
      const ox = -L / 2, oz = -W / 2;
      const lc = new THREE.Color(this.lineColor);
      // floor
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(L, W), new THREE.MeshLambertMaterial({ color: lc, transparent: true, opacity: 0.12, side: THREE.DoubleSide }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(0, 0.001, 0);
      this.truck.add(floor);
      // cargo box edges
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(L, H, W)), new THREE.LineBasicMaterial({ color: lc, transparent: true, opacity: 0.6 }));
      edges.position.set(0, H / 2, 0);
      this.truck.add(edges);
      // cab at the nose
      const cabL = Math.min(1.6, L * 0.25);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(cabL, H * 0.75, W * 0.95), new THREE.MeshLambertMaterial({ color: lc, transparent: true, opacity: 0.22 }));
      cab.position.set(ox - cabL / 2 - 0.08, H * 0.375, 0);
      this.truck.add(cab);
      // floor grid every 1 m
      const pts = [];
      for (let x = 1; x < L; x += 1) pts.push(new THREE.Vector3(ox + x, 0.002, oz), new THREE.Vector3(ox + x, 0.002, oz + W));
      const grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: lc, transparent: true, opacity: 0.18 }));
      this.truck.add(grid);
      const nose = textSprite('NOSE / CAB', this.labelColor);
      nose.position.set(ox - cabL / 2, H * 0.75 + 0.35, 0);
      const lbl = v.door === 'Top' ? 'TOP-LOADING' : v.door === 'Left' ? 'DOOR' : 'OPEN BODY';
      const door = textSprite(lbl, this.labelColor);
      door.position.set(L / 2 + 0.7, v.door === 'Top' ? H + 0.35 : H / 2, 0);
      this.truck.add(nose, door);
      // End-door opening outline (what has to pass through it)
      if (v.door === 'Left' && v.doorW > 0 && v.doorH > 0) {
        const dw = Math.min(v.doorW, v.w) * S, dh = Math.min(v.doorH, v.h) * S;
        const p = [[-dw / 2, 0], [-dw / 2, dh], [dw / 2, dh], [dw / 2, 0]].map(([z, y]) => new THREE.Vector3(L / 2 + 0.005, y, z));
        const fr = new THREE.Line(new THREE.BufferGeometry().setFromPoints(p), new THREE.LineBasicMaterial({ color: 0xd97706 }));
        this.truck.add(fr);
      }
      // Open body: dashed frame from the top of the side walls up to the height limit the load may reach.
      if (st && st.open && st.heightLimit > v.h + 0.5) {
        const HL = st.heightLimit * S;
        const c = 0x0891b2;
        const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(L, HL - H, W)), new THREE.LineDashedMaterial({ color: c, dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: 0.85 }));
        box.position.set(0, (H + HL) / 2, 0);
        box.computeLineDistances();
        this.truck.add(box);
        const top = new THREE.Mesh(new THREE.PlaneGeometry(L, W), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }));
        top.rotation.x = -Math.PI / 2;
        top.position.set(0, HL, 0);
        this.truck.add(top);
        const t = textSprite('HEIGHT LIMIT', '#0891b2');
        t.position.set(L / 2 + 0.7, HL, 0);
        this.truck.add(t);
      }
      this.topH = st && st.open ? Math.max(v.h, st.heightLimit || 0, st.maxTop || 0) : v.h;
    }

    setPlan(plan, colorFn) {
      if (!this.ok) return;
      this.clearGroup(this.boxes);
      this.meshes = [];
      this.plan = plan;
      if (!plan || !plan.vehicle) { this.vehicle = null; this.clearGroup(this.truck); return; }
      const v = plan.vehicle;
      const hl = plan.stats && plan.stats.open ? plan.stats.heightLimit : 0;
      const changed = !this.vehicle || this.vehicle.id !== v.id || this.vehicle.l !== v.l || this._hl !== hl;
      this._hl = hl;
      this.vehicle = v;
      this.drawTruck(v, plan.stats);
      const ox = -v.l * S / 2, oz = -v.w * S / 2;
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const egeo = new THREE.EdgesGeometry(geo);
      plan.placed.forEach((b, i) => {
        const col = new THREE.Color(colorFn(b));
        const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: col }));
        const g = 0.004; // tiny gap so edges read
        m.scale.set(b.l * S - g, b.h * S - g, b.w * S - g);
        m.position.set(ox + (b.x + b.l / 2) * S, (b.z + b.h / 2) * S, oz + (b.y + b.w / 2) * S);
        const e = new THREE.LineSegments(egeo, new THREE.LineBasicMaterial({ color: col.clone().multiplyScalar(0.55) }));
        m.add(e);
        m.userData = { b, i, base: col };
        this.boxes.add(m);
        this.meshes.push(m);
      });
      if (changed) this.view('iso');
      this.setStep(plan.placed.length);
    }

    recolor(colorFn) {
      if (!this.ok) return;
      this.meshes.forEach((m) => {
        const col = new THREE.Color(colorFn(m.userData.b));
        m.userData.base = col;
        m.material.color.copy(col);
        m.children[0].material.color.copy(col.clone().multiplyScalar(0.55));
      });
    }

    setStep(n) {
      if (!this.ok) return;
      this.step = n;
      this.meshes.forEach((m, i) => { m.visible = i < n; m.material.emissive && m.material.emissive.setHex(i === n - 1 ? 0x333333 : 0x000000); });
    }

    highlight(pred) {
      if (!this.ok) return;
      this.meshes.forEach((m) => {
        const on = !pred || pred(m.userData.b);
        m.material.transparent = !on;
        m.material.opacity = on ? 1 : 0.12;
        m.children[0].visible = on;
      });
    }

    view(name) {
      if (!this.ok || !this.vehicle) return;
      const L = this.vehicle.l * S, W = this.vehicle.w * S, H = (this.topH || this.vehicle.h) * S;
      // Fit the cargo box (plus cab) in view: distance from the bounding-sphere radius and the field of view.
      const r = Math.sqrt((L + 1.8) ** 2 + W * W + H * H) / 2;
      const fov = (this.camera.fov * Math.PI) / 180;
      const fit = r / Math.sin(fov / 2) / Math.min(1, this.camera.aspect) * 1.02;
      const dirs = { iso: [0.55, 0.5, 0.67], top: [0.0001, 1, 0.0001], side: [0, 0.12, 1], door: [1, 0.3, 0.0001] };
      const dv = new THREE.Vector3(...(dirs[name] || dirs.iso)).normalize().multiplyScalar(name === 'door' ? Math.max(W, H) * 1.6 + L * 0.5 : fit * (name === 'iso' ? 0.9 : 0.85));
      const t = new THREE.Vector3(-0.4, H / 2, 0);
      this.camera.position.copy(t).add(dv);
      this.controls.target.copy(t);
      this.controls.update();
    }

    onMove(e) {
      if (!this.meshes.length) return;
      const r = this.renderer.domElement.getBoundingClientRect();
      this.mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const hit = this.raycaster.intersectObjects(this.meshes.filter((m) => m.visible), false)[0];
      this.setHover(hit ? hit.object : null, e);
    }
    setHover(m, e) {
      if (this.hovered && this.hovered !== m) this.hovered.material.emissive.setHex(0x000000);
      this.hovered = m;
      if (m) m.material.emissive.setHex(0x444444);
      if (this.opts.onHover) this.opts.onHover(m ? m.userData.b : null, e);
    }

    snapshot() { return this.ok ? this.renderer.domElement.toDataURL('image/png') : null; }
  }

  root.LoadViz = LoadViz;
})(window);
