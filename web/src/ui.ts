import { authorColor, AUTHOR_COLORS, languageColor } from './colors';
import type { Insights } from './insights';
import { RISK, RISK_COLORS, type Totals } from './scene';
import type { City, ColorMode, Metric, ScaleMode } from './types';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const fmt = (n: number) => n.toLocaleString('en-US');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string | number): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = String(text);
  return e;
}

export function ago(unix: number, now: number): string {
  if (!unix) return 'unknown';
  const d = Math.max(0, now - unix) / 86400;
  if (d < 1) return 'within a day';
  if (d < 45) return `${Math.round(d)} days ago`;
  if (d < 540) return `${Math.round(d / 30)} months ago`;
  return `${(d / 365).toFixed(1)} years ago`;
}
const day = (unix: number) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : '');

// ------------------------------------------------------------------ status

export function setMessage(text: string) { $('msg').textContent = text; }

export function setJobStatus(text: string, isError = false) {
  const s = $('jobstatus');
  s.textContent = text;
  s.className = isError ? 'err' : '';
}

export function setProgress(p: { done: number; total: number } | null) {
  const box = $('progress');
  box.hidden = !p;
  if (!p) return;
  box.classList.toggle('indeterminate', !p.total);
  $('bar').style.width = p.total ? `${Math.round((p.done / p.total) * 100)}%` : '';
}

export function setBusy(busy: boolean) {
  $<HTMLButtonElement>('go').disabled = busy;
  $('cancel').hidden = !busy;
}

export function setTheme(name: 'night' | 'day' | 'hacker') {
  document.body.classList.toggle('day', name === 'day');
  document.body.classList.toggle('hacker', name === 'hacker');
  $('theme').textContent = name === 'day' ? '☀' : '☾';
  $('hacker').classList.toggle('on', name === 'hacker');
}

export function showRepo(c: City) {
  const refs = c.repos?.length ? [...new Set(c.repos.map(r => r.ref))] : [c.repo.ref];
  const ref = refs.length === 1 ? refs[0] : `${refs.length} refs`;
  $('repo').textContent = ref ? `${c.repo.name} · ${ref} ▾` : c.repo.name;
  $('repo').title = `${c.repo.remote || c.repo.path || c.repo.source}\nclick to switch branch`;
  document.title = `${c.repo.name} · Code City`;
  $('insights').hidden = false;
}

export function showStats(t: Totals, prev: Totals | null, authors: number | null) {
  const box = $('stats');
  box.replaceChildren();
  const add = (v: string, label: string, delta?: number) => {
    const s = el('div', 'stat');
    s.append(el('b', '', v));
    const l = el('span', '', label);
    if (delta) {
      const d = el('span', `delta ${delta > 0 ? 'up' : 'down'}`, ` ${delta > 0 ? '+' : ''}${fmt(delta)}`);
      l.append(d);
    }
    s.append(l);
    box.append(s);
  };
  add(fmt(t.files), 'files', prev ? t.files - prev.files : 0);
  add(t.loc >= 1e6 ? (t.loc / 1e6).toFixed(2) + 'M' : t.loc >= 1e4 ? Math.round(t.loc / 1000) + 'k' : fmt(t.loc), 'LOC', prev ? t.loc - prev.loc : 0);
  add(authors === null ? '–' : fmt(authors), 'people');
}

// ------------------------------------------------------------------ legend

export interface LegendOpts {
  mode: ColorMode;
  city: City;
  ownedFiles?: Map<number, number>;
  authorFilter: number;
  onAuthor(i: number): void;
  baselineLabel?: string;
}

