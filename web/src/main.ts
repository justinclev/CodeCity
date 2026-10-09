import './style.css';
import { CityScene, type Floor } from './scene';
import { showCode, type FileData } from './code';
import { compute, markdown, type Insights } from './insights';
import * as ui from './ui';
import { SCHEMA_VERSION, type City, type ColorMode } from './types';
import type { ThemeName } from './theme';

const scene = new CityScene(document.getElementById('c') as HTMLCanvasElement);
let city: City | null = null;
let totals: { files: number; loc: number }[] = [];
let tab: ui.Tab = 'hotspots';
let insights: Insights | null = null;
let selected = -1;
let selectedDistrict = -1;
let apiAvailable = false;

// ---------------------------------------------------------------- file pieces (needs the server)
const fileCache = new Map<string, Promise<FileData>>();
let file: FileData | null = null; // for the selected building at the current commit
let fileError = '';
let activePiece = -1;
let floors: Floor[] = [];
let codeOpen = false;

function fetchFile(path: string, commit: number): Promise<FileData> {
  const key = `${path}@${commit}`;
  let p = fileCache.get(key);
  if (!p) {
    p = api<FileData>(`/api/file?path=${encodeURIComponent(path)}&commit=${commit}`);
    p.catch(() => fileCache.delete(key));
    fileCache.set(key, p);
  }
  return p;
}

/** Floors for the exploded view: top-level pieces, with containers replaced by their members. */
function floorsOf(f: FileData): Floor[] {
  const out: Floor[] = [];
  f.pieces.forEach((p, k) => {
    if (p.parent >= 0) return;
    const kids = f.pieces.map((c, j) => ({ c, j })).filter(x => x.c.parent === k);
    if (!kids.length) { out.push({ name: p.name, kind: p.kind, loc: p.loc, complexity: p.complexity, piece: k }); return; }
    const rest = p.loc - kids.reduce((a, x) => a + x.c.loc, 0);
    if (rest > 2) out.push({ name: `${p.name} (body)`, kind: p.kind, loc: rest, complexity: 0, piece: k });
    for (const { c, j } of kids) out.push({ name: `${p.name}.${c.name}`, kind: c.kind, loc: c.loc, complexity: c.complexity, piece: j });
  });
  return out;
}

async function loadPieces(i: number) {
  if (!city) return;
  const path = city.buildings[i].path, commit = scene.commit;
  file = null; fileError = ''; activePiece = -1; floors = [];
  scene.setSkin(-1, '');
  if (!apiAvailable) { fileError = 'Pieces and source need the server (codecity serve).'; return; }
  try {
    const f = await fetchFile(path, commit);
    if (selected !== i || scene.commit !== commit) return; // selection moved on
    file = f;
    floors = floorsOf(f);
    refreshSkin();
  } catch (e) {
    if (selected !== i) return;
    fileError = `Could not read the file: ${(e as Error).message}`;
  }
  refreshSelection();
}

/** The selected building wears its source in hacker mode. */
function refreshSkin() {
  if (selected >= 0 && file && scene.theme.name === 'hacker' && scene.exists(selected)) scene.setSkin(selected, file.content);
  else scene.setSkin(-1, '');
}

function piecesState(): ui.PiecesState {
  if (fileError) return { status: 'unavailable', message: fileError };
  if (!file) return { status: 'loading' };
  return { status: 'ready', pieces: file.pieces, exploded: scene.explodingBuilding === selected, active: activePiece };
}

const codeHandlers = {
  onClose: () => closeCode(),
  onStep: (delta: number) => stepPiece(delta),
};

function openPiece(k: number) {
  if (!file) return;
  activePiece = k;
  codeOpen = true;
  showCode(file, k, codeHandlers);
  const fl = floors.findIndex(f => f.piece === k);
  scene.highlightFloor(fl);
  refreshSelection();
}

