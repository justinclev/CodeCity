import './style.css';
import { CityScene } from './scene';
import * as ui from './ui';
import type { City } from './types';

const scene = new CityScene(document.getElementById('c') as HTMLCanvasElement);
let city: City | null = null;

// ---------------------------------------------------------------- loading
function isCity(x: unknown): x is City {
  const c = x as City;
  return !!c && c.version === 2 && Array.isArray(c.districts) && Array.isArray(c.buildings) &&
    Array.isArray(c.commits) && c.commits.length > 0 && !!c.bounds;
}

function show(c: City) {
  if (c.buildings.length === 0) { ui.setMessage('This repository has no countable source files.'); return; }
  stopPlayback();
  city = c;
  ui.setMessage('');
  scene.load(c);
  ui.showCityInfo(c);
  ui.setChurnAvailable(c.churn === true);
  scene.colorMode = (document.getElementById('color') as HTMLSelectElement).value as typeof scene.colorMode;
  scene.refresh(true);
  ui.setupTimeline(c);
  onCommitChanged();
  ui.showInfo(null);
}

async function fetchCity(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const data: unknown = await res.json();
  if (!isCity(data)) throw new Error('not a city.json (schema version 2)');
  show(data);
}

async function loadFile(f: File) {
  try {
    const data: unknown = JSON.parse(await f.text());
    if (!isCity(data)) throw new Error('not a city.json (schema version 2)');
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
      const st = await api<Status>('/api/status');
      const j = st.job;
      if (!j) break;
      if (j.state === 'running') {
        ui.setJobStatus(j.total ? `${j.stage} ${j.done}/${j.total}` : `${j.stage}…`);
        await new Promise(r => setTimeout(r, 400));
        continue;
      }
      if (j.state === 'done') {
        ui.setJobStatus('');
        await fetchCity('/api/city');
      } else if (j.state === 'error') {
        ui.setJobStatus(j.error ?? 'analysis failed', true);
      } else {
        ui.setJobStatus('cancelled');
      }
      break;
    }
  } catch (e) {
    ui.setJobStatus((e as Error).message, true);
  } finally {
    watching = false;
    ui.setBusy(false);
  }
}

function remember(source: string, ref: string, commits: number, churn: boolean) {
  try { localStorage.setItem('codecity.form', JSON.stringify({ source, ref, commits, churn })); } catch { /* storage unavailable */ }
}
function recall(): { source: string; ref: string; commits: number; churn?: boolean } | null {
  try { return JSON.parse(localStorage.getItem('codecity.form') ?? 'null'); } catch { return null; }
}

async function submit(source: string, ref: string, commits: number, churn: boolean) {
  remember(source, ref, commits, churn);
  ui.setJobStatus('starting…');
  try {
    await api('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, ref, maxCommits: commits, noChurn: !churn }),
    });
    void watchJob();
  } catch (e) {
    ui.setJobStatus((e as Error).message, true);
  }
}

// ---------------------------------------------------------------- playback
let playing = false;
let speed = 3; // commits per second
let acc = 0;
let last = 0;

function onCommitChanged() {
  if (!city) return;
  ui.showCommit(city, scene.commit);
  const t = scene.totals();
  ui.showStats(t.files, t.loc, city);
  updateHotspots();
  refreshSelection();
}

function updateHotspots() {
  if (!city) return;
  const show = city.churn && (scene.colorMode === 'churn' || scene.colorMode === 'hotspot');
  ui.showHotspots(show ? scene.topHotspots(10).map(h => ({ ...h, path: city!.buildings[h.index].path })) : null);
}

function setCommit(i: number) {
  scene.setCommit(i);
  onCommitChanged();
}

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
  playing = true;
  acc = 0;
  last = performance.now();
  ui.setPlaying(true);
  requestAnimationFrame(tick);
}

function stopPlayback() { playing = false; ui.setPlaying(false); }

// ---------------------------------------------------------------- selection / hover
let selected = -1;

function infoFor(i: number) {
  const b = city!.buildings[i];
  const v = scene.valuesAt(i);
  return { name: b.name, path: b.path, lang: b.lang, district: city!.districts[b.district].path,
    loc: v.loc, lines: v.lines, bytes: v.bytes, series: scene.series(i), commit: scene.commit,
    churn: city!.churn ? { ...scene.churnAt(i), windowLabel: scene.churnWindow ? `last ${scene.churnWindow} samples` : 'all so far' } : undefined };
}

function refreshSelection() {
  if (selected >= 0 && city) {
    if (scene.valuesAt(selected).exists) ui.showInfo(infoFor(selected));
    else { selected = -1; scene.setSelected(-1); ui.showInfo(null); }
  }
}

bindControls();
function bindControls() {
  ui.bindControls({
    onMetric: v => { scene.metric = v; scene.refresh(false); },
    onScale: v => { scene.scale = v; scene.refresh(false); },
    onMult: v => { scene.mult = v; scene.refresh(false); },
    onColor: v => { scene.colorMode = v; scene.refresh(false); updateHotspots(); },
    onChurnWindow: v => { scene.churnWindow = v; scene.refresh(false); updateHotspots(); refreshSelection(); },
    onHotspot: i => { scene.focus(i); selected = i; scene.setSelected(i); ui.showInfo(infoFor(i)); },
    onSearch: q => { scene.search(q); },
    onSubmit: (s, r, c, ch) => void submit(s, r, c, ch),
    onCancel: () => void api('/api/cancel', { method: 'POST' }).catch(() => undefined),
    onScrub: i => { stopPlayback(); setCommit(i); },
    onPlay: () => (playing ? stopPlayback() : startPlayback()),
    onChanges: v => scene.setShowChanges(v),
    onSpeed: v => { speed = v; },
  });
}

addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox') return;
  if (t.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); playing ? stopPlayback() : startPlayback(); }
  else if (e.code === 'ArrowLeft' && city) { stopPlayback(); setCommit(scene.commit - 1); }
  else if (e.code === 'ArrowRight' && city) { stopPlayback(); setCommit(scene.commit + 1); }
});

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
    const i = scene.pick(p.x, p.y);
    scene.setHover(i);
    ui.showTip(i >= 0 ? [city.buildings[i].path, `${city.buildings[i].lang} · ${ui.fmt(scene.valuesAt(i).loc)} LOC`] : null, p.x, p.y);
    canvas.style.cursor = i >= 0 ? 'pointer' : 'grab';
  });
});
canvas.addEventListener('pointerleave', () => { scene.setHover(-1); ui.showTip(null, 0, 0); });

let down: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', e => {
  if (!down || !city) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
  down = null;
  if (moved) return; // it was an orbit drag
  selected = scene.pick(e.clientX, e.clientY);
  scene.setSelected(selected);
  ui.showInfo(selected >= 0 ? infoFor(selected) : null);
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
  const saved = recall();
  if (saved) ui.setForm(saved.source, saved.ref, saved.commits, saved.churn ?? true);

  const src = new URLSearchParams(location.search).get('src');
  if (src) { // static mode: load a city.json from a URL
    try { await fetchCity(src); } catch (e) { ui.setMessage(`Could not load ${src}: ${(e as Error).message}`); }
    return;
  }
  let st: Status;
  try {
    st = await api<Status>('/api/status');
  } catch {
    // no API (static hosting): fall back to a city.json next to the page
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