export function showLegend(o: LegendOpts) {
  const box = $('legend');
  box.replaceChildren();
  const title = (t: string) => box.append(el('div', 'title', t));
  const row = (color: string, label: string, n?: string, onclick?: () => void, on = false) => {
    const r = el('div', 'lg' + (onclick ? ' click' : '') + (on ? ' on' : ''));
    const sw = el('i');
    sw.style.background = color;
    r.append(sw, el('span', '', label), el('span', '', n ?? ''));
    if (onclick) r.onclick = onclick;
    box.append(r);
  };
  const gradient = (lo: string, hi: string) => {
    box.append(el('div', 'gradient'));
    const l = el('div', 'gradlabels');
    l.append(el('span', '', lo), el('span', '', hi));
    box.append(l);
  };
  switch (o.mode) {
    case 'language': {
      title('Languages (LOC at newest commit)');
      Object.entries(o.city.stats.languages).sort((a, b) => b[1].loc - a[1].loc).slice(0, 10)
        .forEach(([name, s]) => row('#' + languageColor(name).getHexString(), name, fmt(s.loc)));
      break;
    }
    case 'hotspot': title('Hotspots'); gradient('stable or simple', 'changes often & complex'); break;
    case 'churn': title('Churn'); gradient('rarely changed', 'changed often'); break;
    case 'complexity': title('Indentation complexity'); gradient('flat', 'deeply nested'); break;
    case 'age': title('Last change'); gradient('a year or more', 'just now'); break;
    case 'dependents': title('Dependents'); gradient('imported by none', 'imported by many'); break;
    case 'depth': title('Directory depth'); break;
    case 'knowledge': {
      title('Knowledge risk');
      [4, 3, 2, 1, 0].forEach(k => row(RISK_COLORS[k], RISK[k]));
      break;
    }
    case 'compare': {
      title(`Since ${o.baselineLabel ?? 'baseline'}`);
      row('#40c057', 'added');
      row('#ff8c42', 'grew');
      row('#4dabf7', 'shrank');
      row('#7d8597', 'unchanged');
      break;
    }
    case 'owner': {
      title('Owners: click to filter');
      const authors = o.city.authors ?? [];
      const shown = authors.map((a, i) => ({ a, i, n: o.ownedFiles?.get(i) ?? 0 })).filter(x => x.n > 0)
        .filter(x => x.i < AUTHOR_COLORS).sort((x, y) => y.n - x.n);
      for (const { a, i, n } of shown) {
        row('#' + authorColor(i).getHexString(), a.name, `${fmt(n)} files`, () => o.onAuthor(o.authorFilter === i ? -1 : i), o.authorFilter === i);
      }
      if (authors.length > shown.length) row('#7d8597', 'everyone else');
      break;
    }
  }
}

// ------------------------------------------------------------------ tooltip

export function showTip(lines: [string, string] | null, x: number, y: number) {
  const tip = $('tip');
  if (!lines) { tip.hidden = true; return; }
  tip.replaceChildren(el('b', '', lines[0]), el('br'), el('span', 'm', lines[1]));
  tip.hidden = false;
  tip.style.left = Math.min(x + 16, innerWidth - 370) + 'px';
  tip.style.top = Math.min(y + 16, innerHeight - 70) + 'px';
}

// ------------------------------------------------------------------ inspector

export interface BuildingInfo {
  name: string; path: string; lang: string; district: string;
  loc: number; lines: number; bytes: number; complexity: number;
  series: number[]; commit: number;
  churn?: { commits: number; lines: number; allCommits: number; allLines: number; windowLabel: string; lastChange: number; now: number };
  owner?: { name: string; share: number; authors: number; risk: number; lastActive: number };
  coupled: { index: number; path: string; shared: number; degree: number }[];
  links: { label: string; href: string }[];
  pieces: PiecesState;
  deps: { imports: { index: number; path: string }[]; importDirs: { district: number; path: string }[]; importedBy: { index: number; path: string }[] };
  history?: HistoryState;
}

export interface FileCommit { hash: string; date: string; author: string; subject: string; body?: string }
export type HistoryState = { status: 'loading' } | { status: 'unavailable' } | { status: 'ready'; total: number; created?: FileCommit; recent: FileCommit[] };

export type PiecesState =
  | { status: 'loading' }
  | { status: 'unavailable'; message: string }
  | { status: 'ready'; pieces: import('./code').Piece[]; exploded: boolean; active: number };

export interface DistrictInfo {
  name: string; path: string; files: number; loc: number; complexity: number; commits: number; owners: number;
  top: { index: number; path: string; label: string }[];
}

export interface InfoHandlers {
  onClose(): void; onPick(i: number): void; onZoomDistrict(): void; onDistrict(d: number): void;
  onPiece(k: number): void; onExplode(): void; onCode(): void;
}

function infoHead(title: string, h: InfoHandlers) {
  const head = el('div', 'head');
  const close = el('button', 'close icon', '×');
  close.title = 'close (Esc)';
  close.onclick = h.onClose;
  head.append(el('h3', '', title), close);
  return head;
}

function metrics(items: [string, string][]) {
  const m = el('div', 'metrics');
  for (const [v, l] of items) { const d = el('div'); d.append(el('b', '', v), el('span', '', l)); m.append(d); }
  return m;
}

function kv(rows: [string, string | Node][]) {
  const g = el('div', 'kv');
  for (const [k, v] of rows) { g.append(el('span', '', k)); const s = el('span'); s.append(v); g.append(s); }
  return g;
}