function stepPiece(delta: number) {
  if (!file || !floors.length) return;
  const cur = Math.max(0, floors.findIndex(f => f.piece === activePiece));
  const next = floors[(cur + delta + floors.length) % floors.length];
  openPiece(next.piece);
}

function closeCode() {
  codeOpen = false;
  activePiece = -1;
  showCode(null, -1, codeHandlers);
  scene.highlightFloor(-1);
  refreshSelection();
}

function toggleExplode() {
  if (selected < 0 || !file) return;
  if (scene.explodingBuilding === selected) scene.collapse();
  else scene.explode(selected, floors);
  refreshSelection();
}

// ---------------------------------------------------------------- storage helpers (best effort)
const store = {
  get<T>(k: string): T | null { try { return JSON.parse(localStorage.getItem('codecity.' + k) ?? 'null'); } catch { return null; } },
  set(k: string, v: unknown) { try { localStorage.setItem('codecity.' + k, JSON.stringify(v)); } catch { /* unavailable */ } },
};

// ---------------------------------------------------------------- theme
let lastPlainTheme: ThemeName = 'night'; // where H returns to
function applyTheme(name: ThemeName) {
  if (name !== 'hacker') lastPlainTheme = name;
  ui.setTheme(name);
  scene.setTheme(name);
  store.set('theme', name);
  store.set('plainTheme', lastPlainTheme);
  if (city) { redrawChart(); refreshSkin(); }
}
lastPlainTheme = store.get<ThemeName>('plainTheme') ?? 'night';
const toggleHacker = () => applyTheme(scene.theme.name === 'hacker' ? lastPlainTheme : 'hacker');
const toggleDayNight = () => applyTheme(scene.theme.name === 'night' ? 'day' : 'night');
applyTheme(store.get<ThemeName>('theme') ?? 'night');

// ---------------------------------------------------------------- loading
function isCity(x: unknown): x is City {
  const c = x as City;
  return !!c && c.version === SCHEMA_VERSION && Array.isArray(c.districts) && Array.isArray(c.buildings) &&
    Array.isArray(c.commits) && c.commits.length > 0 && !!c.bounds;
}

function show(c: City) {
  if (c.buildings.length === 0) { ui.setMessage('This repository has no countable source files.'); return; }
  stopPlayback();
  const wanted = new URLSearchParams(location.hash.slice(1)).get('file'); // read before writeHash() replaces it
  city = c;
  selected = selectedDistrict = -1;
  ui.setMessage('');
  ui.setPathResolver(i => c.buildings[i].path);
  ui.setChurnAvailable(c.churn === true);
  if (!c.churn && ['churn', 'hotspot', 'age', 'owner', 'knowledge'].includes(scene.colorMode)) scene.colorMode = 'language';
  ui.setColorMode(scene.colorMode);
  scene.load(c);
  totals = scene.allTotals();
  ui.showRepo(c);
  ui.setupTimeline(c);
  (document.getElementById('repobox') as HTMLDetailsElement).open = false;
  applyHash();
  onCommitChanged();
  closeInfo();
  if (wanted) {
    const i = c.buildings.findIndex(b => b.path === wanted);
    if (i >= 0 && scene.exists(i)) setTimeout(() => { if (city === c) selectBuilding(i, true); }, 2700); // after the intro
  }
}

async function fetchCity(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const data: unknown = await res.json();
  if (!isCity(data)) throw new Error(`not a city.json (schema version ${SCHEMA_VERSION}); re-run the analysis`);
  show(data);
}

async function loadFile(f: File) {
  try {
    const data: unknown = JSON.parse(await f.text());
    if (!isCity(data)) throw new Error(`not a city.json (schema version ${SCHEMA_VERSION})`);
    show(data);
  } catch (e) { ui.setJobStatus(`Could not read ${f.name}: ${(e as Error).message}`, true); }
}

