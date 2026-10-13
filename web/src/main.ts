import './style.css';
import { CityScene, type Floor, type LinkView } from './scene';
import { showCode, type FileData } from './code';
import { WalkMode, type Destination, type Sym } from './walk/walk';
import type { InteriorArch, InteriorFloor, InteriorSpec } from './walk/interior';
import type { PanelRow } from './walk/codewall';
import type { CardData, CardSection } from './walk/panels';
import type { GameWorld } from './walk/game';
import { buildTour, isTest, KIND_LABEL, type TourStop } from './tour';
import { bindBranchRows, showSwitcher, type LoadedRepo } from './branches';
import { FlowView } from './flow/view';
import { buildGates, layoutGates, type EdgeGate } from './gates';
import type { FlowGraph } from './flow/model';
import { compute, markdown, type Insights } from './insights';
import * as ui from './ui';
import { legend, FINISH_COLOR, TIER_COLORS, tierOfFloors } from './architecture';
import { SCHEMA_VERSION, type City, type ColorMode } from './types';
import type { ThemeName } from './theme';

const scene = new CityScene(document.getElementById('c') as HTMLCanvasElement);
let city: City | null = null;
let totals: { files: number; loc: number }[] = [];
let tab: ui.Tab = 'hotspots';
let insights: Insights | null = null;
let selected = -1;
let selectedDistrict = -1;
let selectedLink = -1;
let apiAvailable = false;

// ---------------------------------------------------------------- multi-repo helpers
const repoOf = (i: number) => city!.buildings[i].repo ?? 0;
const repoName = (k: number) => city!.repos?.[k]?.name ?? city!.repo.name;
/** The building's path inside its own repository. */
function innerPath(i: number) {
  const b = city!.buildings[i];
  return city!.repos ? b.path.slice(repoName(repoOf(i)).length + 1) : b.path;
}
/** Newest analyzed commit of repo k at or before merged commit c (single repo: c itself). */
function repoCommitAt(k: number, c: number): string | null {
  for (let x = c; x >= 0; x--) if ((city!.commits[x].repo ?? 0) === k) return city!.commits[x].hash;
  return null;
}

function linkShown(kind: string, t: ReturnType<typeof ui.linkToggles>): boolean {
  return kind === 'dependency' ? t.deps : kind === 'people' ? t.people : kind === 'api' ? t.api : kind === 'message' ? t.message : t.data;
}
const LINK_CHECK: Record<string, string> = { dependency: 'showdeps', people: 'showpeople', api: 'showapi', message: 'showmsg', data: 'showdb' };

function linkLabel(l: NonNullable<City['links']>[number]): string {
  switch (l.kind) {
    case 'dependency': return `${repoName(l.from)} → ${repoName(l.to)}`;
    case 'api': return `API · ${l.via?.length ?? 0} ${(l.via?.length ?? 0) === 1 ? 'call' : 'calls'}`;
    case 'message': return `${(l.brokers ?? ['messages']).join('/')} · ${new Set((l.via ?? []).map(v => v.l)).size} topics`;
    case 'data': return `database · ${new Set((l.via ?? []).map(v => v.l)).size} ${new Set((l.via ?? []).map(v => v.l)).size === 1 ? 'table' : 'tables'}`;
    default: return `${l.peopleCount ?? 0} shared`;
  }
}

function linkTitle(l: NonNullable<City['links']>[number]): string {
  return l.kind === 'people' ? `${repoName(l.from)} ↔ ${repoName(l.to)}` : `${repoName(l.from)} → ${repoName(l.to)}`;
}

function linkViews(): LinkView[] {
  if (!city?.links?.length) return [];
  const t = ui.linkToggles();
  const out: LinkView[] = [];
  city.links.forEach((l, index) => {
    if (!linkShown(l.kind, t)) return;
    const files = l.files?.length ?? 0;
    out.push({ index, from: l.from, to: l.to, kind: l.kind,
      strength: l.kind === 'dependency' ? Math.min(1, Math.log1p(files + 1) / Math.log(60)) : 0,
      label: linkLabel(l) });
  });
  return out;
}

const ORDER = ['dependency', 'api', 'message', 'data', 'people'];