export function showBuilding(d: BuildingInfo | null, h: InfoHandlers) {
  const box = $('info');
  if (!d) { box.hidden = true; return; }
  box.replaceChildren(infoHead(d.name, h), el('div', 'p', d.path));
  box.append(metrics([[fmt(d.loc), 'LOC'], [fmt(d.complexity), 'complexity'], [fmt(d.lines), 'lines'], [d.bytes >= 1024 ? (d.bytes / 1024).toFixed(1) + 'k' : fmt(d.bytes), 'bytes']]));
  const rows: [string, string | Node][] = [['language', d.lang], ['directory', d.district || '(root)']];
  if (d.churn) {
    if (d.churn.windowLabel) rows.push([`changes (${d.churn.windowLabel})`, `${fmt(d.churn.commits)} commits · ${fmt(d.churn.lines)} lines`]);
    rows.push(['changes (all)', `${fmt(d.churn.allCommits)} commits · ${fmt(d.churn.allLines)} lines`]);
    rows.push(['last change', `${day(d.churn.lastChange)} (${ago(d.churn.lastChange, d.churn.now)} before this commit)`]);
  }
  if (d.owner) {
    rows.push(['owner', `${d.owner.name} · ${d.owner.share}% of commits`]);
    const badge = el('span', 'badge', RISK[d.owner.risk]);
    badge.style.background = RISK_COLORS[d.owner.risk];
    const who = el('span', '', `${d.owner.authors} ${d.owner.authors === 1 ? 'author' : 'authors'} `);
    who.append(badge);
    rows.push(['knowledge', who]);
    rows.push(['owner last seen', day(d.owner.lastActive)]);
  }
  box.append(kv(rows));
  if (d.history) box.append(storySection(d.history));
  if (d.series.length > 1) {
    box.append(el('h4', '', 'Size over time'));
    const cv = el('canvas');
    box.append(cv);
    spark(cv, d.series, d.commit);
  }
  if (d.coupled.length) {
    box.append(el('h4', '', 'Changes together with'));
    const list = el('div', 'list');
    for (const c of d.coupled) {
      const b = el('button');
      b.title = `${c.path}\n${c.shared} shared commits, ${c.degree}% coupling`;
      const bar = el('span', 'bar');
      const fill = el('i');
      fill.style.width = c.degree + '%';
      bar.append(fill);
      b.append(el('span', 'path', '‎' + c.path), bar, el('span', 'num', c.degree + '%'));
      b.onclick = () => h.onPick(c.index);
      list.append(b);
    }
    box.append(list);
  }
  box.append(depsSection(d.deps, h));
  box.append(piecesSection(d.pieces, h));
  if (d.links.length) {
    const links = el('div', 'links');
    for (const l of d.links) {
      const a = el('a', '', l.label);
      a.href = l.href;
      if (l.href.startsWith('http')) { a.target = '_blank'; a.rel = 'noopener'; }
      links.append(a);
    }
    const copy = el('button', '', 'Copy path');
    copy.onclick = () => void navigator.clipboard?.writeText(d.path).then(() => { copy.textContent = 'Copied'; });
    links.append(copy);
    box.append(links);
  }
  box.hidden = false;
}

/** Where the file came from (the commit that added it) and what happened to it lately: the "why" behind the code. */
function storySection(hs: HistoryState): HTMLElement {
  const wrap = el('div', 'story');
  wrap.append(el('h4', '', 'Story'));
  if (hs.status === 'loading') { wrap.append(el('div', 'muted', 'reading history…')); return wrap; }
  if (hs.status === 'unavailable') { wrap.append(el('div', 'muted', 'History needs the server (codecity serve).')); return wrap; }
  if (hs.created) {
    const c = hs.created;
    const o = el('div', 'origin');
    o.append(el('div', 'muted', `born ${c.date.slice(0, 10)} · ${c.author} · ${c.hash.slice(0, 7)}`), el('div', 'subj', c.subject));
    if (c.body) o.append(el('div', 'body', c.body.length > 280 ? c.body.slice(0, 279) + '…' : c.body));
    wrap.append(o);
  }
  const rest = hs.recent.filter(c => c.hash !== hs.created?.hash).slice(0, 5);
  if (rest.length) {
    wrap.append(el('div', 'muted', `latest of ${hs.total} commits`));
    for (const c of rest) {
      const r = el('div', 'commit');
      r.append(el('span', 'num', c.date.slice(0, 10)), el('span', 'subj', c.subject));
      r.title = `${c.author} · ${c.hash.slice(0, 7)}${c.body ? '\n\n' + c.body : ''}`;
      wrap.append(r);
    }
  }
  return wrap;
}