// ---------------------------------------------------------------- analysis jobs
interface JobInfo { id: number; state: string; stage: string; done: number; total: number; error?: string; source: string; request: { source: string; ref: string; maxCommits: number; noChurn?: boolean } }
interface Status { hasCity: boolean; allowLocal: boolean; maxCommitsLimit: number; job?: JobInfo }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

let watching = false;
async function watchJob() {
  if (watching) return;
  watching = true;
  ui.setBusy(true);
  try {
    for (;;) {
      const j = (await api<Status>('/api/status')).job;
      if (!j) break;
      if (j.state === 'running') {
        ui.setProgress({ done: j.done, total: j.total });
        ui.setJobStatus(j.total ? `${j.stage} ${j.done}/${j.total}` : `${j.stage}…`);
        await new Promise(r => setTimeout(r, 400));
        continue;
      }
      ui.setProgress(null);
      if (j.state === 'done') { ui.setJobStatus(''); await fetchCity('/api/city'); }
      else if (j.state === 'error') { ui.setJobStatus(j.error ?? 'analysis failed', true); (document.getElementById('repobox') as HTMLDetailsElement).open = true; }
      else ui.setJobStatus('cancelled');
      break;
    }
  } catch (e) {
    ui.setProgress(null);
    ui.setJobStatus((e as Error).message, true);
  } finally {
    watching = false;
    ui.setBusy(false);
  }
}

