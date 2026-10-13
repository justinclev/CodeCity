import { commentToken, tokenize } from '../code';
import { bounds, layered, mindmap } from './layout';
import { EDGE_LABEL, FlowModel, KIND_LABEL, type FEdge, type FlowGraph, type FNode, type VEdge, type View, type VNode } from './model';

/** What the flow view needs from the app. */
export interface FlowHost {
  load(): Promise<FlowGraph>;
  file(path: string, commit: string): Promise<{ content: string; lang: string } | null>;
  showInCity(path: string, line?: number): void;
  onClose(): void;
}

type Place = { view: 'map' } | { view: 'module'; group: string } | { view: 'focus'; node: number; expanded: string[]; depth: number };
type Sel = { kind: 'node'; key: string } | { kind: 'edge'; key: string } | null;

const SVGNS = 'http://www.w3.org/2000/svg';
const NODE_H = 46;
const MAX_W = 320;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function sv<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

let ctx2d: CanvasRenderingContext2D | null = null;
function measure(text: string, font: string) {
  ctx2d ??= document.createElement('canvas').getContext('2d');
  ctx2d!.font = font;
  return ctx2d!.measureText(text).width;
}
const FONT_LABEL = '500 12.5px "JetBrains Mono", ui-monospace, monospace';
const FONT_SUB = '400 11px Inter, system-ui, sans-serif';
const FONT_GLYPH = '600 9.5px Inter, system-ui, sans-serif';

/** Shorten from the left for qualified names (keeps the interesting end), from the right otherwise. */
function fit(text: string, font: string, max: number) {
  if (measure(text, font) <= max) return text;
  const left = /[./:‹]/.test(text);
  let s = text;
  while (s.length > 4 && measure('…' + s, font) > max) s = left ? s.slice(1) : s.slice(0, -1);
  return left ? '…' + s : s + '…';
}

export class FlowView {
  private root = el('div', '');
  private svg = sv('svg');
  private world = sv('g');
  private edgeLayer = sv('g', { class: 'fe-layer' });
  private nodeLayer = sv('g', { class: 'fn-layer' });
  private pulseLayer = sv('g', { class: 'fp-layer' });
  private lanes = el('div', 'fl-lanes');
  private crumbs = el('nav', 'fl-crumbs');
  private index = el('aside', 'fl-index');
  private detail = el('aside', 'fl-detail');
  private status = el('div', 'fl-status');
  private noteEl = el('div', 'fl-note');
  private searchBox = el('input', 'fl-search');
  private results = el('div', 'fl-results');
  private depthEl = el('div', 'fl-depth');
  private backBtn = el('button', 'fl-tool', '‹');
  private fwdBtn = el('button', 'fl-tool', '›');
  private model: FlowModel | null = null;
  private view: View | null = null;
  private history: Place[] = [];
  private at = -1;
  private sel: Sel = null;
  private t = { x: 0, y: 0, k: 1 };
  private nodeEls = new Map<string, SVGGElement>();
  private edgeEls = new Map<string, SVGPathElement>();
  private byKey = new Map<string, VNode>();
  private depth = 0; // system map group depth
  private loadSeq = 0;
  open = false;

  constructor(private host: FlowHost) {
    this.root.id = 'flow';
    this.results.hidden = true;
    this.noteEl.hidden = true;
    this.status.hidden = true;
    this.build();
  }

  // ------------------------------------------------------------------ lifecycle

  async show() {
    if (this.open) return;
    this.open = true;
    document.body.classList.add('flowing');
    document.body.append(this.root);
    this.root.hidden = false;
    if (!this.model) {
      this.setStatus('Reading the code and tracing calls…', true);
      try {
        const g = await this.host.load();
        this.model = new FlowModel(g);
        this.depth = this.model.groupDepth();
        this.syncFilters();
        this.renderIndex();
        this.setStatus('');
        this.go({ view: 'map' });
      } catch (e) {
        this.setStatus(`Could not build the flow graph: ${(e as Error).message}`, false);
        return;
      }
    } else if (this.view) {
      this.fitView(false);
    }
    window.setTimeout(() => this.svg.focus(), 0);
  }

  close() {
    if (!this.open) return;
    this.open = false;
    document.body.classList.remove('flowing');
    this.root.hidden = true;
    this.host.onClose();
  }

  /** Forget the graph (a new city was loaded). */
  reset() {
    this.model = null;
    this.view = null;
    this.history = [];
    this.at = -1;
    this.sel = null;
    if (this.open) { this.open = false; void this.show(); }
  }

  /** Open the view centred on the node at path:line (from the city). */
  async focusPath(path: string, line?: number) {
    await this.show();
    const m = this.model;
    if (!m) return;
    const cands = m.nodes.filter(n => n.path === path && m.isCode(n) && n.kind !== 'class');
    const hit = cands.filter(n => line === undefined || ((n.start ?? 0) <= line && line <= (n.end ?? 0)))
      .sort((a, b) => ((a.end ?? 0) - (a.start ?? 0)) - ((b.end ?? 0) - (b.start ?? 0)))[0] ?? cands[0];
    if (hit) this.focusNode(hit.id, 2);
  }

  /** Open the view centred on a graph node (an entrance or exit chosen in the city). */
  async focusId(id: number) {
    await this.show();
    if (this.model && this.model.nodes[id]) this.focusNode(id, 2);
  }

  private setStatus(text: string, busy = false) {
    this.status.replaceChildren();
    this.status.hidden = !text;
    if (!text) return;
    if (busy) this.status.append(el('span', 'fl-spin'));
    this.status.append(el('span', '', text));
  }

  // ------------------------------------------------------------------ chrome