function depsSection(d: BuildingInfo['deps'], h: InfoHandlers): HTMLElement {
  const wrap = el('div', 'deps');
  const list = (title: string, rows: { label: string; on: () => void; cls: string }[]) => {
    if (!rows.length) return;
    wrap.append(el('h4', '', `${title} (${rows.length})`));
    const l = el('div', 'list');
    for (const r of rows.slice(0, 40)) {
      const b = el('button');
      b.append(el('span', 'dot ' + r.cls), el('span', 'path', '\u200E' + r.label));
      b.title = r.label;
      b.onclick = r.on;
      l.append(b);
    }
    if (rows.length > 40) l.append(el('div', 'help', `+${rows.length - 40} more`));
    wrap.append(l);
  };
  list('Imports', [
    ...d.imports.map(x => ({ label: x.path, on: () => h.onPick(x.index), cls: 'out' })),
    ...d.importDirs.map(x => ({ label: x.path + '/', on: () => h.onDistrict(x.district), cls: 'out' })),
  ]);
  list('Imported by', d.importedBy.map(x => ({ label: x.path, on: () => h.onPick(x.index), cls: 'in' })));
  return wrap;
}

function piecesSection(st: PiecesState, h: InfoHandlers): HTMLElement {
  const wrap = el('div', 'pieces');
  const head = el('div', 'pieces-head');
  const title = el('h4', '', 'Pieces');
  head.append(title);
  wrap.append(head);
  if (st.status === 'loading') { wrap.append(el('div', 'empty', 'Reading file…')); return wrap; }
  if (st.status === 'unavailable') { wrap.append(el('div', 'empty', st.message)); return wrap; }
  const decls = st.pieces.filter(p => p.kind !== 'imports' && p.kind !== 'scope').length;
  title.textContent = `Pieces · ${decls} declarations`;
  const ex = el('button', st.exploded ? 'on' : '', st.exploded ? 'Collapse' : 'Explode');
  ex.title = 'split the building into floors, one per piece (E)';
  ex.onclick = h.onExplode;
  const code = el('button', '', 'Code');
  code.title = 'open the source';
  code.onclick = h.onCode;
  head.append(ex, code);
  const maxCx = Math.max(1, ...st.pieces.map(p => p.complexity / Math.max(1, p.loc)));
  const list = el('div', 'list');
  st.pieces.slice(0, 300).forEach((p, k) => {
    const b = el('button', 'pc' + (p.parent >= 0 ? ' child' : '') + (k === st.active ? ' on' : ''));
    b.title = `${p.kind} ${p.name}\nlines ${p.start}–${p.end} · ${p.loc} LOC · complexity ${p.complexity}`;
    const cx = el('span', 'cx');
    const fill = el('i');
    fill.style.width = Math.round(((p.complexity / Math.max(1, p.loc)) / maxCx) * 100) + '%';
    cx.append(fill);
    b.append(el('span', 'kind', p.kind), el('span', 'nm', p.name), el('span', 'num', p.loc), cx);
    b.onclick = () => h.onPiece(k);
    list.append(b);
  });
  if (st.pieces.length > 300) list.append(el('div', 'help', `+${st.pieces.length - 300} more`));
  wrap.append(list);
  return wrap;
}

export interface LinkInfo {
  from: string; to: string; kind: 'dependency' | 'people';
  evidence: string[];
  files: { index: number; path: string; target: string }[];
  people: string[]; peopleCount: number;
}

export function showLink(d: LinkInfo | null, h: InfoHandlers) {
  const box = $('info');
  if (!d) { box.hidden = true; return; }
  const title = d.kind === 'people' ? `${d.from} ↔ ${d.to}` : `${d.from} → ${d.to}`;
  box.replaceChildren(infoHead(title, h));
  const head = el('div', 'linkhead');
  head.append(el('span', 'kindtag' + (d.kind === 'people' ? ' people' : ''), d.kind === 'people' ? 'shared people' : 'dependency'));
  head.append(el('span', '', d.kind === 'people' ? `${fmt(d.peopleCount)} contributors work on both` : `${d.from} depends on ${d.to}`));
  box.append(head);
  if (d.evidence.length) {
    box.append(el('h4', '', 'Evidence'));
    const ul = el('ul', 'ev');
    for (const e of d.evidence) ul.append(el('li', '', e));
    box.append(ul);
  }
  if (d.files.length) {
    box.append(el('h4', '', `Importing files (${fmt(d.files.length)})`));
    const list = el('div', 'list');
    for (const f of d.files.slice(0, 200)) {
      const b = el('button');
      b.title = `${f.path}\n→ ${f.target}`;
      b.append(el('span', 'path', '\u200E' + f.path), el('span', 'num', '→ ' + f.target.split('/').slice(-1)[0]));
      b.onclick = () => h.onPick(f.index);
      list.append(b);
    }
    box.append(list);
  }
  if (d.people.length) {
    box.append(el('h4', '', 'Shared contributors'));
    const ul = el('ul', 'ev');
    for (const p of d.people) ul.append(el('li', '', p));
    if (d.peopleCount > d.people.length) ul.append(el('li', '', `+${fmt(d.peopleCount - d.people.length)} more`));
    box.append(ul);
  }
  box.hidden = false;
}