async function submit(source: string, ref: string, commits: number, churn: boolean) {
  store.set('form', { source, ref, commits, churn });
  ui.setJobStatus('starting…');
  ui.setProgress({ done: 0, total: 0 });
  try {
    await api('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, ref, maxCommits: commits, noChurn: !churn }) });
    void watchJob();
  } catch (e) {
    ui.setProgress(null);
    ui.setJobStatus((e as Error).message, true);
  }
}

// ---------------------------------------------------------------- derived views
const windowLabel = () => (scene.churnWindow ? `last ${scene.churnWindow} samples` : '');
const commitLabel = (i: number) => city ? `${city.commits[i].date.slice(0, 10)} (${city.commits[i].hash.slice(0, 7)})` : '';

function ownedFiles() {
  const m = new Map<number, number>();
  city!.buildings.forEach((b, i) => { if (b.own && scene.exists(i)) m.set(b.own[0], (m.get(b.own[0]) ?? 0) + 1); });
  return m;
}

function refreshLegend() {
  if (!city) return;
  ui.showLegend({ mode: scene.colorMode, city, ownedFiles: ownedFiles(), authorFilter: scene.authorFilter,
    onAuthor: setAuthorFilter, baselineLabel: commitLabel(scene.baseline) });
  ui.setBaselineRow(scene.colorMode === 'compare', commitLabel(scene.baseline));
}

function refreshInsights() {
  if (!city) return;
  insights = compute(city, scene, 15);
  ui.showInsights(insights, tab, city.churn, scene.authorFilter, scene.timeOf(), {
    onPick: i => selectBuilding(i, true),
    onPair: (a, b) => { selectBuilding(a, true); void b; },
    onArea: d => selectDistrict(d, true),
    onAuthor: setAuthorFilter,
  });
}

let chartHover: number | null = null;
function redrawChart() {
  if (!city || city.commits.length < 2) return;
  ui.drawChart(totals, scene.commit, scene.colorMode === 'compare' ? scene.baseline : null, chartHover);
}

function onCommitChanged() {
  if (!city) return;
  ui.showCommit(city, scene.commit);
  ui.showStats(totals[scene.commit], scene.commit > 0 ? totals[scene.commit - 1] : null, city.churn ? ownedFiles().size : null);
  redrawChart();
  refreshLegend();
  refreshInsights();
  refreshSelection();
  writeHash();
}

function setCommit(i: number) {
  const before = scene.commit;
  scene.setCommit(i);
  if (scene.commit !== before && selected >= 0) {
    if (scene.explodedBuilding >= 0) scene.collapse(true);
    if (codeOpen) closeCode();
    if (scene.exists(selected)) void loadPieces(selected);
  }
  onCommitChanged();
}

function setColor(m: ColorMode) {
  scene.colorMode = m;
  ui.setColorMode(m);
  scene.refresh(false);
  refreshLegend();
  redrawChart();
  writeHash();
}

function setAuthorFilter(a: number) {
  scene.setAuthorFilter(a);
  if (a >= 0 && scene.colorMode !== 'owner') setColor('owner');
  refreshLegend();
  refreshInsights();
}

// ---------------------------------------------------------------- selection
function links(path: string): { label: string; href: string }[] {
  const out: { label: string; href: string }[] = [];
  const hash = city!.commits[scene.commit].hash;
  const remote = city!.repo.remote ?? '';
  const gh = remote.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  const gl = remote.match(/gitlab\.com[/:](.+?)(?:\.git)?\/?$/);
  const enc = path.split('/').map(encodeURIComponent).join('/');
  if (gh) {
    out.push({ label: 'GitHub ↗', href: `https://github.com/${gh[1]}/${gh[2]}/blob/${hash}/${enc}` });
    out.push({ label: 'History ↗', href: `https://github.com/${gh[1]}/${gh[2]}/commits/${hash}/${enc}` });
  } else if (gl) {
    out.push({ label: 'GitLab ↗', href: `https://gitlab.com/${gl[1]}/-/blob/${hash}/${enc}` });
  }
  if (city!.repo.path) out.push({ label: 'Open in VS Code', href: `vscode://file${encodeURI(city!.repo.path.replace(/\\/g, '/'))}/${enc}` });
  return out;
}

const infoHandlers: ui.InfoHandlers = {
  onPiece: k => openPiece(k),
  onExplode: () => toggleExplode(),
  onCode: () => openPiece(activePiece >= 0 ? activePiece : (floors[0]?.piece ?? 0)),
  onClose: () => closeInfo(),
  onPick: i => selectBuilding(i, true),
  onZoomDistrict: () => { if (selectedDistrict >= 0) scene.focusDistrict(selectedDistrict); },
};

function buildingInfo(i: number): ui.BuildingInfo {
  const c = city!;
  const b = c.buildings[i];
  const v = scene.valuesAt(i);
  const ch = scene.churnAt(i);
  const now = scene.timeOf();
  const author = b.own ? c.authors?.[b.own[0]] : undefined;
  return {
    name: b.name, path: b.path, lang: b.lang, district: c.districts[b.district].path,
    loc: v.loc, lines: v.lines, bytes: v.bytes, complexity: v.complexity,
    series: scene.series(i), commit: scene.commit,
    churn: c.churn ? { ...ch, windowLabel: windowLabel(), lastChange: v.lastChange, now } : undefined,
    owner: b.own && author ? { name: author.name, share: Math.round((b.own[1] / Math.max(1, scene.totalCommits(i))) * 100),
      authors: b.own[2], risk: scene.risk(i), lastActive: author.last } : undefined,
    coupled: (b.cpl ?? []).filter(([j]) => scene.exists(j)).map(([j, shared, degree]) => ({ index: j, path: c.buildings[j].path, shared, degree })),
    links: links(b.path),
    pieces: piecesState(),
  };
}

function selectBuilding(i: number, fly: boolean) {
  if (!city || i < 0 || !scene.exists(i)) return;
  if (i !== selected) {
    if (scene.explodedBuilding >= 0) scene.collapse();
    if (codeOpen) closeCode();
    selected = i;
    void loadPieces(i);
  }
  selected = i;
  selectedDistrict = -1;
  scene.setSelectedDistrict(-1);
  scene.setSelected(i);
  ui.showBuilding(buildingInfo(i), infoHandlers);
  if (fly) scene.focus(i);
  writeHash();
}

function districtInfo(d: number): ui.DistrictInfo {
  const c = city!;
  const x = c.districts[d];
  const members = scene.districtMembers(d);
  const owners = new Set<number>();
  let loc = 0, complexity = 0, commits = 0;
  for (const i of members) {
    const v = scene.valuesAt(i);
    loc += v.loc;
    if (scene.isCode(i)) complexity += v.complexity;
    commits += scene.churnAt(i).commits;
    const o = c.buildings[i].own;
    if (o) owners.add(o[0]);
  }
  const set = new Set(members);
  const top = c.churn ? scene.topHotspots(5, i => set.has(i)).map(h => ({ index: h.index, path: c.buildings[h.index].path, label: `${h.commits} × ${ui.fmt(h.loc)}` })) : [];
  return { name: x.name, path: x.path, files: members.length, loc, complexity, commits, owners: owners.size, top };
}

function selectDistrict(d: number, fly: boolean) {
  if (!city) return;
  if (scene.explodedBuilding >= 0) scene.collapse();
  if (codeOpen) closeCode();
  selected = -1;
  scene.setSelected(-1);
  selectedDistrict = d;
  scene.setSelectedDistrict(d);
  ui.showDistrict(districtInfo(d), infoHandlers);
  if (fly) scene.focusDistrict(d);
  writeHash();
}

function closeInfo() {
  if (scene.explodedBuilding >= 0) scene.collapse();
  if (codeOpen) closeCode();
  file = null;
  scene.setSkin(-1, '');
  selected = selectedDistrict = -1;
  scene.setSelected(-1);
  scene.setSelectedDistrict(-1);
  ui.showBuilding(null, infoHandlers);
  writeHash();
}

function refreshSelection() {
  if (!city) return;
  if (selected >= 0) {
    if (scene.exists(selected)) ui.showBuilding(buildingInfo(selected), infoHandlers);
    else closeInfo();
  } else if (selectedDistrict >= 0) ui.showDistrict(districtInfo(selectedDistrict), infoHandlers);
}

// ---------------------------------------------------------------- deep links (#c=..&color=..&file=..)
function writeHash() {
  if (!city) return;
  const p = new URLSearchParams();
  if (scene.commit !== city.commits.length - 1) p.set('c', city.commits[scene.commit].hash.slice(0, 12));
  if (scene.colorMode !== 'language') p.set('color', scene.colorMode);
  if (selected >= 0) p.set('file', city.buildings[selected].path);
  const h = p.toString();
  history.replaceState(null, '', h ? '#' + h : location.pathname + location.search);
}

function applyHash() {
  if (!city) return;
  const p = new URLSearchParams(location.hash.slice(1));
  const color = p.get('color') as ColorMode | null;
  const opt = color && document.querySelector<HTMLOptionElement>(`#color option[value="${color}"]`);
  if (opt && !opt.disabled) { scene.colorMode = color!; ui.setColorMode(color!); scene.refresh(true); }
  const c = p.get('c');
  if (c) { const i = city.commits.findIndex(k => k.hash.startsWith(c)); if (i >= 0) scene.setCommit(i); }
}

// ---------------------------------------------------------------- playback
let playing = false, speed = 3, acc = 0, last = 0;

function tick(now: number) {
  if (!playing) return;
  acc += (now - last) / 1000;
  last = now;
  const step = 1 / speed;
  while (acc >= step && playing) {
    acc -= step;
    if (scene.commit >= scene.commitCount - 1) { stopPlayback(); break; }
    setCommit(scene.commit + 1);
  }
  if (playing) requestAnimationFrame(tick);
}
function startPlayback() {
  if (!city || scene.commitCount < 2) return;
  if (scene.commit >= scene.commitCount - 1) setCommit(0);
  playing = true; acc = 0; last = performance.now();
  ui.setPlaying(true);
  requestAnimationFrame(tick);
}
function stopPlayback() { playing = false; ui.setPlaying(false); }

// ---------------------------------------------------------------- controls
let searchHits: number[] = [];
ui.bindControls({
  onMetric: v => { scene.metric = v; scene.refresh(false); },
  onScale: v => { scene.scale = v; scene.refresh(false); },
  onMult: v => { scene.mult = v; scene.refresh(false); },
  onColor: v => setColor(v),
  onChurnWindow: v => { scene.churnWindow = v; scene.refresh(false); refreshInsights(); refreshSelection(); },
  onSearch: q => {
    if (!city) return;
    searchHits = scene.search(q);
    ui.showResults(searchHits.slice(0, 8).map(i => ({ index: i, path: city!.buildings[i].path })), searchHits.length, i => selectBuilding(i, true));
  },
  onSearchEnter: () => { if (searchHits.length) selectBuilding(searchHits[0], true); },
  onSubmit: (s, r, c, ch) => void submit(s, r, c, ch),
  onCancel: () => void api('/api/cancel', { method: 'POST' }).catch(() => undefined),
  onScrub: i => { stopPlayback(); setCommit(i); },
  onPlay: () => (playing ? stopPlayback() : startPlayback()),
  onChanges: v => scene.setShowChanges(v),
  onSpeed: v => { speed = v; },
  onSetBaseline: () => { scene.baseline = scene.commit; scene.refresh(false); refreshLegend(); redrawChart(); },
  onTheme: () => toggleDayNight(),
  onHacker: () => toggleHacker(),
  onTab: t => { tab = t; store.set('tab', t); refreshInsights(); },
  onCopyReport: () => {
    if (!city || !insights) return;
    const md = markdown(city, scene, insights, windowLabel() || 'all history');
    navigator.clipboard?.writeText(md).then(() => ui.flashCopied('Copied'), () => ui.flashCopied('Clipboard blocked'));
  },
});
tab = store.get<ui.Tab>('tab') ?? 'hotspots';

// timeline chart: hover shows a marker, click seeks, shift-click sets the compare baseline
const chart = document.getElementById('chart')!;
chart.addEventListener('mousemove', e => { if (!city) return; chartHover = ui.chartIndex(e, city.commits.length); redrawChart(); });
chart.addEventListener('mouseleave', () => { chartHover = null; redrawChart(); });
chart.addEventListener('click', e => {
  if (!city) return;
  const i = ui.chartIndex(e, city.commits.length);
  if (e.shiftKey) { scene.baseline = i; if (scene.colorMode !== 'compare') setColor('compare'); else scene.refresh(false); refreshLegend(); redrawChart(); return; }
  stopPlayback();
  setCommit(i);
});
addEventListener('resize', () => redrawChart());

addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  const typing = (t.tagName === 'INPUT' && !['range', 'checkbox'].includes((t as HTMLInputElement).type)) || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA';
  if (typing) return;
  if (e.code === 'Space') { e.preventDefault(); playing ? stopPlayback() : startPlayback(); }
  else if (e.key === 'ArrowLeft' && city) { stopPlayback(); setCommit(scene.commit - 1); }
  else if (e.key === 'ArrowRight' && city) { stopPlayback(); setCommit(scene.commit + 1); }
  else if (e.key === 'Escape') {
    if (codeOpen) closeCode();
    else if (scene.explodedBuilding >= 0) { scene.collapse(); refreshSelection(); }
    else { closeInfo(); if (scene.authorFilter >= 0) setAuthorFilter(-1); }
  }
  else if (e.key === 'e' || e.key === 'E') toggleExplode();
  else if (e.key === '[') stepPiece(-1);
  else if (e.key === ']') stepPiece(1);
  else if (e.key === 'f' || e.key === 'F') { if (city) scene.frame(); }
  else if (e.key === 't' || e.key === 'T') toggleDayNight();
  else if (e.key === 'h' || e.key === 'H') toggleHacker();
  else if (e.key === '/') { e.preventDefault(); (document.getElementById('search') as HTMLInputElement).focus(); }
});