function linkRows(): ui.LinkRow[] {
  return (city?.links ?? []).map((l, index) => ({
    index, kind: l.kind,
    title: linkTitle(l),
    summary: l.kind === 'people' ? `${l.peopleCount ?? 0} shared contributors` : (l.evidence ?? []).slice(0, 2).join('; '),
    evidence: l.evidence ?? [],
  })).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

function selectLink(index: number) {
  if (!city?.links?.[index]) return;
  const l = city.links[index];
  if (scene.explodedBuilding >= 0) scene.collapse();
  if (codeOpen) closeCode();
  selected = selectedDistrict = -1;
  scene.setSelected(-1);
  scene.setSelectedDistrict(-1);
  selectedLink = index;
  scene.highlightLink(index);
  // make sure the link is drawn even if its kind is toggled off
  const t = ui.linkToggles();
  if (!linkShown(l.kind, t)) {
    (document.getElementById(LINK_CHECK[l.kind]) as HTMLInputElement).checked = true;
    scene.setLinks(linkViews());
  }
  ui.showLink({
    from: repoName(l.from), to: repoName(l.to), kind: l.kind, evidence: l.evidence ?? [],
    files: (l.files ?? []).map(([b, d]) => ({ index: b, path: city!.buildings[b].path, target: city!.districts[d].path })),
    people: l.people ?? [], peopleCount: l.peopleCount ?? 0,
    via: (l.via ?? []).map(v => ({ from: v.a, to: v.b, label: v.l, fromPath: city!.buildings[v.a].path, toPath: city!.buildings[v.b].path })), brokers: l.brokers ?? [],
  }, infoHandlers);
}

// ---------------------------------------------------------------- file pieces (needs the server)
const fileCache = new Map<string, Promise<FileData>>();
let file: FileData | null = null; // for the selected building at the current commit
let fileError = '';
let activePiece = -1;
let floors: Floor[] = [];
let codeOpen = false;

function fetchFile(path: string, commit: string): Promise<FileData> {
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

/** Floors in the order the building stacks them: podium pieces first, then each tier's (file order within). */
function byTier<T extends { name: string }>(i: number, fl: T[]): T[] {
  if (scene.classicBoxes) return fl;
  const t = tierOfFloors(scene.specOf(i), fl.map(x => x.name));
  return fl.map((x, k) => ({ x, t: t[k], k })).sort((a, b) => a.t - b.t || a.k - b.k).map(y => y.x);
}

async function loadPieces(i: number) {
  if (!city) return;
  const path = city.buildings[i].path, commit = scene.commit;
  file = null; fileError = ''; activePiece = -1; floors = [];
  scene.setSkin(-1, '');
  if (!apiAvailable) { fileError = 'Pieces and source need the server (codecity serve).'; return; }
  const hash = repoCommitAt(repoOf(i), commit);
  if (!hash) { fileError = 'This file does not exist at this commit.'; return; }
  try {
    const f = await fetchFile(path, hash);
    if (selected !== i || scene.commit !== commit) return; // selection moved on
    file = f;
    floors = byTier(i, floorsOf(f));
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

// ---------------------------------------------------------------- file history (the "why": origin commit + recent changes)
interface History { path: string; total: number; created?: ui.FileCommit; recent: ui.FileCommit[] }
const historyCache = new Map<string, Promise<History>>();
let historyState: ui.HistoryState | undefined;

function fetchHistory(path: string): Promise<History> {
  let p = historyCache.get(path);
  if (!p) {
    p = api<History>(`/api/history?path=${encodeURIComponent(path)}&n=8`);
    p.catch(() => historyCache.delete(path));
    historyCache.set(path, p);
  }
  return p;
}

async function loadHistory(i: number) {
  if (!city) return;
  if (!apiAvailable) { historyState = { status: 'unavailable' }; return; }
  historyState = { status: 'loading' };
  try {
    const h = await fetchHistory(city.buildings[i].path);
    if (selected !== i) return;
    historyState = { status: 'ready', total: h.total, created: h.created, recent: h.recent };
  } catch {
    if (selected !== i) return;
    historyState = { status: 'unavailable' };
  }
  refreshSelection();
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
  scene.codeLinkMode = store.get<'off' | 'selection' | 'all'>('codelinks.' + name) ?? (name === 'hacker' ? 'all' : 'selection');
  ui.setCodeLinksMode(scene.codeLinkMode);
  scene.setTheme(name);
  scene.refreshCodeLinks();
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
  tourAt = -1; tourBar(); historyCache.clear();
  flowView.reset();
  flowGraphP = null;
  clearGates();
  ui.setMessage('');
  ui.setPathResolver(i => c.buildings[i].path);
  ui.setChurnAvailable(c.churn === true);
  if (!c.churn && ['churn', 'hotspot', 'age', 'owner', 'knowledge'].includes(scene.colorMode)) scene.colorMode = 'language';
  ui.setColorMode(scene.colorMode);
  scene.load(c);
  totals = scene.allTotals();
  ui.showRepo(c);
  repoBtn.disabled = !apiAvailable || !loadedRepos().every(r => r.source);
  renderBranches();
  ui.setupTimeline(c);
  selectedLink = -1;
  ui.setConnRow(!!c.repos?.length && !!c.links?.length);
  ui.setLinkRows(linkRows(), !!c.repos?.length);
  scene.setLinks(linkViews());
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
interface JobInfo { id: number; state: string; stage: string; done: number; total: number; error?: string; source: string; request: { source?: string; sources?: string[]; ref: string; maxCommits: number; noChurn?: boolean } }
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
  const sources = source.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  ui.setJobStatus('starting…');
  ui.setProgress({ done: 0, total: 0 });
  try {
    await api('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources, ref, maxCommits: commits, noChurn: !churn }) });
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
  ui.showArchLegend(legend());
  ui.setArchLegendVisible(!scene.classicBoxes);
  ui.showLegend({ mode: scene.colorMode, city, ownedFiles: ownedFiles(), authorFilter: scene.authorFilter,
    onAuthor: setAuthorFilter, baselineLabel: commitLabel(scene.baseline) });
  ui.setBaselineRow(scene.colorMode === 'compare', commitLabel(scene.baseline));
}

function refreshInsights() {
  if (!city) return;
  insights = compute(city, scene, 15);
  ui.showInsights(insights, tab, city.churn, scene.authorFilter, scene.timeOf(), {
    onLink: i => selectLink(i),
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
  const i = city!.buildings.findIndex(b => b.path === path);
  const k = i >= 0 ? repoOf(i) : 0;
  const repo = city!.repos?.[k];
  const hash = repoCommitAt(k, scene.commit) ?? city!.commits[scene.commit].hash;
  const remote = (repo ? repo.remote : city!.repo.remote) ?? '';
  const localPath = repo ? repo.path : city!.repo.path;
  if (i >= 0) path = innerPath(i);
  const gh = remote.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  const gl = remote.match(/gitlab\.com[/:](.+?)(?:\.git)?\/?$/);
  const enc = path.split('/').map(encodeURIComponent).join('/');
  if (gh) {
    out.push({ label: 'GitHub ↗', href: `https://github.com/${gh[1]}/${gh[2]}/blob/${hash}/${enc}` });
    out.push({ label: 'History ↗', href: `https://github.com/${gh[1]}/${gh[2]}/commits/${hash}/${enc}` });
  } else if (gl) {
    out.push({ label: 'GitLab ↗', href: `https://gitlab.com/${gl[1]}/-/blob/${hash}/${enc}` });
  }
  if (localPath) out.push({ label: 'Open in VS Code', href: `vscode://file${encodeURI(localPath.replace(/\\/g, '/'))}/${enc}` });
  return out;
}

const infoHandlers: ui.InfoHandlers = {
  onDistrict: d => selectDistrict(d, true),
  onPiece: k => openPiece(k),
  onExplode: () => toggleExplode(),
  onCode: () => openPiece(activePiece >= 0 ? activePiece : (floors[0]?.piece ?? 0)),
  onClose: () => closeInfo(),
  onPick: i => selectBuilding(i, true),
  onGateFlow: id => openFlowAt(id),
  onGate: k => selectGate(k),
  onGateCode: line => openCodeAt(line),
  onZoomDistrict: () => { if (selectedDistrict >= 0) scene.focusDistrict(selectedDistrict); },
};

/** A gate on the edge of a city: highlight it, draw its streets to the files behind it and list them. */
function selectGate(k: number) {
  const c = city, e = edgeGates[k];
  if (!c || !e) return;
  if (codeOpen) closeCode();
  selected = -1; selectedDistrict = -1; selectedGate = k;
  scene.setSelected(-1);
  scene.setSelectedDistrict(-1);
  scene.highlightGate(k);
  scene.showGateStreets(e.gates.filter(g => scene.exists(g.building)).map(g => ({ gate: k, building: g.building })));
  ui.showGate({
    label: e.label, dir: e.dir, kind: e.kind, id: e.id,
    repo: c.repos?.[e.repo]?.name ?? c.repo?.name ?? '',
    leads: e.gates.map(g => ({ building: g.building, path: c.buildings[g.building].path, line: g.line, code: g.code })),
  }, infoHandlers);
  const first = e.gates.find(g => scene.exists(g.building));
  if (first) scene.focus(first.building);
}

function openCodeAt(line: number | undefined) {
  if (!file) return;
  let k = floors[0]?.piece ?? 0;
  if (line !== undefined) {
    const inside = file.pieces.map((p, n) => ({ p, n })).filter(x => x.p.start <= line && line <= x.p.end).sort((a, b) => (a.p.end - a.p.start) - (b.p.end - b.p.start))[0];
    if (inside) k = inside.n;
  }
  openPiece(k);
}

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
    gates: gatesOn ? (gateByBuilding.get(i) ?? []).flatMap(k => edgeGates[k].gates.filter(g => g.building === i).map(g => ({ id: g.id, dir: g.dir, kind: g.kind, label: g.label, line: g.line, edge: k }))) : undefined,
    links: links(b.path),
    pieces: piecesState(),
    looks: scene.whyLooks(i),
    deps: {
      imports: (b.imp ?? []).filter(j => scene.exists(j)).map(j => ({ index: j, path: c.buildings[j].path })),
      importDirs: (b.impd ?? []).map(d => ({ district: d, path: c.districts[d].path })),
      importedBy: scene.importersOf(i).map(k => ({ index: k, path: c.buildings[k].path })),
    },
    history: historyState,
  };
}

function selectBuilding(i: number, fly: boolean) {
  if (!city || i < 0 || !scene.exists(i)) return;
  if (selectedLink >= 0) { selectedLink = -1; scene.highlightLink(-1); }
  if (i !== selected) {
    if (scene.explodedBuilding >= 0) scene.collapse();
    if (codeOpen) closeCode();
    selected = i;
    void loadPieces(i);
    void loadHistory(i);
  }
  selected = i;
  selectedDistrict = -1;
  scene.setSelectedDistrict(-1);
  scene.setSelected(i);
  selectedGate = -1; scene.highlightGate(-1);
  scene.showGateStreets(gatesOn ? (gateByBuilding.get(i) ?? []).map(k => ({ gate: k, building: i })) : []);
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
  if (selectedLink >= 0) { selectedLink = -1; scene.highlightLink(-1); }
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
  selectedLink = -1;
  scene.highlightLink(-1);
  if (scene.explodedBuilding >= 0) scene.collapse();
  if (codeOpen) closeCode();
  file = null;
  scene.setSkin(-1, '');
  selected = selectedDistrict = -1;
  scene.setSelected(-1);
  scene.setSelectedDistrict(-1);
  if (selectedGate >= 0) { selectedGate = -1; scene.highlightGate(-1); }
  scene.showGateStreets([]);
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

// ---------------------------------------------------------------- guided tour (overview)
let tourStops: TourStop[] = [];
let tourAt = -1;

function tourBar() {
  const bar = document.getElementById('tourbar')!;
  if (tourAt < 0 || !city) { bar.hidden = true; return; }
  const st = tourStops[tourAt];
  const mk = (tag: string, cls: string, text: string) => { const e = document.createElement(tag); e.className = cls; e.textContent = text; return e; };
  const btn = (text: string, on: () => void, primary = false) => { const b = mk('button', primary ? 'primary' : '', text) as HTMLButtonElement; b.onclick = on; return b; };
  const row = mk('div', 'tbtns', '');
  row.append(btn('◀ Back (B)', () => tourGo(tourAt - 1)), btn(tourAt + 1 < tourStops.length ? 'Next (N) ▶' : 'Finish', () => tourGo(tourAt + 1), true),
    btn('Walk here', () => { const b = st.building; endTour(); startWalk(b); }), btn('End', () => endTour()));
  bar.replaceChildren(mk('div', 'tk', `TOUR ${tourAt + 1}/${tourStops.length} · ${st.title.toUpperCase()}`), mk('div', 'tp', city.buildings[st.building].path),
    ...st.why.map(w => mk('div', 'tw', w)), row);
  bar.hidden = false;
}

function tourGo(k: number) {
  if (k >= tourStops.length) { endTour(); ui.setJobStatus('Tour complete — try walk mode (G) to explore on foot.'); return; }
  if (k < 0) return;
  tourAt = k;
  selectBuilding(tourStops[k].building, true);
  tourBar();
}

function startTour() {
  if (!city) return;
  stopPlayback();
  tourStops = buildTour(city, scene);
  if (!tourStops.length) { ui.setJobStatus('No tour for this city: it needs docs, entry points or imports.', true); return; }
  tourGo(0);
}

function endTour() { tourAt = -1; tourBar(); }
document.getElementById('tourbtn')!.addEventListener('click', () => (tourAt >= 0 ? endTour() : startTour()));

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
function setBuildings(classic: boolean) {
  scene.setClassic(classic);
  store.set('classic', classic);
  ui.setArchLegendVisible(!classic);
  refreshSelection();
}

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
  onLinksToggle: () => { scene.setLinks(linkViews()); },
  onBuildings: setBuildings,
  onCodeLinks: m => { scene.codeLinkMode = m; store.set('codelinks.' + scene.theme.name, m); scene.refreshCodeLinks(); },
  onGates: on => { void setGatesOn(on); },
  onCopyReport: () => {
    if (!city || !insights) return;
    const md = markdown(city, scene, insights, windowLabel() || 'all history');
    navigator.clipboard?.writeText(md).then(() => ui.flashCopied('Copied'), () => ui.flashCopied('Clipboard blocked'));
  },
});
tab = store.get<ui.Tab>('tab') ?? 'hotspots';
if (store.get<boolean>('classic')) { scene.setClassic(true); ui.setBuildingsMode(true); }

// ---------------------------------------------------------------- branches
const sourceBox = document.getElementById('source') as HTMLTextAreaElement;
const renderBranches = bindBranchRows(sourceBox, document.getElementById('branches')!, () => apiAvailable, src => loadedRepos().find(r => r.source === src)?.name);
const repoBtn = document.getElementById('repo') as HTMLButtonElement;

function loadedRepos(): LoadedRepo[] {
  if (!city) return [];
  return city.repos?.length ? city.repos.map(r => ({ name: r.name, source: r.source, ref: r.ref })) : [{ name: city.repo.name, source: city.repo.source, ref: city.repo.ref }];
}

/** Re-analyze the loaded city with repository k on another branch (the others keep theirs). */
function switchBranch(k: number, ref: string) {
  const text = loadedRepos().map((r, j) => {
    const x = j === k ? ref : r.ref;
    return x && x !== 'HEAD' ? `${r.source} ${x}` : r.source;
  }).join('\n');
  const commits = Math.max(1, parseInt((document.getElementById('commits') as HTMLInputElement).value, 10) || 100);
  const churn = (document.getElementById('churn') as HTMLInputElement).checked;
  ui.setForm(text, '', commits, churn);
  renderBranches();
  void submit(text, '', commits, churn);
}

repoBtn.addEventListener('click', () => {
  if (!city || !apiAvailable) return;
  showSwitcher(document.getElementById('branchpop')!, repoBtn, loadedRepos(), switchBranch);
});

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
  if (flowView.open) return; // the flow view has its own keys
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
  else if (e.key === 'u' || e.key === 'U') { if (tourAt >= 0) endTour(); else startTour(); }
  else if ((e.key === 'n' || e.key === 'N') && tourAt >= 0) tourGo(tourAt + 1);
  else if ((e.key === 'b' || e.key === 'B') && tourAt >= 0) tourGo(tourAt - 1);
  else if (e.key === 'b' || e.key === 'B') {
    const classic = !scene.classicBoxes;
    ui.setBuildingsMode(classic);
    setBuildings(classic);
  }
  else if (e.key === 'l' || e.key === 'L') {
    const order = ['selection', 'all', 'off'] as const;
    scene.codeLinkMode = order[(order.indexOf(scene.codeLinkMode) + 1) % 3];
    ui.setCodeLinksMode(scene.codeLinkMode);
    store.set('codelinks.' + scene.theme.name, scene.codeLinkMode);
    scene.refreshCodeLinks();
  }
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
    if (hit?.kind === 'link') {
      const l = city.links![hit.index];
      scene.setHover(-1);
      ui.showTip([linkTitle(l),
        (l.evidence ?? []).slice(0, 2).join(' · ') + ' · click for details'], p.x, p.y);
      canvas.style.cursor = 'pointer';
    } else if (hit?.kind === 'gate') {
      const e = edgeGates[hit.index];
      scene.setHover(-1);
      ui.showTip([`${e.dir === 'in' ? 'Entrance' : 'Exit'} · ${e.label}`, `${e.gates.length} ${e.gates.length === 1 ? 'file' : 'files'} behind it · click to follow the street`], p.x, p.y);
      canvas.style.cursor = 'pointer';
    } else if (hit?.kind === 'floor') {
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
  if (hit?.kind === 'link') selectLink(hit.index);
  else if (hit?.kind === 'gate') selectGate(hit.index);
  else if (hit?.kind === 'floor') openPiece(scene.floorAt(hit.index)!.piece);
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
  if (st.job?.request && !saved) {
    const r = st.job.request;
    ui.setForm((r.sources?.length ? r.sources : [r.source ?? '']).join('\n'), r.ref, r.maxCommits, !r.noChurn);
  }
  renderBranches();
  if (st.job?.state === 'running') { void watchJob(); return; }
  if (st.hasCity) {
    try { await fetchCity('/api/city'); return; } catch (e) { ui.setJobStatus((e as Error).message, true); }
  }
  ui.setMessage(st.allowLocal
    ? 'Enter a local repo path or a git URL on the left,\nthen press Analyze.'
    : 'Enter a git URL on the left, then press Analyze.');
}
void start();

// ---------------------------------------------------------------- walk mode
const MAX_FLOORS = 60;
let pathIndex = new Map<string, number>();

function interiorFloors(f: FileData): InteriorFloor[] {
  const fl = floorsOf(f).map(x => {
    const p = f.pieces[x.piece];
    return { name: x.name, kind: x.kind, start: p.start, end: p.end, loc: x.loc, complexity: x.complexity, piece: x.piece };
  }).filter(x => x.kind !== 'imports' || x.loc > 0);
  if (!fl.length) {
    const n = f.content.split('\n').length;
    return [{ name: f.path.split('/').pop() ?? f.path, kind: 'file', start: 1, end: n, loc: n, complexity: 0, piece: 0 }];
  }
  return fl.slice(0, MAX_FLOORS);
}

const walk = new WalkMode(scene, {
  async interiorSpec(i, go, symbols): Promise<InteriorSpec> {
    if (!apiAvailable) throw new Error('walking into buildings needs the server (codecity serve)');
    const c = city!;
    const hash = repoCommitAt(repoOf(i), scene.commit);
    if (!hash) throw new Error('file does not exist at this commit');
    const f = await fetchFile(c.buildings[i].path, hash);
    // storeys follow the building's tiers, as seen outside: the podium's pieces first, then each tier's (file order within)
    const sp0 = scene.specOf(i);
    const rawFloors = interiorFloors(f);
    const rawTier = scene.classicBoxes ? rawFloors.map(() => 0) : tierOfFloors(sp0, rawFloors.map(fl => fl.name));
    const floors = rawFloors.map((fl, k) => ({ fl, t: rawTier[k], k })).sort((a, b) => a.t - b.t || a.k - b.k).map(x => x.fl);
    const lines = f.content.split('\n');
    const b = c.buildings[i];
    const v = scene.valuesAt(i);
    const dest = (j: number, line?: number): Destination => ({ building: j, line, label: c.buildings[j].path + (line ? `:${line}` : '') });
    const firstIn = (d: number) => scene.districtMembers(d)[0] ?? -1;
    const lobby: PanelRow[] = [
      { text: b.path, color: '#bff8ff', size: 30 },
      { text: `${b.lang} · ${ui.fmt(v.loc)} LOC · complexity ${ui.fmt(v.complexity)} · ${floors.length} floors`, color: '#7fb8c8', size: 28 },
    ];
    // why the building looks the way it does (shape, facade, roof)
    for (const t of scene.whyLooks(i).slice(0, 3)) lobby.push({ text: t, color: '#8fd9a8', size: 24 });
    const own = b.own ? c.authors?.[b.own[0]] : undefined;
    if (own) lobby.push({ text: `owner: ${own.name}`, color: '#7fb8c8', size: 28 });
    const imps = (b.imp ?? []).filter(j => scene.exists(j));
    if (imps.length || b.impd?.length) {
      lobby.push({ text: '' }, { text: 'IMPORTS  (click to teleport)', color: '#5ff0ff', size: 28 });
      for (const j of imps.slice(0, 8)) lobby.push({ text: c.buildings[j].path, action: () => go(dest(j)), size: 28 });
      for (const d of (b.impd ?? []).slice(0, 6)) { const j = firstIn(d); if (j >= 0) lobby.push({ text: c.districts[d].path + '/', action: () => go(dest(j)), size: 28 }); }
    }
    const by = scene.importersOf(i);
    if (by.length) {
      lobby.push({ text: '' }, { text: 'IMPORTED BY', color: '#ff8adf', size: 28 });
      for (const k of by.slice(0, 8)) lobby.push({ text: c.buildings[k].path, action: () => go(dest(k)), size: 28 });
    }
    const sp = scene.specOf(i);
    const tierOf = tierOfFloors(sp, floors.map(fl => fl.name));
    const multi = !scene.classicBoxes && sp.tiers.length > 1;
    const directory: PanelRow[] = floors.map((fl, k) => ({
      text: `L${k + 1}  ${fl.name}`, hint: multi ? `${fl.loc} LOC · ${sp.tiers[tierOf[k]].name}` : `${fl.loc} LOC`, size: 30,
      color: multi ? TIER_COLORS[tierOf[k] % TIER_COLORS.length] : undefined,
      action: () => go({ building: i, line: fl.start, label: `${fl.name} — ${b.path}:${fl.start}` }),
    }));
    const references = (fl: InteriorFloor): PanelRow[] => {
      if (!symbols) return [{ text: '(indexing definitions…)', size: 28 }];
      const seen = new Set<string>();
      const rows: PanelRow[] = [];
      const re = /[A-Za-z_$][\w$]*/g;
      for (const line of lines.slice(fl.start - 1, fl.end)) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) && rows.length < 16) {
          const name = m[0];
          if (seen.has(name) || name.length < 3) continue;
          seen.add(name);
          const defs = (symbols.get(name) ?? []).filter((d: Sym) => !(d[2] === b.path && d[3] >= fl.start && d[3] <= fl.end));
          if (!defs.length) continue;
          const d = defs.find((x: Sym) => x[2] === b.path) ?? defs[0];
          const j = pathIndex.get(d[2]) ?? -1;
          if (j < 0) continue;
          rows.push({ text: `${name}  →  ${d[2].split('/').slice(-2).join('/')}:${d[3]}`, size: 28,
            action: () => go({ building: j, line: d[3], label: `${d[0]} — ${d[2]}:${d[3]}` }) });
        }
      }
      return rows.length ? rows : [{ text: '(no definitions from elsewhere)', size: 28 }];
    };
    const arch: InteriorArch | undefined = scene.classicBoxes ? undefined : {
      facade: sp.facade, finish: FINISH_COLOR[sp.facade],
      tiers: sp.tiers.map((t, k) => ({ name: t.name, s: t.s, color: TIER_COLORS[k % TIER_COLORS.length] })),
      tierOf,
      roof: scene.whyLooks(i).filter(l => l.startsWith('Roof:')).map(l => l.slice(6)),
    };
    return { path: b.path, lang: b.lang, lines, floors, lobby, directory, references,
      glyphs: scene.glyphTexture, circuit: scene.circuitTexture, arch };
  },
  buildingByPath: p => pathIndex.get(p) ?? -1,
  buildingName: i => city!.buildings[i].path,
  importsOf: i => city!.buildings[i].imp ?? [],
  symbols: async () => (await api<{ symbols: Sym[] }>('/api/symbols')).symbols ?? [],
  onExit: () => { onCommitChanged(); },
  async floors(i) {
    const hash = repoCommitAt(repoOf(i), scene.commit);
    if (!hash) throw new Error('file does not exist at this commit');
    const f = await fetchFile(city!.buildings[i].path, hash);
    return byTier(i, floorsOf(f)).map(x => ({ ...x, start: f.pieces[x.piece]?.start })).slice(0, MAX_FLOORS);
  },
  async card(i, act) {
    const c = city!, b = c.buildings[i], v = scene.valuesAt(i);
    const hash = repoCommitAt(repoOf(i), scene.commit);
    const [file, hist] = await Promise.all([
      hash ? fetchFile(b.path, hash).catch(() => null) : Promise.resolve(null),
      fetchHistory(b.path).catch(() => null),
    ]);
    const stop = walkTour.find(t => t.building === i);
    const ch = scene.churnAt(i);
    const own = b.own ? c.authors?.[b.own[0]] : undefined;
    const sub = [b.lang, `${ui.fmt(v.loc)} LOC`, `complexity ${ui.fmt(v.complexity)}`];
    if (c.churn) sub.push(`${ch.allCommits} commits`);
    const sections: CardSection[] = [];
    const imports = (b.imp ?? []).filter(j => scene.exists(j));
    const by = scene.importersOf(i);
    const role: string[] = [];
    if (by.length) role.push(`Used by ${by.length} file${by.length === 1 ? '' : 's'}${by.length >= 5 ? ' — a foundation: learn its names first' : ''}.`);
    if (imports.length + (b.impd?.length ?? 0)) role.push(`Uses ${imports.length + (b.impd?.length ?? 0)} part${imports.length + (b.impd?.length ?? 0) === 1 ? '' : 's'} of this project.`);
    if (!by.length && !imports.length) role.push(isTest(b.path) ? 'A test: shows how other code is meant to be used.' : 'Stands alone: no imports to or from this project.');
    if (c.churn && scene.hotspotScore(i) > 0) {
      const rank = scene.topHotspots(20).findIndex(h => h.index === i);
      if (rank >= 0 && rank < 10) role.push(`Hotspot #${rank + 1}: changes often and is complex.`);
    }
    sections.push({ title: 'Role', lines: role });
    if (own) sections.push({ title: 'People', lines: [`${own.name} wrote ${Math.round((b.own![1] / Math.max(1, scene.totalCommits(i))) * 100)}% of its commits · ${b.own![2]} author${b.own![2] === 1 ? '' : 's'}` +
      (scene.risk(i) === 4 ? ' · owner inactive' : '')] });
    if (hist?.created) {
      const k = hist.created;
      const lines = [`${k.date.slice(0, 10)} · ${k.author} · ${k.hash.slice(0, 7)}`, `“${k.subject}”`];
      if (k.body) lines.push(k.body.length > 260 ? k.body.slice(0, 259) + '…' : k.body);
      sections.push({ title: 'Origin story — the commit that created it', lines });
    }
    const recent = (hist?.recent ?? []).filter(k => k.hash !== hist?.created?.hash).slice(0, 4);
    if (recent.length) sections.push({ title: `Recent changes (${hist!.total} in total)`, lines: recent.map(k => `${k.date.slice(0, 10)}  ${k.subject}`) });
    if (file) {
      const fl = floorsOf(file).filter(x => x.kind !== 'imports' && x.kind !== 'scope').slice(0, 10);
      if (fl.length) sections.push({ title: 'Pieces (click to go in at that floor)', items: fl.map(x => {
        const start = file.pieces[x.piece]?.start ?? 1;
        return { text: x.name, sub: `${x.kind} · ${x.loc} LOC`, go: () => act.enterAt(i, start, `${x.name} — ${b.path}:${start}`) };
      }) });
    }
    if (imports.length) sections.push({ title: 'Imports', items: imports.slice(0, 8).map(j => ({ text: c.buildings[j].path, go: () => act.visit(j) })) });
    if (by.length) sections.push({ title: 'Imported by', items: by.slice(0, 8).map(j => ({ text: c.buildings[j].path, go: () => act.visit(j) })) });
    const cpl = (b.cpl ?? []).filter(([j]) => scene.exists(j)).slice(0, 4);
    if (cpl.length) sections.push({ title: 'Changes together with', items: cpl.map(([j, shared]) => ({ text: c.buildings[j].path, sub: `${shared} commits`, go: () => act.visit(j) })) });
    const data: CardData = { title: b.path, subtitle: sub.join(' · '), tag: stop ? KIND_LABEL[stop.kind] : undefined, sections };
    return { data, origin: !!hist?.created };
  },
  tour: () => (walkTour = buildTour(city!, scene)),
  gameWorld: () => gameWorld(),
  topDistricts: () => topDistricts().map(d => ({ path: d.path, name: d.name, x: d.x, z: d.z, w: d.w, d: d.d })),
  mapLabels: () => {
    const c = city!;
    const lab = c.repos ? c.districts.filter(d => d.depth === 0) : topDistricts();
    return lab.map(d => ({ text: (d.name || d.path) + '/', x: d.x + d.w / 2, z: d.z + d.d / 2 }));
  },
  searchFiles: q => scene.search(q),
});

let walkTour: TourStop[] = [];

/** Directories one level below the repository root(s). */
function topDistricts() {
  return city!.districts.filter(d => d.depth === 1 && scene.districtMembers(city!.districts.indexOf(d)).length > 0);
}

/** One landmark per rooftop role (spire, antenna, tanks, …), the most-imported file of each kind first. */
function landmarkBuildings(live: number[], files: ({ test: boolean } | null)[]): number[] {
  const out: number[] = [];
  for (const role of ['entry', 'serve', 'db', 'exec', 'files', 'call'] as const) {
    const cand = live.filter(i => !files[i]!.test && !out.includes(i) && scene.specOf(i).roles.includes(role))
      .sort((a, b) => scene.importersOf(b).length - scene.importersOf(a).length || a - b);
    if (cand.length) out.push(cand[0]);
  }
  return out;
}

function gameWorld(): GameWorld {
  const c = city!;
  const topOf = (d: number): string => {
    let x = d;
    while (x >= 0 && c.districts[x].depth > 1) x = c.districts[x].parent;
    return x >= 0 && c.districts[x].depth === 1 ? c.districts[x].path : '';
  };
  const files = c.buildings.map((b, i) => scene.exists(i) ? {
    path: b.path, name: b.name, dir: c.districts[b.district].path, top: topOf(b.district), loc: scene.valuesAt(i).loc,
    code: scene.isCode(i), test: isTest(b.path), lang: b.lang,
  } : null);
  const stops = walkTour.length ? walkTour : buildTour(c, scene);
  const live = files.map((f, i) => (f ? i : -1)).filter(i => i >= 0);
  const fanOut = (i: number) => (c.buildings[i].imp?.length ?? 0) + (c.buildings[i].impd?.length ?? 0);
  const core = live.filter(i => files[i]!.code && !files[i]!.test && scene.importersOf(i).length >= 2)
    .sort((a, b) => scene.importersOf(b).length - scene.importersOf(a).length || files[b]!.loc - files[a]!.loc);
  const hubs = live.filter(i => files[i]!.code && !files[i]!.test && fanOut(i) >= 3).sort((a, b) => fanOut(b) - fanOut(a));
  const key = c.repos ? c.repos.map(r => r.remote || r.name).join('+') : (c.repo.remote || c.repo.path || c.repo.name);
  return {
    key, files,
    importsOf: i => [...(c.buildings[i].imp ?? []).filter(j => scene.exists(j))],
    importersOf: i => scene.importersOf(i),
    entries: stops.filter(s => s.kind === 'entry').map(s => s.building),
    readme: stops.filter(s => s.kind === 'readme').map(s => s.building),
    core, hubs,
    landmarks: landmarkBuildings(live, files),
    hotspots: c.churn ? scene.topHotspots(6).map(h => h.index).filter(i => !files[i]!.test) : [],
    tops: [...new Set(files.filter(f => f && f.top).map(f => f!.top))],
  };
}

function startWalk(at = -1) {
  if (!city) return;
  if (!apiAvailable) { ui.setJobStatus('Walk mode needs the server (codecity serve).', true); return; }
  stopPlayback();
  closeInfo();
  if (scene.commit !== city.commits.length - 1) setCommit(city.commits.length - 1);
  if (scene.theme.name !== 'hacker') applyTheme('hacker');
  pathIndex = new Map(city.buildings.map((b, i) => [b.path, i]));
  walk.start(at);
}
document.getElementById('walk')!.addEventListener('click', () => startWalk());
addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (walk.active || flowView.open || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
  if (e.key === 'g' || e.key === 'G') startWalk();
});

// debug handle for automated checks (no behaviour change)
(window as unknown as { __codecity: unknown }).__codecity = { scene, walk };

// ---------------------------------------------------------------- entrances and exits (doors)
let flowGraphP: Promise<FlowGraph> | null = null;
function flowGraph(): Promise<FlowGraph> {
  if (!apiAvailable) return Promise.reject(new Error('the flow view needs the server (codecity serve)'));
  if (!flowGraphP) {
    flowGraphP = api<FlowGraph>('/api/flow');
    flowGraphP.catch(() => { flowGraphP = null; });
  }
  return flowGraphP;
}

let gatesOn = false;
let edgeGates: EdgeGate[] = [];
let gateByBuilding = new Map<number, number[]>(); // building → indices into edgeGates
let selectedGate = -1;

function clearGates() {
  edgeGates = []; gateByBuilding = new Map(); selectedGate = -1;
  scene.setGates([]);
  scene.setGatesVisible(false);
  ui.setGateCount('');
}

async function setGatesOn(on: boolean) {
  gatesOn = on;
  const box = document.getElementById('showgates') as HTMLInputElement;
  box.checked = on;
  if (!on) { scene.setGatesVisible(false); selectedGate = -1; ui.setGateCount(''); refreshSelection(); return; }
  const c = city;
  if (!c) return;
  ui.setGateCount('reading…');
  try {
    const g = await flowGraph();
    if (city !== c || !gatesOn) return;
    const pathIndex = new Map(c.buildings.map((b, i) => [b.path, i] as const));
    const gates = buildGates(g, p => pathIndex.get(p) ?? -1);
    edgeGates = layoutGates(gates, b => c.buildings[b].repo ?? 0, r => scene.cityRect(r), b => c.buildings[b].x + c.buildings[b].w / 2, scene.gateWidth, scene.gateOffset);
    gateByBuilding = new Map();
    edgeGates.forEach((e, k) => { for (const g of e.gates) { const l = gateByBuilding.get(g.building); if (l) l.push(k); else gateByBuilding.set(g.building, [k]); } });
    scene.setGates(edgeGates.map(e => ({ x: e.x, z: e.z, dir: e.dir })));
    scene.setGatesVisible(true);
    const ins = gates.filter(x => x.dir === 'in').length, outs = gates.length - ins;
    ui.setGateCount(`${ins} in · ${outs} out`);
    refreshSelection();
  } catch (e) {
    box.checked = gatesOn = false;
    ui.setGateCount(apiAvailable ? 'failed' : 'needs the server');
    console.warn('doors:', (e as Error).message);
  }
}

// ---------------------------------------------------------------- flow view (a diagram of how the code runs)
const flowView = new FlowView({
  load: () => flowGraph(),
  file: async (path, commit) => {
    const f = await fetchFile(path, commit);
    return { content: f.content, lang: f.lang };
  },
  showInCity: path => {
    flowView.close();
    const i = city ? city.buildings.findIndex(b => b.path === path) : -1;
    if (i >= 0 && scene.exists(i)) selectBuilding(i, true);
  },
  onClose: () => {
    scene.paused = false;
    document.getElementById('flowbtn')!.classList.remove('on');
  },
});

function openFlowAt(id: number) {
  if (!city || walk.active) return;
  stopPlayback();
  scene.paused = true;
  document.getElementById('flowbtn')!.classList.add('on');
  void flowView.focusId(id);
}

function openFlow() {
  if (!city || walk.active) return;
  stopPlayback();
  scene.paused = true;
  document.getElementById('flowbtn')!.classList.add('on');
  if (selected >= 0) void flowView.focusPath(city.buildings[selected].path);
  else void flowView.show();
}
document.getElementById('flowbtn')!.addEventListener('click', () => (flowView.open ? flowView.close() : openFlow()));
addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (walk.active || flowView.open || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
  if (e.key === 'd' || e.key === 'D') openFlow();
});