export function setConnRow(visible: boolean) { $('connrow').hidden = !visible; }

export function showDistrict(d: DistrictInfo | null, h: InfoHandlers) {
  const box = $('info');
  if (!d) { box.hidden = true; return; }
  box.replaceChildren(infoHead(d.name + '/', h), el('div', 'p', d.path || '(root)'));
  box.append(metrics([[fmt(d.files), 'files'], [fmt(d.loc), 'LOC'], [fmt(d.complexity), 'complexity'], [fmt(d.owners), 'owners']]));
  box.append(kv([['changes', `${fmt(d.commits)} file-commits`]]));
  if (d.top.length) {
    box.append(el('h4', '', 'Top hotspots here'));
    const list = el('div', 'list');
    d.top.forEach((t, i) => {
      const b = el('button');
      b.append(el('span', 'rank', i + 1), el('span', 'path', '‎' + t.path), el('span', 'num', t.label));
      b.onclick = () => h.onPick(t.index);
      list.append(b);
    });
    box.append(list);
  }
  const links = el('div', 'links');
  const zoom = el('button', '', 'Zoom to directory');
  zoom.onclick = h.onZoomDistrict;
  links.append(zoom);
  box.append(links);
  box.hidden = false;
}

function spark(cv: HTMLCanvasElement, s: number[], at: number) {
  const dpr = devicePixelRatio || 1;
  const w = cv.clientWidth || 300, h = 48;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const max = Math.max(1, ...s);
  const x = (i: number) => (i / (s.length - 1)) * (w - 6) + 3;
  const y = (v: number) => h - 4 - (v / max) * (h - 10);
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#7aa2ff';
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, accent + '66');
  g.addColorStop(1, accent + '00');
  ctx.beginPath();
  s.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.lineTo(x(s.length - 1), h); ctx.lineTo(x(0), h); ctx.closePath();
  ctx.fillStyle = g; ctx.fill();
  ctx.beginPath();
  s.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = accent;
  ctx.beginPath(); ctx.arc(x(at), y(s[at]), 3.5, 0, Math.PI * 2); ctx.fill();
}

// ------------------------------------------------------------------ search results

export function showResults(rows: { index: number; path: string }[], total: number, onPick: (i: number) => void) {
  const box = $('results');
  box.replaceChildren();
  for (const r of rows) {
    const b = el('button');
    b.append(el('span', 'path', '‎' + r.path));
    b.onclick = () => onPick(r.index);
    box.append(b);
  }
  if (total > rows.length) box.append(el('div', 'help', `+${fmt(total - rows.length)} more · Enter jumps to the first`));
}

// ------------------------------------------------------------------ insights

export type Tab = 'hotspots' | 'coupling' | 'risk' | 'complex' | 'areas' | 'authors' | 'links' | 'deps';
const HELP: Record<Tab, string> = {
  hotspots: 'Change frequency × complexity: where refactoring pays off most.',
  coupling: 'Files that keep changing in the same commits. Fine for code + test; elsewhere often a hidden dependency.',
  risk: 'Complex code whose owner has gone quiet, or that only one person has ever touched.',
  complex: 'Indentation complexity: total nesting depth, a language-neutral proxy for cyclomatic complexity.',
  areas: 'Top-level directories ranked by hotspot load.',
  authors: 'Owners = most commits to a file. Click someone to show only their files.',
  deps: 'Imports between files of the same repo: the most depended-on files (changing them ripples furthest), the biggest importers, and directories that import each other (cycles).',
  links: 'Connections between repositories, each with the evidence behind it. Click one to inspect it.',
};

export interface InsightHandlers {
  onLink(i: number): void;
  onPick(i: number): void;
  onPair(a: number, b: number): void;
  onArea(d: number): void;
  onAuthor(i: number): void;
}