// ---------------------------------------------------------------- pointer
const canvas = scene.renderer.domElement;
let pending: { x: number; y: number } | null = null;
canvas.addEventListener('pointermove', e => {
  if (e.buttons) return;
  const first = pending === null;
  pending = { x: e.clientX, y: e.clientY };
  if (!first) return;
  requestAnimationFrame(() => {
    const p = pending; pending = null;
    if (!p || !city) return;
    const hit = scene.pick(p.x, p.y);
    if (hit?.kind === 'floor') {
      const f = scene.floorAt(hit.index)!;
      scene.setHover(-1);
      ui.showTip([f.name, `${f.kind} · ${ui.fmt(f.loc)} LOC · complexity ${ui.fmt(f.complexity)} · click for code`], p.x, p.y);
      canvas.style.cursor = 'pointer';
    } else if (hit?.kind === 'building') {
      const i = hit.index, b = city.buildings[i], v = scene.valuesAt(i);
      scene.setHover(i);
      const extra: string[] = [`${b.lang}`, `${ui.fmt(v.loc)} LOC`, `complexity ${ui.fmt(v.complexity)}`];
      if (city.churn) extra.push(`${scene.churnAt(i).commits} commits`);
      ui.showTip([b.path, extra.join(' · ')], p.x, p.y);
      canvas.style.cursor = 'pointer';
    } else {
      scene.setHover(-1);
      if (hit?.kind === 'district') ui.showTip([city.districts[hit.index].path + '/', 'directory · click for stats'], p.x, p.y);
      else ui.showTip(null, 0, 0);
      canvas.style.cursor = hit ? 'pointer' : 'grab';
    }
  });
});
canvas.addEventListener('pointerleave', () => { scene.setHover(-1); ui.showTip(null, 0, 0); });