  private build() {
    const bar = el('header', 'fl-bar');
    const brand = el('div', 'fl-brand');
    brand.append(el('strong', '', 'Flow'), el('span', '', 'how the code runs'));
    this.backBtn.title = 'Back (Backspace)';
    this.fwdBtn.title = 'Forward';
    this.backBtn.onclick = () => this.step(-1);
    this.fwdBtn.onclick = () => this.step(1);
    const hist = el('div', 'fl-hist');
    hist.append(this.backBtn, this.fwdBtn);
    const find = el('div', 'fl-find');
    this.searchBox.type = 'search';
    this.searchBox.placeholder = 'Find a function, route, table…  ( / )';
    this.searchBox.spellcheck = false;
    this.searchBox.oninput = () => this.renderResults();
    this.searchBox.onkeydown = e => {
      const first = this.results.querySelector<HTMLButtonElement>('button');
      if (e.key === 'Enter' && first) { first.click(); e.preventDefault(); }
      if (e.key === 'ArrowDown' && first) { first.focus(); e.preventDefault(); }
      if (e.key === 'Escape') { this.searchBox.value = ''; this.renderResults(); this.svg.focus(); }
      e.stopPropagation();
    };
    this.results.onkeydown = e => {
      const items = [...this.results.querySelectorAll<HTMLButtonElement>('button')];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown') { items[Math.min(items.length - 1, i + 1)]?.focus(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { (i <= 0 ? this.searchBox : items[i - 1]).focus(); e.preventDefault(); }
      if (e.key === 'Escape') { this.searchBox.focus(); }
      e.stopPropagation();
    };
    find.append(this.searchBox, this.results);
    const filters = el('div', 'fl-filters');
    const toggle = (label: string, key: 'state' | 'effects' | 'tests' | 'guesses', title: string) => {
      const b = el('button', 'fl-chip', label);
      b.title = title;
      const sync = () => b.setAttribute('aria-pressed', String(this.model?.filters[key] ?? (key !== 'tests')));
      b.onclick = () => {
        if (!this.model) return;
        this.model.filters[key] = !this.model.filters[key];
        sync();
        this.render(true);
      };
      sync();
      filters.append(b);
      return sync;
    };
    const syncs = [
      toggle('State', 'state', 'Fields and variables that functions write and read'),
      toggle('Side effects', 'effects', 'Files, processes, HTTP calls, databases, storage, console'),
      toggle('Tests', 'tests', 'Include test files'),
      toggle('Name-only links', 'guesses', 'Calls matched by a unique name rather than by types or imports (drawn dashed)'),
    ];
    this.syncFilters = () => syncs.forEach(f => f());
    this.depthEl.title = 'How many steps to follow from the centre';
    const fitBtn = el('button', 'fl-tool', 'Fit');
    fitBtn.title = 'Fit to screen (F)';
    fitBtn.onclick = () => this.fitView(true);
    const close = el('button', 'fl-tool fl-close', 'Back to city');
    close.title = 'Close the flow view (Esc on the map, or D)';
    close.onclick = () => this.close();
    bar.append(brand, hist, this.crumbs, find, filters, this.depthEl, fitBtn, close);

    const stage = el('div', 'fl-stage');
    this.svg.setAttribute('class', 'fl-svg');
    this.svg.setAttribute('tabindex', '0');
    this.svg.setAttribute('role', 'application');
    this.svg.setAttribute('aria-label', 'Flow diagram: drag to pan, wheel to zoom, click a box for its code');
    const defs = sv('defs');
    for (const k of ['call', 'request', 'feeds', 'writes', 'io', 'handles', 'impl', 'hl']) {
      const m = sv('marker', { id: 'fa-' + k, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' });
      m.append(sv('path', { d: 'M0,1 L10,5 L0,9 z', class: 'fa fa-' + k }));
      defs.append(m);
    }
    this.svg.append(defs, this.world);
    this.world.append(this.edgeLayer, this.pulseLayer, this.nodeLayer);
    stage.append(this.lanes, this.svg, this.noteEl, this.status);
    const body = el('div', 'fl-body');
    body.append(this.index, stage, this.detail);
    this.detail.hidden = true;
    this.root.append(bar, body);
    this.root.hidden = true;
    this.bindCanvas(stage);
  }

  private syncFilters = () => {};

  // ------------------------------------------------------------------ navigation

  private go(p: Place, push = true) {
    if (push) {
      this.history = this.history.slice(0, this.at + 1);
      this.history.push(p);
      this.at = this.history.length - 1;
    }
    this.sel = null;
    this.detail.hidden = true;
    this.render(false);
  }

  private get place(): Place { return this.history[this.at] ?? { view: 'map' }; }

  private step(d: number) {
    const k = this.at + d;
    if (k < 0 || k >= this.history.length) return;
    this.at = k;
    this.sel = null;
    this.detail.hidden = true;
    this.render(false);
  }

  /** Centre the mind map on a node and follow its flow `depth` steps to the right (one to the left). */
  focusNode(id: number, depth = 2) {
    const m = this.model!;
    const expanded = new Set<string>();
    const [r, l] = this.sides(id, depth);
    m.autoExpand(id, r, l, expanded);
    this.go({ view: 'focus', node: id, expanded: [...expanded], depth });
    this.select({ kind: 'node', key: 'c:' + id });
    this.fitView(false); // the details panel took some of the width
  }

  private openModule(group: string) { this.go({ view: 'module', group }); }

  // ------------------------------------------------------------------ rendering

  private render(keepCamera: boolean) {
    const m = this.model;
    if (!m) return;
    const p = this.place;
    let v: View;
    if (p.view === 'map') v = m.systemMap();
    else if (p.view === 'module') v = m.moduleView(p.group, this.depth);
    else v = m.focus(p.node, new Set(p.expanded));
    this.view = v;
    for (const n of v.nodes) this.size(n);
    let back = new Set<string>();
    if (v.kind === 'focus') mindmap(v); else back = layered(v).back;
    this.draw(v, back);
    this.renderCrumbs();
    this.renderDepth();
    this.noteEl.textContent = v.note ?? '';
    this.noteEl.hidden = !v.note;
    this.backBtn.disabled = this.at <= 0;
    this.fwdBtn.disabled = this.at >= this.history.length - 1;
    this.lanes.hidden = v.kind === 'focus';
    if (!keepCamera) this.fitView(false);
    else this.applyTransform();
    if (this.sel) this.select(this.sel, false);
    if (!v.nodes.length) {
      this.setStatus(m.g.stats.functions ? 'Nothing to draw with these filters.' : 'No functions found: the flow view reads Go, TypeScript/JavaScript, Python and Rust.');
    } else this.setStatus('');
  }

  /** Box size: the same geometry drawNode uses, so labels fit without being cut. */
  private size(n: VNode) {
    const io = n.lane === 'in' || n.lane === 'out';
    const tx = (io ? 14 : 10) + measure(n.glyph, FONT_GLYPH) + 12 + 9;
    const right = io ? 16 : 12;
    const text = Math.max(measure(n.label, FONT_LABEL), measure(n.sub, FONT_SUB)) + 2;
    n.w = Math.min(MAX_W, Math.max(n.lane === 'code' ? 150 : 110, Math.ceil(tx + text + right)));
    n.h = NODE_H + (n.kind === 'module' ? 4 : 0);
  }

  private draw(v: View, back: Set<string>) {
    this.edgeLayer.replaceChildren();
    this.nodeLayer.replaceChildren();
    this.pulseLayer.replaceChildren();
    this.nodeEls.clear();
    this.edgeEls.clear();
    this.byKey = new Map(v.nodes.map(n => [n.key, n]));
    const maxCount = Math.max(1, ...v.edges.map(e => e.count));
    for (const e of v.edges) {
      const a = this.byKey.get(e.from), b = this.byKey.get(e.to);
      if (!a || !b) continue;
      const d = edgePath(a, b);
      // loops against the main direction (dependency cycles) stay faint until hovered or selected
      const isBack = back.has(e.from + '>' + e.to) || (v.kind !== 'focus' && b.x <= a.x + a.w + 20);
      const cls = `fe fe-${e.kind}${e.exact ? '' : ' fe-guess'}${isBack ? ' fe-back' : ''}`;
      const width = v.kind === 'focus' ? 1.5 : 1.2 + 3.2 * Math.log1p(e.count) / Math.log1p(maxCount);
      const path = sv('path', { d, class: cls, 'stroke-width': width.toFixed(2), 'marker-end': `url(#fa-${markerOf(e.kind)})`, id: 'fe-' + hash(e.key) });
      const hit = sv('path', { d, class: 'fe-hit' });
      const g = sv('g', { class: 'fe-g' });
      g.append(path, hit);
      if (e.count > 1 && v.kind !== 'focus') {
        const mid = midpoint(a, b);
        const t = sv('text', { x: mid.x, y: mid.y - 5, class: 'fe-count' });
        t.textContent = String(e.count);
        g.append(t);
      }
      const title = sv('title');
      title.textContent = this.edgeTitle(e);
      g.append(title);
      g.addEventListener('click', ev => { ev.stopPropagation(); this.select({ kind: 'edge', key: e.key }); });
      this.edgeLayer.append(g);
      this.edgeEls.set(e.key, path);
    }
    for (const n of v.nodes) this.nodeLayer.append(this.drawNode(n, v));
    this.drawLanes(v);
  }

  private drawNode(n: VNode, v: View): SVGGElement {
    const g = sv('g', { class: `fn lane-${n.lane} k-${n.kind.split(' ')[0]}${n.ghost ? ' ghost' : ''}${n.key === v.center ? ' center' : ''}`, transform: `translate(${n.x},${n.y})`, tabindex: 0 });
    g.setAttribute('role', 'button');
    const io = n.lane === 'in' || n.lane === 'out';
    g.append(sv('rect', { class: 'fn-box', width: n.w, height: n.h, rx: io ? n.h / 2 : n.kind === 'module' ? 10 : 6 }));
    // jacks: inputs plug in on the left, outputs leave on the right
    if (n.lane === 'in') g.append(sv('circle', { class: 'fn-jack', cx: 0, cy: n.h / 2, r: 4 }));
    if (n.lane === 'out') g.append(sv('circle', { class: 'fn-jack', cx: n.w, cy: n.h / 2, r: 4 }));
    const gw = measure(n.glyph, FONT_GLYPH) + 12;
    const left = io ? 14 : 10;
    g.append(sv('rect', { class: 'fn-glyph', x: left, y: n.h / 2 - 9, width: gw, height: 18, rx: 4 }));
    const gt = sv('text', { class: 'fn-glyph-t', x: left + gw / 2, y: n.h / 2 + 3.5 });
    gt.textContent = n.glyph;
    const tx = left + gw + 9;
    const room = n.w - tx - (io ? 16 : 12) + 2;
    const lt = sv('text', { class: 'fn-label', x: tx, y: n.h / 2 - 3 });
    lt.textContent = fit(n.label, FONT_LABEL, room);
    const st = sv('text', { class: 'fn-sub', x: tx, y: n.h / 2 + 13 });
    st.textContent = fit(n.ghost ? 'shown elsewhere — click to go there' : n.sub, FONT_SUB, room);
    g.append(gt, lt, st);
    const title = sv('title');
    title.textContent = `${n.label}\n${n.sub}`;
    g.append(title);
    // expand knobs (mind map)
    if (n.more?.right && n.side !== -1) g.append(this.knob(n, 1, n.more.right));
    if (n.more?.left && n.side !== 1) g.append(this.knob(n, -1, n.more.left));
    if (v.kind === 'focus' && n.side && !n.ghost && this.isOpen(n)) g.append(this.knob(n, n.side, 0));
    g.addEventListener('click', ev => { ev.stopPropagation(); this.onNodeClick(n); });
    g.addEventListener('dblclick', ev => { ev.stopPropagation(); this.drill(n); });
    g.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); ev.shiftKey ? this.drill(n) : this.onNodeClick(n); }
    });
    g.addEventListener('pointerenter', () => this.hover(n.key));
    g.addEventListener('pointerleave', () => this.hover(null));
    this.nodeEls.set(n.key, g);
    return g;
  }

  private isOpen(n: VNode) {
    const p = this.place;
    return p.view === 'focus' && n.node !== undefined && p.expanded.includes(`${n.side}:${n.node}`);
  }

  private knob(n: VNode, side: 1 | -1, count: number) {
    const g = sv('g', { class: 'fn-knob' + (count ? '' : ' open'), transform: `translate(${side > 0 ? n.w + 13 : -13},${n.h / 2})` });
    g.append(sv('circle', { r: 10 }));
    const t = sv('text', { y: 3.5 });
    t.textContent = count ? (count > 99 ? '99+' : '+' + count) : '−';
    g.append(t);
    const title = sv('title');
    title.textContent = count ? `Show ${count} ${side > 0 ? 'next steps' : 'callers / sources'}` : 'Collapse';
    g.append(title);
    g.addEventListener('click', ev => {
      ev.stopPropagation();
      if (this.view?.kind === 'focus') this.toggleBranch(n, side);
      else if (n.node !== undefined) this.focusNode(n.node, 2);
    });
    return g;
  }

  private toggleBranch(n: VNode, side: 1 | -1) {
    const p = this.place;
    if (p.view !== 'focus' || n.node === undefined) return;
    const k = `${side}:${n.node}`;
    const set = new Set(p.expanded);
    if (set.has(k)) set.delete(k); else set.add(k);
    p.expanded = [...set];
    this.render(true);
  }

  private drawLanes(v: View) {
    this.lanes.replaceChildren();
    if (v.kind === 'focus') return;
    for (const [lane, text] of [['in', 'Comes in'], ['code', v.kind === 'map' ? 'Modules' : 'Code'], ['out', 'Goes out']] as const) {
      const xs = v.nodes.filter(n => n.lane === lane).map(n => n.x + n.w / 2);
      if (!xs.length) continue;
      const lab = el('div', 'fl-lane fl-lane-' + lane, text);
      lab.dataset.x = String(lane === 'in' ? Math.min(...xs) : lane === 'out' ? Math.max(...xs) : (Math.min(...xs) + Math.max(...xs)) / 2);
      this.lanes.append(lab);
    }
  }

  private positionLanes() {
    for (const lab of this.lanes.children as HTMLCollectionOf<HTMLElement>) {
      const x = Number(lab.dataset.x) * this.t.k + this.t.x;
      lab.style.transform = `translateX(${Math.round(x)}px) translateX(-50%)`;
    }
  }

  private edgeTitle(e: VEdge) {
    const a = this.byKey.get(e.from)!, b = this.byKey.get(e.to)!;
    const verb = EDGE_LABEL[e.kind] ?? e.kind;
    return `${a.label} ${verb} ${b.label}${e.count > 1 ? ` (${e.count})` : ''}${e.exact ? '' : ' — matched by name only'}`;
  }

  // ------------------------------------------------------------------ selection, hover, pulses

  private onNodeClick(n: VNode) {
    if (n.ghost && n.node !== undefined) {
      // jump to where it is drawn in full
      const real = this.view?.nodes.find(x => x.node === n.node && !x.ghost);
      if (real) { this.select({ kind: 'node', key: real.key }); this.centerOn(real); return; }
    }
    this.select({ kind: 'node', key: n.key });
  }

  private drill(n: VNode) {
    if (n.kind === 'module' && n.group !== undefined && this.view?.kind === 'map') { this.openModule(n.group); return; }
    if (n.kind === 'module outside' && n.group !== undefined) { this.openModule(n.group); return; }
    if (n.node !== undefined) this.focusNode(n.node, 2);
    else if (n.members?.length === 1) this.focusNode(n.members[0], 2);
  }

  private select(s: Sel, scroll = true) {
    this.sel = s;
    for (const g of this.nodeEls.values()) g.classList.remove('sel');
    for (const p of this.edgeEls.values()) p.classList.remove('sel', 'hl');
    this.pulseLayer.replaceChildren();
    if (!s || !this.view) { this.detail.hidden = true; return; }
    const v = this.view;
    if (s.kind === 'node') {
      const n = this.byKey.get(s.key);
      if (!n) { this.detail.hidden = true; return; }
      this.nodeEls.get(n.key)?.classList.add('sel');
      const touching = v.edges.filter(e => e.from === n.key || e.to === n.key);
      for (const e of touching) this.edgeEls.get(e.key)?.classList.add('hl');
      this.pulses(touching);
      void this.showNode(n, touching);
    } else {
      const e = v.edges.find(x => x.key === s.key);
      if (!e) { this.detail.hidden = true; return; }
      this.edgeEls.get(e.key)?.classList.add('sel');
      this.pulses([e]);
      void this.showEdge(e);
    }
    void scroll;
  }

  /** Signals travelling along the selected edges, in the direction of the flow. */
  private pulses(edges: VEdge[]) {
    if (reduceMotion()) return;
    for (const e of edges.slice(0, 40)) {
      const path = this.edgeEls.get(e.key);
      if (!path) continue;
      const len = path.getTotalLength();
      const dur = Math.max(0.9, len / 160);
      for (let k = 0; k < 2; k++) {
        const c = sv('circle', { r: 3, class: 'fpulse fpulse-' + e.kind });
        const anim = sv('animateMotion', { dur: dur + 's', repeatCount: 'indefinite', begin: (k * dur / 2).toFixed(2) + 's' });
        const mp = sv('mpath');
        mp.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#' + path.id);
        mp.setAttribute('href', '#' + path.id);
        anim.append(mp);
        c.append(anim);
        this.pulseLayer.append(c);
      }
    }
  }

  private hover(key: string | null) {
    this.svg.classList.toggle('hovering', !!key);
    for (const [k, p] of this.edgeEls) {
      const e = this.view!.edges.find(x => x.key === k)!;
      p.classList.toggle('hov', !!key && (e.from === key || e.to === key));
    }
    for (const [k, g] of this.nodeEls) {
      const near = !!key && (k === key || this.view!.edges.some(e => (e.from === key && e.to === k) || (e.to === key && e.from === k)));
      g.classList.toggle('hov', near);
    }
  }

  // ------------------------------------------------------------------ detail panel

  private panelHead(title: string, kind: string, sub: string, glyph: string, lane: string) {
    this.detail.replaceChildren();
    this.detail.hidden = false;
    const head = el('div', 'fd-head');
    const chip = el('span', `fd-glyph lane-${lane}`, glyph);
    const h = el('h2', '', title);
    const x = el('button', 'fd-x', '×');
    x.title = 'Close (Esc)';
    x.setAttribute('aria-label', 'Close details');
    x.onclick = () => this.select(null);
    head.append(chip, h, x);
    this.detail.append(head);
    if (kind || sub) this.detail.append(el('div', 'fd-sub', [kind, sub].filter(Boolean).join(' — ')));
  }

  private actions(list: [string, () => void, boolean?][]) {
    const row = el('div', 'fd-actions');
    for (const [label, fn, primary] of list) {
      const b = el('button', primary ? 'fd-btn primary' : 'fd-btn', label);
      b.onclick = fn;
      row.append(b);
    }
    this.detail.append(row);
  }

  private async showNode(n: VNode, touching: VEdge[]) {
    const m = this.model!;
    if (n.node === undefined) { this.showGroup(n, touching); return; }
    const f = m.nodes[n.node];
    const kind = (KIND_LABEL[f.kind] ?? f.kind) + (f.sub === 'closure' ? ' (inline handler)' : f.sub === 'module' ? ' (runs on load)' : f.sub === 'interface' ? ' (interface)' : '');
    this.panelHead(m.label(f), f.kind === 'endpoint' ? `${f.sub && f.sub !== 'ANY' ? f.sub + ' ' : ''}HTTP route` : kind, f.path ? `${f.path}${f.start ? ':' + f.start : ''}` : m.where(f), n.glyph, n.lane);
    const acts: [string, () => void, boolean?][] = [];
    if (!(this.view?.kind === 'focus' && n.key === this.view.center)) acts.push(['Centre on this', () => this.focusNode(f.id, 2), true]);
    else acts.push(['Follow further', () => this.deepen(1), true]);
    if (f.path) acts.push(['Show in city', () => this.host.showInCity(f.path!, f.start)]);
    this.actions(acts);
    if (f.path && f.start && m.isCode(f)) {
      const lines = new Set<number>();
      await this.snippet(f.path, f.start, f.end ?? f.start, lines);
    } else if (f.kind === 'data' && f.path) {
      await this.snippet(f.path, Math.max(1, (f.start ?? 1) - 2), (f.start ?? 1) + 4, new Set([f.start ?? 1]));
    }
    this.connections(f);
  }

  /** How far to follow each side: outputs and state are traced backwards (what causes them), the rest forwards. */
  private sides(id: number, depth: number): [number, number] {
    const m = this.model!;
    const n = m.nodes[id];
    const sink = (n.kind === 'io' && !m.source[id]) || n.kind === 'data' && !m.out[id].length;
    return sink ? [1, depth] : [depth, 1];
  }

  private deepen(d: number) {
    const p = this.place;
    if (p.view !== 'focus') return;
    const depth = Math.max(1, Math.min(6, p.depth + d));
    const ex = new Set<string>();
    const [r, l] = this.sides(p.node, depth);
    this.model!.autoExpand(p.node, r, l, ex);
    p.depth = depth;
    p.expanded = [...ex];
    this.render(false);
    this.select({ kind: 'node', key: 'c:' + p.node });
  }

  /** Grouped box (module, routes group, …): what it contains and what it connects to. */
  private showGroup(n: VNode, touching: VEdge[]) {
    const m = this.model!;
    const isModule = n.kind === 'module' || n.kind === 'module outside';
    this.panelHead(n.label, isModule ? 'module' : 'group', n.sub, n.glyph, n.lane);
    const acts: [string, () => void, boolean?][] = [];
    if (isModule && n.group !== undefined) acts.push(['Open module', () => this.openModule(n.group!), true]);
    this.actions(acts);
    let members: FNode[];
    if (isModule && n.group !== undefined) {
      members = m.nodes.filter(x => m.isCode(x) && x.kind !== 'class' && m.nodeVisible(x) && m.groupOf(x, this.depth) === n.group);
      const deg = (x: FNode) => m.out[x.id].length + m.inn[x.id].length;
      members.sort((a, b) => deg(b) - deg(a));
      this.list(n.kind === 'module' ? 'Busiest functions' : 'Functions', members.slice(0, 14), x => `${m.inn[x.id].length} in, ${m.out[x.id].length} out`);
    } else {
      members = (n.members ?? []).map(i => m.nodes[i]);
      this.list('Members', members.slice(0, 40), x => m.where(x));
    }
    const sum = (dir: 'in' | 'out') => {
      const rows = touching.filter(e => (dir === 'in' ? e.to : e.from) === n.key)
        .sort((a, b) => b.count - a.count).slice(0, 12)
        .map(e => ({ v: this.byKey.get(dir === 'in' ? e.from : e.to)!, e }));
      if (!rows.length) return;
      const sec = el('section', 'fd-sec');
      sec.append(el('h3', '', dir === 'in' ? 'Comes from' : 'Goes to'));
      for (const { v, e } of rows) {
        const b = el('button', 'fd-row');
        b.append(el('span', 'fd-row-name', v.label), el('span', 'fd-row-meta', `${EDGE_LABEL[e.kind] ?? e.kind} · ${e.count}`));
        b.onclick = () => this.select({ kind: 'edge', key: e.key });
        sec.append(b);
      }
      this.detail.append(sec);
    };
    sum('in');
    sum('out');
  }

  private list(title: string, nodes: FNode[], meta: (n: FNode) => string) {
    if (!nodes.length) return;
    const sec = el('section', 'fd-sec');
    sec.append(el('h3', '', title));
    for (const x of nodes) {
      const b = el('button', 'fd-row');
      b.append(el('span', 'fd-row-name', this.model!.label(x)), el('span', 'fd-row-meta', meta(x)));
      b.onclick = () => this.focusNode(x.id, 2);
      sec.append(b);
    }
    this.detail.append(sec);
  }

  /** Calls / called by / state / side effects of a node, each with the lines where it happens. */
  private connections(f: FNode) {
    const m = this.model!;
    const groups: [string, FEdge[], 'out' | 'in'][] = [
      ['Handled by', m.out[f.id].filter(e => e.kind === 'handles'), 'out'],
      ['Calls', m.out[f.id].filter(e => ['call', 'new', 'ref', 'impl', 'request'].includes(e.kind)), 'out'],
      ['Writes', m.out[f.id].filter(e => e.kind === 'writes'), 'out'],
      ['Talks to', m.out[f.id].filter(e => e.kind === 'io'), 'out'],
      ['Read by', m.out[f.id].filter(e => e.kind === 'feeds'), 'out'],
      ['Triggered by', m.inn[f.id].filter(e => e.kind === 'handles'), 'in'],
      ['Called by', m.inn[f.id].filter(e => ['call', 'new', 'ref', 'impl', 'request'].includes(e.kind)), 'in'],
      ['Reads', m.inn[f.id].filter(e => e.kind === 'feeds'), 'in'],
      ['Written by', m.inn[f.id].filter(e => e.kind === 'writes'), 'in'],
      ['Used by', m.inn[f.id].filter(e => e.kind === 'io'), 'in'],
    ];
    for (const [title, edges, dir] of groups) {
      const vis = edges.filter(e => m.edgeVisible(e));
      if (!vis.length) continue;
      const sec = el('section', 'fd-sec');
      sec.append(el('h3', '', `${title} (${vis.length})`));
      for (const e of vis.slice(0, 60)) {
        const other = m.nodes[dir === 'out' ? e.to : e.from];
        const b = el('button', 'fd-row' + (e.kind === 'call' && !e.exact ? ' guess' : ''));
        const where = e.lines?.length ? `line${e.lines.length > 1 ? 's' : ''} ${e.lines.slice(0, 4).join(', ')}${e.lines.length > 4 ? '…' : ''}` : m.where(other);
        b.append(el('span', 'fd-row-name', m.label(other)), el('span', 'fd-row-meta', (e.label ? e.label + ' · ' : '') + where));
        b.title = e.kind === 'call' && !e.exact ? 'Matched by name only' : '';
        b.onclick = () => this.focusNode(other.id, 2);
        // show the call site in the snippet above
        b.onmouseenter = () => this.markLines(e);
        sec.append(b);
      }
      if (vis.length > 60) sec.append(el('div', 'fd-more', `${vis.length - 60} more`));
      this.detail.append(sec);
    }
  }

  private async showEdge(e: VEdge) {
    const m = this.model!;
    const a = this.byKey.get(e.from)!, b = this.byKey.get(e.to)!;
    this.panelHead(`${a.label} → ${b.label}`, EDGE_LABEL[e.kind] ?? e.kind, e.exact ? '' : 'matched by name only', '→', 'code');
    // call sites, grouped by file
    const sites: { path: string; line: number; e: FEdge }[] = [];
    for (const x of e.edges.slice(0, 60)) {
      const from = m.nodes[x.from];
      const path = x.file ?? from.path;
      if (!path) continue;
      for (const l of (x.lines ?? []).slice(0, 4)) sites.push({ path, line: l, e: x });
    }
    if (!sites.length) {
      this.detail.append(el('p', 'fd-empty', 'No source lines recorded for this link.'));
      return;
    }
    this.detail.append(el('div', 'fd-sub', `${sites.length} place${sites.length === 1 ? '' : 's'} in the code`));
    for (const s of sites.slice(0, 8)) {
      const from = m.nodes[s.e.from], to = m.nodes[s.e.to];
      const cap = el('div', 'fd-site', `${m.label(from)} → ${m.label(to)}  ·  ${s.path}:${s.line}`);
      this.detail.append(cap);
      await this.snippet(s.path, Math.max(1, s.line - 3), s.line + 3, new Set([s.line]), true);
    }
    if (sites.length > 8) this.detail.append(el('div', 'fd-more', `${sites.length - 8} more places`));
  }

  private snippetEl: HTMLElement | null = null;

  /** Source lines [from, to] of path, highlighted, with the given lines marked. */
  private async snippet(path: string, from: number, to: number, mark: Set<number>, compact = false) {
    const m = this.model!;
    const commit = m.commitFor(path);
    const box = el('div', 'fd-code' + (compact ? ' compact' : ''));
    box.textContent = 'loading…';
    this.detail.append(box);
    if (!compact) this.snippetEl = box;
    const seq = ++this.loadSeq;
    const file = commit ? await this.host.file(path, commit).catch(() => null) : null;
    if (!compact && seq !== this.loadSeq) return;
    if (!file) { box.textContent = 'Source not available (needs the server).'; return; }
    const lines = file.content.split('\n');
    const last = Math.min(lines.length, to, from + 400);
    const lc = commentToken(file.lang);
    const state = { block: false };
    // carry block-comment state from the start of the file
    for (let i = 0; i < from - 1 && i < lines.length; i++) tokenize(lines[i], lc, state);
    box.replaceChildren();
    const pre = el('pre');
    for (let ln = from; ln <= last; ln++) {
      const row = el('div', 'fd-line' + (mark.has(ln) ? ' mark' : ''));
      row.dataset.line = String(ln);
      row.append(el('span', 'fd-ln', String(ln)));
      const code = el('span', 'fd-src');
      for (const [cls, text] of tokenize(lines[ln - 1] ?? '', lc, state)) {
        if (!cls) code.append(text);
        else code.append(el('span', 't' + cls, text));
      }
      row.append(code);
      pre.append(row);
    }
    if (to > last) pre.append(el('div', 'fd-more', `… ${to - last} more lines`));
    box.append(pre);
    const first = box.querySelector('.mark');
    if (first && !compact) first.scrollIntoView({ block: 'center' });
  }

  private markLines(e: FEdge) {
    const box = this.snippetEl;
    if (!box) return;
    box.querySelectorAll('.fd-line.mark').forEach(x => x.classList.remove('mark'));
    for (const l of e.lines ?? []) {
      const row = box.querySelector<HTMLElement>(`.fd-line[data-line="${l}"]`);
      if (row) { row.classList.add('mark'); row.scrollIntoView({ block: 'nearest' }); }
    }
  }

  // ------------------------------------------------------------------ index (ways in / ways out)

  private renderIndex() {
    const m = this.model!;
    this.index.replaceChildren();
    const st = m.g.stats;
    const pct = st.calls ? Math.round((st.exact / st.calls) * 100) : 100;
    const summary = el('p', 'fi-sum', `${st.functions.toLocaleString()} functions, ${st.calls.toLocaleString()} calls — ${pct}% resolved exactly.`);
    summary.title = `${st.byName} calls were matched by a unique name only; they are drawn dashed.`;
    this.index.append(summary);
    if (st.truncated) this.index.append(el('p', 'fi-warn', 'The code base is very large: only part of it was analyzed.'));
    const deg = (n: FNode) => m.out[n.id].length + m.inn[n.id].length;
    const section = (title: string, hint: string, nodes: FNode[], limit = 12) => {
      if (!nodes.length) return;
      const det = el('details', 'fi-sec');
      det.open = true;
      const sum = el('summary', '', title);
      sum.append(el('span', 'fi-count', String(nodes.length)));
      det.append(sum);
      if (hint) det.append(el('p', 'fi-hint', hint));
      const items = nodes.sort((a, b) => deg(b) - deg(a) || a.name.localeCompare(b.name));
      const draw = (k: number) => {
        det.querySelectorAll('.fi-row, .fi-moreb').forEach(x => x.remove());
        const seen = new Map<string, number>();
        for (const n of items) seen.set(m.label(n), (seen.get(m.label(n)) ?? 0) + 1);
        for (const n of items.slice(0, k)) {
          const b = el('button', 'fi-row');
          b.append(el('span', `fi-glyph lane-${m.lane(n)}`, m.glyph(n)), el('span', 'fi-name', m.label(n)));
          if ((seen.get(m.label(n)) ?? 0) > 1 && n.path) b.append(el('span', 'fi-dir', n.path.split('/').slice(-3, -1).join('/')));
          b.title = `${n.name} — ${m.where(n)}`;
          b.onclick = () => this.focusNode(n.id, 3);
          det.append(b);
        }
        if (items.length > k) {
          const more = el('button', 'fi-moreb', `Show ${items.length - k} more`);
          more.onclick = () => draw(items.length);
          det.append(more);
        }
      };
      draw(limit);
      this.index.append(det);
    };
    const live = (n: FNode) => deg(n) > 0 && !n.test;
    const entryFile = /^(index|main|app|server|cli|__main__|manage|wsgi|asgi)\.[a-z]+ \(top level\)$/i;
    section('Ways in', 'Where execution starts: click one to trace what it sets off.', [
      ...m.nodes.filter(n => (n.kind === 'endpoint' || n.kind === 'command') && live(n)),
      ...m.nodes.filter(n => n.entry === 'main' && live(n)),
      ...m.nodes.filter(n => n.entry === 'module' && entryFile.test(n.name) && m.out[n.id].length >= 2 && !n.test),
    ]);
    section('Events and timers', '', m.nodes.filter(n => n.kind === 'event' && live(n)), 8);
    section('Inputs read', 'Flags, environment, arguments and files the code reads.', m.nodes.filter(n => (n.kind === 'flag' || (n.kind === 'io' && m.source[n.id])) && live(n)), 8);
    section('Ways out', 'Side effects: what the code changes or talks to outside itself.', m.nodes.filter(n => n.kind === 'io' && !m.source[n.id] && live(n)));
    const writers = (n: FNode) => m.inn[n.id].filter(e => e.kind === 'writes').length;
    section('Shared state', 'Fields and variables written from more than one place.', m.nodes.filter(n => n.kind === 'data' && writers(n) > 1 && !n.test).sort((a, b) => writers(b) - writers(a)), 8);
    const legend = el('div', 'fi-legend');
    legend.innerHTML = '';
    for (const [cls, text] of [['call', 'calls'], ['request', 'HTTP request'], ['writes', 'writes state / output'], ['feeds', 'reads input / state'], ['io', 'talks to a system'], ['guess', 'matched by name only']]) {
      const row = el('div', 'fi-leg');
      const s = sv('svg', { width: 34, height: 10 });
      s.append(sv('path', { d: 'M1,5 L33,5', class: `fe fe-${cls === 'guess' ? 'call fe-guess' : cls}`, 'stroke-width': 2 }));
      row.append(s, el('span', '', text));
      legend.append(row);
    }
    this.index.append(legend);
  }

  private renderResults() {
    const m = this.model;
    this.results.replaceChildren();
    if (!m) return;
    const hits = m.search(this.searchBox.value, 12);
    this.results.hidden = !hits.length;
    for (const n of hits) {
      const b = el('button', 'fl-res');
      b.append(el('span', `fi-glyph lane-${m.lane(n)}`, m.glyph(n)), el('span', 'fi-name', m.label(n)), el('span', 'fl-res-where', m.where(n)));
      b.onclick = () => { this.searchBox.value = ''; this.results.hidden = true; this.focusNode(n.id, 2); this.svg.focus(); };
      this.results.append(b);
    }
  }

  private renderCrumbs() {
    const m = this.model!;
    const p = this.place;
    this.crumbs.replaceChildren();
    const crumb = (text: string, go?: () => void) => {
      const b = el('button', 'fl-crumb', text);
      if (go) b.onclick = go; else b.setAttribute('aria-current', 'page');
      this.crumbs.append(b);
    };
    crumb('System', p.view === 'map' ? undefined : () => this.go({ view: 'map' }));
    if (p.view === 'module') crumb(p.group ? p.group + '/' : '(root)');
    if (p.view === 'focus') {
      const n = m.nodes[p.node];
      if (m.isCode(n) || n.kind === 'data') {
        const g = m.groupOf(n, this.depth);
        crumb(g ? g + '/' : '(root)', () => this.openModule(g));
      }
      crumb(m.label(n));
    }
  }

  private renderDepth() {
    const p = this.place;
    this.depthEl.replaceChildren();
    this.depthEl.hidden = p.view !== 'focus';
    if (p.view !== 'focus') return;
    const minus = el('button', 'fl-tool', '−');
    const plus = el('button', 'fl-tool', '+');
    minus.title = 'Follow fewer steps';
    plus.title = 'Follow more steps';
    minus.onclick = () => this.deepen(-1);
    plus.onclick = () => this.deepen(1);
    minus.disabled = p.depth <= 1;
    plus.disabled = p.depth >= 6;
    this.depthEl.append(el('span', '', 'Steps'), minus, el('strong', '', String(p.depth)), plus);
  }

  // ------------------------------------------------------------------ camera

  private bindCanvas(stage: HTMLElement) {
    let drag: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;
    this.svg.addEventListener('pointerdown', e => {
      if ((e.target as Element).closest('.fn, .fe-g')) return;
      drag = { x: e.clientX, y: e.clientY, tx: this.t.x, ty: this.t.y, moved: false };
      this.svg.setPointerCapture(e.pointerId);
    });
    this.svg.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      this.t.x = drag.tx + dx;
      this.t.y = drag.ty + dy;
      this.applyTransform();
    });
    this.svg.addEventListener('pointerup', () => {
      if (drag && !drag.moved) this.select(null);
      drag = null;
    });
    this.svg.addEventListener('wheel', e => {
      e.preventDefault();
      const r = this.svg.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const k = Math.min(3, Math.max(0.08, this.t.k * Math.exp(-e.deltaY * 0.0015)));
      this.t.x = px - (px - this.t.x) * (k / this.t.k);
      this.t.y = py - (py - this.t.y) * (k / this.t.k);
      this.t.k = k;
      this.applyTransform();
    }, { passive: false });
    this.root.addEventListener('keydown', e => {
      const typing = (e.target as HTMLElement).tagName === 'INPUT';
      if (typing) return;
      if (e.key === '/') { e.preventDefault(); this.searchBox.focus(); }
      else if (e.key === 'Escape') {
        if (this.sel) this.select(null);
        else if (this.at > 0) this.step(-1);
        else this.close();
      } else if (e.key === 'Backspace') { e.preventDefault(); this.step(-1); }
      else if (e.key === 'f' || e.key === 'F') this.fitView(true);
      else if (e.key === 'd' || e.key === 'D') this.close();
      else if (e.key === '+' || e.key === '=') this.zoom(1.25);
      else if (e.key === '-') this.zoom(0.8);
      e.stopPropagation();
    });
    new ResizeObserver(() => { if (this.open) this.positionLanes(); }).observe(stage);
  }

  private zoom(f: number) {
    const r = this.svg.getBoundingClientRect();
    const px = r.width / 2, py = r.height / 2;
    const k = Math.min(3, Math.max(0.08, this.t.k * f));
    this.t.x = px - (px - this.t.x) * (k / this.t.k);
    this.t.y = py - (py - this.t.y) * (k / this.t.k);
    this.t.k = k;
    this.applyTransform();
  }

  private applyTransform() {
    this.world.setAttribute('transform', `translate(${this.t.x},${this.t.y}) scale(${this.t.k})`);
    this.positionLanes();
  }

  private fitView(animate: boolean) {
    const v = this.view;
    if (!v || !v.nodes.length) return;
    const r = this.svg.getBoundingClientRect();
    const W = r.width || innerWidth, H = r.height || innerHeight;
    const b = bounds(v.nodes);
    const pad = 60;
    const fitK = Math.min((W - pad * 2) / (b.x1 - b.x0 + 40), (H - pad * 2 - 30) / (b.y1 - b.y0 + 40));
    // stay readable: below ~55% the labels are noise; then start at the inputs and let the reader pan
    const k = Math.min(1.15, Math.max(v.kind === 'focus' ? 0.62 : 0.55, fitK));
    const target = { k, x: W / 2 - ((b.x0 + b.x1) / 2) * k, y: (H + 30) / 2 - ((b.y0 + b.y1) / 2) * k };
    if ((b.x1 - b.x0) * k > W - pad * 2) {
      const c = v.center ? v.nodes.find(n => n.key === v.center) : null;
      target.x = c ? W / 2 - (c.x + c.w / 2) * k : pad - b.x0 * k;
    }
    if ((b.y1 - b.y0) * k > H - pad * 2) {
      const c = v.center ? v.nodes.find(n => n.key === v.center) : null;
      target.y = c ? H / 2 - (c.y + c.h / 2) * k : pad + 30 - b.y0 * k;
    }
    if (!animate || reduceMotion()) { this.t = target; this.applyTransform(); return; }
    const from = { ...this.t };
    const t0 = performance.now();
    const stepFn = (now: number) => {
      const p = Math.min(1, (now - t0) / 320);
      const e = 1 - Math.pow(1 - p, 3);
      this.t = { k: from.k + (target.k - from.k) * e, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e };
      this.applyTransform();
      if (p < 1) requestAnimationFrame(stepFn);
    };
    requestAnimationFrame(stepFn);
  }

  private centerOn(n: VNode) {
    const r = this.svg.getBoundingClientRect();
    this.t.x = r.width / 2 - (n.x + n.w / 2) * this.t.k;
    this.t.y = r.height / 2 - (n.y + n.h / 2) * this.t.k;
    this.applyTransform();
  }
}