export function showInsights(ins: Insights | null, tab: Tab, hasChurn: boolean, authorFilter: number, now: number, h: InsightHandlers) {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('tabhelp').textContent = HELP[tab];
  const body = $('tabbody');
  body.replaceChildren();
  if (!ins) return;
  const list = el('div', 'list');
  const fileRow = (rank: number, index: number, path: string, num: string, title?: string) => {
    const b = el('button');
    if (title) b.title = title;
    b.append(el('span', 'rank', rank), el('span', 'path', '‎' + path), el('span', 'num', num));
    b.onclick = () => h.onPick(index);
    list.append(b);
  };
  const needChurn = () => body.append(el('div', 'empty', 'Needs history analysis: re-run with “history analysis” checked.'));
  switch (tab) {
    case 'hotspots':
      if (!hasChurn) return needChurn();
      ins.hotspots.forEach((r, i) => fileRow(i + 1, r.index, r.path, `${r.a} × ${fmt(r.b)}`, `${r.a} commits × complexity ${fmt(r.b)}${r.note ? `\nowner: ${r.note}` : ''}`));
      break;
    case 'coupling':
      if (!hasChurn) return needChurn();
      for (const p of ins.coupling) {
        const b = el('button', 'pair');
        b.title = `${p.shared} shared commits · ${p.degree}% coupling`;
        b.append(el('span', 'path', pathOf(p.a)), el('span', 'num', `${p.degree}%`),
          el('span', 'path', '↳ ' + pathOf(p.b)), el('span', 'num', `${p.shared}×`));
        b.onclick = () => h.onPair(p.a, p.b);
        list.append(b);
      }
      break;
    case 'risk': {
      if (!hasChurn) return needChurn();
      const section = (title: string, rows: typeof ins.orphaned) => {
        if (!rows.length) return;
        list.append(el('h4', '', title));
        rows.forEach((r, i) => fileRow(i + 1, r.index, r.path, fmt(r.a), `owner: ${r.note}\ncomplexity ${fmt(r.a)}`));
      };
      section('Owner inactive', ins.orphaned);
      section('Single author', ins.single);
      break;
    }
    case 'complex':
      ins.complex.forEach((r, i) => fileRow(i + 1, r.index, r.path, fmt(r.a), `complexity ${fmt(r.a)} · ${fmt(r.b)} LOC`));
      break;
    case 'areas':
      ins.areas.forEach((a, i) => {
        const b = el('button');
        b.title = `${fmt(a.files)} files · ${fmt(a.loc)} LOC · complexity ${fmt(a.complexity)} · ${fmt(a.commits)} file-commits · ${a.owners} owners`;
        b.append(el('span', 'rank', i + 1), el('span', 'path', '‎' + a.name + '/'), el('span', 'num', `${fmt(a.files)} files`));
        b.onclick = () => h.onArea(a.district);
        list.append(b);
      });
      break;
    case 'authors':
      if (!hasChurn) return needChurn();
      ins.authors.slice(0, 40).forEach(a => {
        const b = el('button');
        if (a.index === authorFilter) b.style.background = 'rgba(122,162,255,0.18)';
        b.title = `${fmt(a.commits)} commits · owns ${fmt(a.files)} files · last commit ${day(a.last)}`;
        const dot = el('span', 'badge', a.active ? 'active' : ago(a.last, now));
        dot.style.background = a.active ? 'var(--good)' : 'var(--faint)';
        b.append(el('span', 'path', a.name), dot, el('span', 'num', `${fmt(a.files)} files`));
        b.querySelector('.path')!.setAttribute('style', 'direction:ltr');
        b.onclick = () => h.onAuthor(a.index === authorFilter ? -1 : a.index);
        list.append(b);
      });
      break;
  }
  if (tab === 'deps') {
    const sec = (title: string, rows: { index: number; path: string; n: number }[], unit: string) => {
      if (!rows.length) return;
      list.append(el('h4', '', title));
      rows.forEach((r, i) => fileRow(i + 1, r.index, r.path, `${fmt(r.n)} ${unit}`));
    };
    sec('Most depended on', ins.fanIn, 'dependents');
    sec('Biggest importers', ins.fanOut, 'imports');
    if (ins.cycles.length) {
      list.append(el('h4', '', 'Directory cycles'));
      for (const c of ins.cycles) {
        const b = el('button', 'pair');
        b.title = `${c.a}/ imports ${c.b}/ in ${c.ab} places, and ${c.b}/ imports ${c.a}/ in ${c.ba}`;
        b.append(el('span', 'path', c.a + '/ ⇄ ' + c.b + '/'), el('span', 'num', `${c.ab}↔${c.ba}`));
        b.querySelector('.path')!.setAttribute('style', 'direction:ltr');
        b.onclick = () => h.onArea(c.da);
        list.append(b);
      }
    }
    if (!list.children.length) body.append(el('div', 'empty', 'No imports between files were found (supported: Go, JS/TS, Python, Rust).'));
  }
  if (tab === 'links') {
    for (const l of linkRows) {
      const b = el('button', 'pair');
      b.title = l.evidence.join('\n');
      b.append(el('span', 'path', l.title), el('span', 'num', l.kind === 'people' ? 'people' : 'depends'),
        el('span', 'path', '↳ ' + l.summary), el('span', 'num', ''));
      b.querySelectorAll('.path').forEach(p => p.setAttribute('style', 'direction:ltr'));
      b.onclick = () => h.onLink(l.index);
      list.append(b);
    }
    if (!linkRows.length) body.append(el('div', 'empty', 'These repositories have no connections: no shared dependencies, imports or people.'));
  }
  if (!list.children.length && tab !== 'links' && tab !== 'deps') body.append(el('div', 'empty', 'Nothing to show at this commit.'));
  else body.append(list);
}