let down: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', e => {
  if (!down || !city) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
  down = null;
  if (moved || e.button !== 0) return; // orbit / pan drag
  const hit = scene.pick(e.clientX, e.clientY);
  if (hit?.kind === 'floor') openPiece(scene.floorAt(hit.index)!.piece);
  else if (hit?.kind === 'building') selectBuilding(hit.index, false);
  else if (hit?.kind === 'district') selectDistrict(hit.index, false);
  else closeInfo();
});
canvas.addEventListener('dblclick', e => {
  if (!city) return;
  const hit = scene.pick(e.clientX, e.clientY);
  if (hit?.kind === 'building') selectBuilding(hit.index, true);
  else if (hit?.kind === 'district') selectDistrict(hit.index, true);
});

// drag & drop a city.json
addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('drag'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('drag'); });
addEventListener('drop', e => {
  e.preventDefault();
  document.body.classList.remove('drag');
  const f = e.dataTransfer?.files[0];
  if (f) void loadFile(f);
});

// ---------------------------------------------------------------- startup
async function start() {
  const saved = store.get<{ source: string; ref: string; commits: number; churn?: boolean }>('form');
  if (saved) ui.setForm(saved.source, saved.ref, saved.commits, saved.churn ?? true);

  const src = new URLSearchParams(location.search).get('src');
  if (src) {
    try { await fetchCity(src); } catch (e) { ui.setMessage(`Could not load ${src}: ${(e as Error).message}`); }
    return;
  }
  let st: Status;
  try {
    st = await api<Status>('/api/status');
    apiAvailable = true;
  } catch {
    fetchCity('city.json').catch(() => ui.setMessage('No city loaded.\n\nDrop a city.json onto this page.'));
    return;
  }
  if (st.job?.request && !saved) ui.setForm(st.job.request.source, st.job.request.ref, st.job.request.maxCommits, !st.job.request.noChurn);
  if (st.job?.state === 'running') { void watchJob(); return; }
  if (st.hasCity) {
    try { await fetchCity('/api/city'); return; } catch (e) { ui.setJobStatus((e as Error).message, true); }
  }
  ui.setMessage(st.allowLocal
    ? 'Enter a local repo path or a git URL on the left,\nthen press Analyze.'
    : 'Enter a git URL on the left, then press Analyze.');
}
void start();
