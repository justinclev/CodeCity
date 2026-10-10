import * as THREE from 'three';
import { commentToken, tokenize } from '../code';

const COLORS: Record<string, string> = { k: '#d23cff', s: '#7dffb0', c: '#3f8fa6', n: '#ffd23c', f: '#5ff0ff', t: '#ff8adf', '': '#bff8ff' };

export interface WallHit { line: number; col: number; token: string | null }

/**
 * A wall of glowing source code. Renders a window of `rows` lines starting at
 * `scroll` into a canvas texture; supports scrolling, a highlighted line range
 * and hit-testing (uv → line, column, identifier).
 */
export class CodeWall {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private lines: string[];
  private lc: string;
  scroll = 0;
  readonly rows: number;
  private charW = 0;
  private hover: { line: number; from: number; to: number } | null = null;
  private hl: [number, number] | null = null; // 1-based inclusive range
  private flash = 0;
  private readonly W = 2048;
  private readonly H: number;
  private readonly pad = 64; // left gutter for line numbers

  constructor(width: number, height: number, content: string[], lang: string, private first = 1, rows = 30) {
    this.lines = content;
    this.lc = commentToken(lang);
    this.rows = rows;
    this.H = Math.round(this.W * (height / width));
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false, transparent: true });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
    this.mesh.userData.wall = this;
    this.render();
  }

  get lineCount() { return this.lines.length; }
  private get lh() { return this.H / this.rows; }

  scrollBy(n: number) { this.scrollTo(this.scroll + n); }

  scrollTo(n: number) {
    const max = Math.max(0, this.lines.length - this.rows + 2);
    const v = Math.max(0, Math.min(max, Math.round(n)));
    if (v !== this.scroll) { this.scroll = v; this.render(); }
  }

  /** Highlight a line range (1-based, file numbering) and scroll it into view. */
  highlight(from: number, to: number) {
    this.hl = [from, to];
    this.flash = 1;
    this.scrollTo(from - this.first - 3);
    this.render();
  }

  /** uv (from a raycast) → line/column/identifier under it. */
  hit(uv: THREE.Vector2): WallHit | null {
    const y = (1 - uv.y) * this.H, x = uv.x * this.W;
    const row = Math.floor(y / this.lh);
    const idx = this.scroll + row;
    if (idx < 0 || idx >= this.lines.length || x < this.pad) return null;
    const line = this.lines[idx].replace(/\t/g, '    ');
    const col = Math.floor((x - this.pad - 8) / this.charW);
    let token: string | null = null;
    const re = /[A-Za-z_$][\w$]*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (col >= m.index && col < m.index + m[0].length) {
        token = m[0];
        this.setHover({ line: idx, from: m.index, to: m.index + m[0].length });
        break;
      }
    }
    if (!token) this.setHover(null);
    return { line: idx + this.first, col, token };
  }

  setHover(h: { line: number; from: number; to: number } | null) {
    const same = (!h && !this.hover) || (h && this.hover && h.line === this.hover.line && h.from === this.hover.from);
    if (same) return;
    this.hover = h;
    this.render();
  }

  /** Called every frame: fades the highlight flash. */
  update(dt: number) {
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 0.6);
      if (Math.floor(this.flash * 20) !== Math.floor((this.flash + dt * 0.6) * 20)) this.render();
    }
  }

  private render() {
    const { ctx, W, H } = this;
    const lh = this.lh;
    const fs = Math.floor(lh * 0.72);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,6,16,0.82)';
    ctx.fillRect(0, 0, W, H);
    // scanline grid
    ctx.fillStyle = 'rgba(54,224,255,0.04)';
    for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);
    ctx.font = `500 ${fs}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textBaseline = 'middle';
    this.charW = ctx.measureText('M').width;
    const state = { block: false };
    // replay tokenizer state for lines above the window so block comments stay correct
    for (let i = Math.max(0, this.scroll - 200); i < this.scroll; i++) tokenize(this.lines[i], this.lc, state);
    for (let r = 0; r < this.rows; r++) {
      const i = this.scroll + r;
      if (i >= this.lines.length) break;
      const y = r * lh + lh / 2;
      const no = i + this.first;
      if (this.hl && no >= this.hl[0] && no <= this.hl[1]) {
        ctx.fillStyle = `rgba(210,60,255,${0.16 + 0.3 * this.flash})`;
        ctx.fillRect(0, r * lh, W, lh);
        ctx.fillStyle = '#d23cff';
        ctx.fillRect(0, r * lh, 6, lh);
      }
      ctx.fillStyle = '#2d7d92';
      ctx.textAlign = 'right';
      ctx.fillText(String(no), this.pad - 4, y);
      ctx.textAlign = 'left';
      let x = this.pad + 8;
      const text = this.lines[i].replace(/\t/g, '    ');
      let col = 0;
      for (const [cls, t] of tokenize(text, this.lc, state)) {
        ctx.fillStyle = COLORS[cls] ?? COLORS[''];
        ctx.fillText(t, x, y);
        if (this.hover && this.hover.line === i && col <= this.hover.from && col + t.length >= this.hover.to) {
          const hx = this.pad + 8 + this.hover.from * this.charW;
          ctx.fillStyle = 'rgba(95,240,255,0.25)';
          ctx.fillRect(hx - 2, r * lh + 2, (this.hover.to - this.hover.from) * this.charW + 4, lh - 4);
          ctx.fillStyle = '#5ff0ff';
          ctx.fillRect(hx, r * lh + lh - 5, (this.hover.to - this.hover.from) * this.charW, 3);
        }
        x += ctx.measureText(t).width;
        col += t.length;
        if (x > W) break;
      }
    }
    // scrollbar
    if (this.lines.length > this.rows) {
      const frac = this.rows / this.lines.length;
      const top = (this.scroll / this.lines.length) * H;
      ctx.fillStyle = 'rgba(54,224,255,0.15)';
      ctx.fillRect(W - 14, 0, 8, H);
      ctx.fillStyle = 'rgba(54,224,255,0.7)';
      ctx.fillRect(W - 14, top, 8, Math.max(20, frac * H));
    }
    this.tex.needsUpdate = true;
  }

  dispose() {
    this.tex.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** A wall panel of clickable text rows (directory, file info, references). */
export interface PanelRow { text: string; color?: string; size?: number; action?: () => void; hint?: string }

export class TextPanel {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement('canvas');
  private tex: THREE.CanvasTexture;
  private rowsY: { y0: number; y1: number; row: PanelRow }[] = [];
  private hover = -1;
  private readonly W = 1536;
  private readonly H: number;

  constructor(width: number, height: number, private rows: PanelRow[], private title = '') {
    this.H = Math.round(this.W * (height / width));
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false, transparent: true }));
    this.mesh.userData.panel = this;
    this.render();
  }

  hitRow(uv: THREE.Vector2): PanelRow | null {
    const y = (1 - uv.y) * this.H;
    const i = this.rowsY.findIndex(r => y >= r.y0 && y < r.y1 && r.row.action);
    if (i !== this.hover) { this.hover = i; this.render(); }
    return i >= 0 ? this.rowsY[i].row : null;
  }

  clearHover() { if (this.hover !== -1) { this.hover = -1; this.render(); } }

  private render() {
    const c = this.canvas.getContext('2d')!;
    const { W, H } = this;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(0,6,16,0.85)';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(210,60,255,0.8)';
    c.lineWidth = 4;
    c.strokeRect(8, 8, W - 16, H - 16);
    let y = 30;
    if (this.title) {
      c.font = '700 54px "JetBrains Mono", ui-monospace, monospace';
      c.fillStyle = '#5ff0ff';
      c.textBaseline = 'top';
      c.fillText(this.title, 36, y);
      y += 80;
      c.fillStyle = 'rgba(54,224,255,0.4)';
      c.fillRect(36, y - 14, W - 72, 3);
    }
    this.rowsY = [];
    c.textBaseline = 'top';
    this.rows.forEach((row, i) => {
      const size = row.size ?? 34;
      const h = size * 1.45;
      if (y + h > H - 20) return;
      if (i === this.hover && row.action) {
        c.fillStyle = 'rgba(95,240,255,0.18)';
        c.fillRect(24, y - 4, W - 48, h);
      }
      c.font = `500 ${size}px "JetBrains Mono", ui-monospace, monospace`;
      c.fillStyle = row.color ?? (row.action ? '#bff8ff' : '#7fb8c8');
      const t = row.text.length > 70 ? row.text.slice(0, 69) + '…' : row.text;
      c.fillText((row.action ? '▸ ' : '') + t, 36, y);
      if (row.hint) {
        c.fillStyle = '#2d7d92';
        c.textAlign = 'right';
        c.fillText(row.hint, W - 40, y);
        c.textAlign = 'left';
      }
      this.rowsY.push({ y0: y - 4, y1: y + h - 4, row });
      y += h;
    });
    this.tex.needsUpdate = true;
  }

  dispose() {
    this.tex.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