let pathOf: (i: number) => string = i => String(i);

export interface LinkRow { index: number; kind: string; title: string; summary: string; evidence: string[] }
let linkRows: LinkRow[] = [];
/** Rows for the Links tab; hides the tab when there are none and no multi-repo world. */
export function setLinkRows(rows: LinkRow[], multi: boolean) {
  linkRows = rows;
  document.querySelector<HTMLButtonElement>('.tabs button[data-tab="links"]')!.hidden = !multi;
}
export function setPathResolver(f: (i: number) => string) { pathOf = f; }

// ------------------------------------------------------------------ timeline

export function setupTimeline(c: City) {
  $('timeline').hidden = c.commits.length < 2;
  document.body.classList.toggle('hastimeline', c.commits.length >= 2);
  const sc = $<HTMLInputElement>('scrub');
  sc.max = String(c.commits.length - 1);
  sc.value = String(c.commits.length - 1);
  setPlaying(false);
}

export function setPlaying(p: boolean) { $('play').textContent = p ? '❚❚' : '▶'; }

export function showCommit(c: City, i: number) {
  const k = c.commits[i];
  $<HTMLInputElement>('scrub').value = String(i);
  const when = $('when');
  when.replaceChildren();
  when.title = k.subject;
  when.append(el('b', '', k.date.slice(0, 10)), ` · ${i + 1}/${c.commits.length} · `, el('span', 'h', k.hash.slice(0, 8)), ` · ${k.author} · ${k.subject}`);
}

/** Activity chart: LOC area + file-count line, current and baseline markers. */
export function drawChart(totals: Totals[], at: number, baseline: number | null, hover: number | null) {
  const cv = $<HTMLCanvasElement>('chart');
  const dpr = devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const n = totals.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * (w - 2) + 1 : w / 2);
  const maxL = Math.max(1, ...totals.map(t => t.loc)), maxF = Math.max(1, ...totals.map(t => t.files));
  const yL = (v: number) => h - 2 - (v / maxL) * (h - 6);
  const yF = (v: number) => h - 2 - (v / maxF) * (h - 6);
  const css = getComputedStyle(document.body);
  const accent = css.getPropertyValue('--accent').trim(), accent2 = css.getPropertyValue('--accent2').trim();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, accent + '88'); g.addColorStop(1, accent + '08');
  ctx.beginPath();
  totals.forEach((t, i) => (i ? ctx.lineTo(x(i), yL(t.loc)) : ctx.moveTo(x(i), yL(t.loc))));
  ctx.lineTo(x(n - 1), h); ctx.lineTo(x(0), h); ctx.closePath();
  ctx.fillStyle = g; ctx.fill();
  ctx.beginPath();
  totals.forEach((t, i) => (i ? ctx.lineTo(x(i), yF(t.files)) : ctx.moveTo(x(i), yF(t.files))));
  ctx.strokeStyle = accent2; ctx.lineWidth = 1.2; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
  const mark = (i: number, color: string, width: number) => {
    ctx.fillStyle = color;
    ctx.fillRect(x(i) - width / 2, 0, width, h);
  };
  if (baseline !== null) mark(baseline, '#40c057', 2);
  if (hover !== null) mark(hover, css.getPropertyValue('--dim').trim(), 1);
  mark(at, css.getPropertyValue('--fg').trim(), 2);
}

export function chartIndex(ev: MouseEvent, n: number): number {
  const r = $('chart').getBoundingClientRect();
  return Math.max(0, Math.min(n - 1, Math.round(((ev.clientX - r.left) / r.width) * (n - 1))));
}

// ------------------------------------------------------------------ form & controls

