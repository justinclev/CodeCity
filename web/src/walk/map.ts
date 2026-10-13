/**
 * Walk-mode maps: a minimap that turns with the camera, and a full north-up map
 * (M) with fog of war, district names, markers, hover and click-to-travel.
 */

export interface MapBox { i: number; x0: number; x1: number; z0: number; z1: number }
export interface MapPlate { x0: number; x1: number; z0: number; z1: number; depth: number }
export interface MapLabel { text: string; x: number; z: number }
export interface MapMarker { x: number; z: number; kind: 'shard' | 'gold' | 'terminal' | 'tour' | 'quest'; label?: string }

export interface MapState {
  seen(i: number): boolean;
  studied(i: number): boolean;
  markers(): MapMarker[];
  player(): { x: number; z: number; heading: number; yaw: number };
}

const BG = '#02070d';

export class CityMap {
  private base = document.createElement('canvas');
  private scale = 1;
  private minX = 0; private minZ = 0; private w = 1; private h = 1;
  private dirty = true;
  full: HTMLElement | null = null;
  private fullCanvas: HTMLCanvasElement | null = null;
  private hover = -1;

  constructor(private boxes: MapBox[], private plates: MapPlate[], private labels: MapLabel[], private st: MapState, include: { x: number; z: number }[] = [], private roads: { kind: string; pts: [number, number][]; width: number }[] = []) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const r of [...boxes, ...plates]) { x0 = Math.min(x0, r.x0); z0 = Math.min(z0, r.z0); x1 = Math.max(x1, r.x1); z1 = Math.max(z1, r.z1); }
    for (const p of include) { x0 = Math.min(x0, p.x); z0 = Math.min(z0, p.z); x1 = Math.max(x1, p.x); z1 = Math.max(z1, p.z); }
    if (!isFinite(x0)) { x0 = z0 = 0; x1 = z1 = 10; }
    const pad = Math.max(x1 - x0, z1 - z0) * 0.04;
    this.minX = x0 - pad; this.minZ = z0 - pad;
    this.w = x1 - x0 + pad * 2; this.h = z1 - z0 + pad * 2;
    this.scale = 1400 / Math.max(this.w, this.h);
    this.base.width = Math.ceil(this.w * this.scale);
    this.base.height = Math.ceil(this.h * this.scale);
  }

  /** Re-render the city layer (after progress changed). */
  invalidate() { this.dirty = true; }

  private render() {
    const c = this.base.getContext('2d')!;
    const s = this.scale;
    c.fillStyle = BG;
    c.fillRect(0, 0, this.base.width, this.base.height);
    const X = (x: number) => (x - this.minX) * s, Z = (z: number) => (z - this.minZ) * s;
    for (const p of [...this.plates].sort((a, b) => a.depth - b.depth)) {
      c.fillStyle = `rgba(20, 70, 105, ${Math.min(0.5, 0.16 + p.depth * 0.07)})`;
      c.fillRect(X(p.x0), Z(p.z0), (p.x1 - p.x0) * s, (p.z1 - p.z0) * s);
      c.strokeStyle = 'rgba(54, 224, 255, 0.22)';
      c.lineWidth = 1;
      c.strokeRect(X(p.x0) + 0.5, Z(p.z0) + 0.5, (p.x1 - p.x0) * s - 1, (p.z1 - p.z0) * s - 1);
    }
    const ROAD: Record<string, string> = { api: '#ff9f1c', message: '#2bffb0', data: '#b57cff' };
    for (const r of this.roads) {
      c.strokeStyle = ROAD[r.kind] ?? '#7fe3ff';
      c.globalAlpha = 0.75;
      c.lineWidth = Math.max(2, r.width * s);
      c.lineJoin = 'round';
      c.beginPath();
      r.pts.forEach((p, k) => (k ? c.lineTo(X(p[0]), Z(p[1])) : c.moveTo(X(p[0]), Z(p[1]))));
      c.stroke();
      c.globalAlpha = 1;
    }
    for (const b of this.boxes) {
      const studied = this.st.studied(b.i), seen = studied || this.st.seen(b.i);
      c.fillStyle = studied ? '#36e0ff' : seen ? '#1d5f7e' : '#0d1c2a';
      const x = X(b.x0), z = Z(b.z0), w = Math.max(1, (b.x1 - b.x0) * s), d = Math.max(1, (b.z1 - b.z0) * s);
      c.fillRect(x, z, w, d);
      if (studied) { c.strokeStyle = '#c9fbff'; c.lineWidth = 1.5; c.strokeRect(x + 0.75, z + 0.75, w - 1.5, d - 1.5); }
      else if (seen) { c.strokeStyle = 'rgba(95, 240, 255, 0.45)'; c.lineWidth = 1; c.strokeRect(x + 0.5, z + 0.5, w - 1, d - 1); }
    }
    // fog: a faint scanline veil
    c.fillStyle = 'rgba(54, 224, 255, 0.025)';
    for (let y = 0; y < this.base.height; y += 4) c.fillRect(0, y, this.base.width, 1);
    this.dirty = false;
  }

  private markerPath(c: CanvasRenderingContext2D, m: MapMarker, x: number, y: number, r: number) {
    c.save();
    c.translate(x, y);
    switch (m.kind) {
      case 'shard': case 'gold': {
        c.fillStyle = m.kind === 'gold' ? '#ffd23c' : '#ff3cd0';
        c.shadowColor = c.fillStyle; c.shadowBlur = r;
        c.beginPath(); c.moveTo(0, -r); c.lineTo(r * 0.7, 0); c.lineTo(0, r); c.lineTo(-r * 0.7, 0); c.closePath(); c.fill();
        break;
      }
      case 'terminal':
        c.fillStyle = '#0a1a24'; c.strokeStyle = '#ffd23c'; c.lineWidth = Math.max(1, r * 0.18);
        c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.fill(); c.stroke();
        c.fillStyle = '#ffd23c'; c.font = `700 ${Math.round(r * 1.3)}px ui-monospace, monospace`; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText('?', 0, r * 0.08);
        break;
      case 'tour':
        c.fillStyle = 'rgba(210, 60, 255, 0.9)'; c.strokeStyle = '#f3c8ff'; c.lineWidth = Math.max(1, r * 0.15);
        c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.fill(); c.stroke();
        c.fillStyle = '#fff'; c.font = `700 ${Math.round(r * 1.1)}px ui-monospace, monospace`; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(m.label ?? '', 0, r * 0.06);
        break;
      case 'quest':
        c.strokeStyle = '#ffd23c'; c.lineWidth = Math.max(1.5, r * 0.25);
        c.beginPath(); c.arc(0, 0, r * 1.25, 0, Math.PI * 2); c.stroke();
        break;
    }
    c.restore();
  }

  private drawPlayer(c: CanvasRenderingContext2D, x: number, y: number, ang: number, r: number) {
    c.save();
    c.translate(x, y);
    c.rotate(ang);
    c.fillStyle = '#ffffff'; c.strokeStyle = '#36e0ff'; c.lineWidth = Math.max(1, r * 0.2);
    c.shadowColor = '#36e0ff'; c.shadowBlur = r * 1.5;
    c.beginPath(); c.moveTo(0, -r * 1.3); c.lineTo(r * 0.85, r); c.lineTo(0, r * 0.45); c.lineTo(-r * 0.85, r); c.closePath();
    c.fill(); c.stroke();
    c.restore();
  }

  /** Minimap: centred on the player, turned so the camera looks up. */
  drawMini(cv: HTMLCanvasElement, radius: number) {
    if (this.dirty) this.render();
    const c = cv.getContext('2d')!;
    const W = cv.width, R = W / 2;
    const p = this.st.player();
    const k = R / radius; // canvas px per world unit
    c.save();
    c.clearRect(0, 0, W, W);
    c.beginPath(); c.arc(R, R, R - 1, 0, Math.PI * 2); c.clip();
    c.fillStyle = BG; c.fillRect(0, 0, W, W);
    c.translate(R, R);
    c.rotate(p.yaw);
    c.scale(k / this.scale, k / this.scale);
    c.translate(-(p.x - this.minX) * this.scale, -(p.z - this.minZ) * this.scale);
    c.imageSmoothingEnabled = true;
    c.drawImage(this.base, 0, 0);
    c.restore();
    // markers in screen space (upright)
    const toScreen = (x: number, z: number) => {
      const dx = (x - p.x) * k, dz = (z - p.z) * k;
      const cs = Math.cos(p.yaw), sn = Math.sin(p.yaw);
      return [R + dx * cs - dz * sn, R + dx * sn + dz * cs] as const;
    };
    for (const m of this.st.markers()) {
      let [x, y] = toScreen(m.x, m.z);
      const d = Math.hypot(x - R, y - R);
      if (d > R - 8) { // clamp to the rim so targets stay visible
        if (m.kind !== 'tour' && m.kind !== 'quest') continue;
        x = R + ((x - R) / d) * (R - 8); y = R + ((y - R) / d) * (R - 8);
      }
      this.markerPath(c, m, x, y, m.kind === 'tour' ? 7 : 5);
    }
    // the player always points along the body heading, relative to the camera
    this.drawPlayer(c, R, R, p.yaw + Math.PI - p.heading, 6);
    c.strokeStyle = 'rgba(95, 240, 255, 0.7)'; c.lineWidth = 2;
    c.beginPath(); c.arc(R, R, R - 1, 0, Math.PI * 2); c.stroke();
    // north tick
    const [nx, ny] = [R + Math.sin(p.yaw) * (R - 9), R - Math.cos(p.yaw) * (R - 9)]; // world -z, rotated like the map
    c.fillStyle = '#ff3cd0'; c.font = '700 11px ui-monospace, monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('N', nx, ny);
  }

  // ------------------------------------------------------------------ full map

  openFull(parent: HTMLElement, opts: { title: () => string; legend: string; name: (i: number) => string; pick: (i: number) => void; close: () => void }) {
    this.closeFull();
    const el = document.createElement('div');
    el.className = 'wmap';
    const head = document.createElement('div');
    head.className = 'wmap-head';
    const tip = document.createElement('div');
    tip.className = 'wmap-tip';
    const cv = document.createElement('canvas');
    const legend = document.createElement('div');
    legend.className = 'wmap-legend';
    legend.innerHTML = opts.legend;
    const close = document.createElement('button');
    close.className = 'wmap-close';
    close.textContent = 'Close (M)';
    close.onclick = () => opts.close();
    el.append(head, cv, legend, tip, close);
    parent.append(el);
    this.full = el;
    this.fullCanvas = cv;
    const fit = () => {
      const avail = Math.min(innerWidth * 0.92, innerHeight * 0.8);
      const k = avail / Math.max(this.w, this.h);
      cv.width = Math.round(this.w * k * devicePixelRatio);
      cv.height = Math.round(this.h * k * devicePixelRatio);
      cv.style.width = `${Math.round(this.w * k)}px`;
      cv.style.height = `${Math.round(this.h * k)}px`;
    };
    fit();
    const toWorld = (e: MouseEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: this.minX + ((e.clientX - r.left) / r.width) * this.w, z: this.minZ + ((e.clientY - r.top) / r.height) * this.h };
    };
    const at = (x: number, z: number) => this.boxes.find(b => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1)?.i ?? -1;
    cv.onmousemove = e => {
      const p = toWorld(e);
      this.hover = at(p.x, p.z);
      if (this.hover >= 0) {
        tip.textContent = `${opts.name(this.hover)}  ·  click to travel`;
        tip.style.left = `${e.clientX + 14}px`; tip.style.top = `${e.clientY + 12}px`;
        tip.classList.add('on');
        cv.style.cursor = 'pointer';
      } else { tip.classList.remove('on'); cv.style.cursor = 'default'; }
    };
    cv.onmouseleave = () => { this.hover = -1; tip.classList.remove('on'); };
    cv.onclick = e => { const p = toWorld(e); const i = at(p.x, p.z); if (i >= 0) opts.pick(i); };
    head.textContent = opts.title();
    this.headEl = head;
    this.titleFn = opts.title;
  }

  private headEl: HTMLElement | null = null;
  private titleFn: (() => string) | null = null;

  closeFull() {
    this.full?.remove();
    this.full = null; this.fullCanvas = null; this.hover = -1;
  }

  /** Redraw the open full map (call every frame while it is open). */
  drawFull(time: number) {
    const cv = this.fullCanvas;
    if (!cv) return;
    if (this.dirty) this.render();
    const c = cv.getContext('2d')!;
    const k = cv.width / this.w; // px per world unit
    c.imageSmoothingEnabled = true;
    c.drawImage(this.base, 0, 0, cv.width, cv.height);
    const X = (x: number) => (x - this.minX) * k, Z = (z: number) => (z - this.minZ) * k;
    if (this.hover >= 0) {
      const b = this.boxes.find(x => x.i === this.hover);
      if (b) { c.strokeStyle = '#ffffff'; c.lineWidth = 2 * devicePixelRatio; c.strokeRect(X(b.x0), Z(b.z0), (b.x1 - b.x0) * k, (b.z1 - b.z0) * k); }
    }
    // district names
    const fs = Math.round(12 * devicePixelRatio);
    c.font = `600 ${fs}px ui-monospace, monospace`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const l of this.labels) {
      const x = X(l.x), y = Z(l.z);
      const tw = c.measureText(l.text).width + fs;
      c.fillStyle = 'rgba(2, 8, 14, 0.75)';
      c.fillRect(x - tw / 2, y - fs * 0.8, tw, fs * 1.6);
      c.fillStyle = '#9ff4ff';
      c.fillText(l.text, x, y);
    }
    const r = 7 * devicePixelRatio;
    for (const m of this.st.markers()) this.markerPath(c, m, X(m.x), Z(m.z), m.kind === 'tour' ? r * 1.2 : r);
    const p = this.st.player();
    const pulse = 1 + 0.25 * Math.sin(time * 6);
    this.drawPlayer(c, X(p.x), Z(p.z), Math.PI - p.heading, r * pulse);
    if (this.headEl && this.titleFn) this.headEl.textContent = this.titleFn();
  }
}