// ------------------------------------------------------------------ geometry

function edgePath(a: VNode, b: VNode): string {
  const sx = a.x + a.w, sy = a.y + a.h / 2;
  const tx = b.x, ty = b.y + b.h / 2;
  if (tx > sx + 20) {
    const dx = Math.max(40, (tx - sx) * 0.5);
    return `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx - 2},${ty}`;
  }
  // backwards (cycles, requests back to a route): loop under the boxes
  const bottom = Math.max(a.y + a.h, b.y + b.h) + 36 + Math.abs(sx - tx) * 0.08;
  return `M${sx},${sy} C${sx + 70},${sy} ${sx + 70},${bottom} ${(sx + tx) / 2},${bottom} S${tx - 70},${ty} ${tx - 2},${ty}`;
}

function midpoint(a: VNode, b: VNode) {
  const sx = a.x + a.w, sy = a.y + a.h / 2, tx = b.x, ty = b.y + b.h / 2;
  if (tx > sx + 20) return { x: (sx + tx) / 2, y: (sy + ty) / 2 };
  return { x: (sx + tx) / 2, y: Math.max(a.y + a.h, b.y + b.h) + 36 + Math.abs(sx - tx) * 0.08 };
}

function markerOf(kind: string) {
  return ['call', 'request', 'feeds', 'writes', 'io', 'handles', 'impl'].includes(kind) ? kind : 'call';
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