export interface Controls {
  onMetric(v: Metric): void;
  onScale(v: ScaleMode): void;
  onMult(v: number): void;
  onColor(v: ColorMode): void;
  onSearch(q: string): void;
  onSearchEnter(): void;
  onSubmit(source: string, ref: string, commits: number, churn: boolean): void;
  onCancel(): void;
  onScrub(i: number): void;
  onPlay(): void;
  onChanges(v: boolean): void;
  onSpeed(v: number): void;
  onChurnWindow(v: number): void;
  onSetBaseline(): void;
  onTheme(): void;
  onHacker(): void;
  onTab(t: Tab): void;
  onCopyReport(): void;
  onLinksToggle(): void;
  onCodeLinks(mode: 'off' | 'selection' | 'all'): void;
}

export function linkToggles() {
  return { deps: $<HTMLInputElement>('showdeps').checked, people: $<HTMLInputElement>('showpeople').checked };
}

function autosize() {
  const t = $<HTMLTextAreaElement>('source');
  const n = Math.min(8, Math.max(1, t.value.split('\n').length));
  t.rows = n;
}

export function bindControls(h: Controls) {
  const sel = (id: string) => $<HTMLSelectElement>(id);
  sel('metric').onchange = () => h.onMetric(sel('metric').value as Metric);
  sel('scale').onchange = () => h.onScale(sel('scale').value as ScaleMode);
  $<HTMLInputElement>('mult').oninput = e => h.onMult(parseFloat((e.target as HTMLInputElement).value));
  sel('color').onchange = () => h.onColor(sel('color').value as ColorMode);
  sel('cwin').onchange = () => h.onChurnWindow(parseInt(sel('cwin').value, 10));
  $<HTMLInputElement>('search').oninput = e => h.onSearch((e.target as HTMLInputElement).value);
  $<HTMLInputElement>('search').onkeydown = e => { if (e.key === 'Enter') h.onSearchEnter(); if (e.key === 'Escape') (e.target as HTMLInputElement).blur(); };
  const src = $<HTMLTextAreaElement>('source');
  src.addEventListener('input', autosize);
  src.onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $<HTMLFormElement>('repoform').requestSubmit(); };
  $('showdeps').onchange = () => h.onLinksToggle();
  $<HTMLSelectElement>('codelinks').onchange = e => h.onCodeLinks((e.target as HTMLSelectElement).value as 'off' | 'selection' | 'all');
  $('showpeople').onchange = () => h.onLinksToggle();
  $('repoform').onsubmit = e => {
    e.preventDefault();
    h.onSubmit(src.value.trim(), '',
      Math.max(1, parseInt($<HTMLInputElement>('commits').value, 10) || 1), $<HTMLInputElement>('churn').checked);
  };
  $('cancel').onclick = () => h.onCancel();
  $<HTMLInputElement>('scrub').oninput = e => h.onScrub(parseInt((e.target as HTMLInputElement).value, 10));
  $('play').onclick = () => h.onPlay();
  $<HTMLInputElement>('changes').onchange = e => h.onChanges((e.target as HTMLInputElement).checked);
  sel('speed').onchange = () => h.onSpeed(parseFloat(sel('speed').value));
  $('setbase').onclick = () => h.onSetBaseline();
  $('theme').onclick = () => h.onTheme();
  $('hacker').onclick = () => h.onHacker();
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach(b => { b.onclick = () => h.onTab(b.dataset.tab as Tab); });
  $('copyreport').onclick = () => h.onCopyReport();
}

export function setColorMode(m: ColorMode) { $<HTMLSelectElement>('color').value = m; }

export function setChurnAvailable(on: boolean) {
  for (const v of ['churn', 'hotspot', 'age', 'owner', 'knowledge']) {
    document.querySelectorAll<HTMLOptionElement>(`#color option[value="${v}"]`).forEach(o => { o.disabled = !on; });
  }
  $<HTMLSelectElement>('cwin').disabled = !on;
}

export function setBaselineRow(visible: boolean, label: string) {
  $('baserow').hidden = !visible;
  $('basedate').textContent = `baseline: ${label}`;
  $('cwinrow').hidden = visible;
}

export function setForm(source: string, ref: string, commits: number, churn = true) {
  // an old-style default ref folds into the lines that do not name one
  if (ref) source = source.split('\n').map(l => (l.trim() && !l.trim().startsWith('#') && l.trim().split(/\s+/).length === 1 ? `${l.trim()} ${ref}` : l)).join('\n');
  $<HTMLTextAreaElement>('source').value = source;
  autosize();
  $<HTMLInputElement>('commits').value = String(commits);
  $<HTMLInputElement>('churn').checked = churn;
}

export function flashCopied(text: string) {
  const c = $('copied');
  c.textContent = text;
  setTimeout(() => { if (c.textContent === text) c.textContent = ''; }, 2500);
}

export function setCodeLinksMode(m: 'off' | 'selection' | 'all') { $<HTMLSelectElement>('codelinks').value = m; }
