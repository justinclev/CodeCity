import type { City, ColorMode, Metric, ScaleMode } from './types';
import { languageColor } from './colors';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export const fmt = (n: number) => n.toLocaleString('en-US');

export function setMessage(text: string) { $('msg').textContent = text; }

export function setJobStatus(text: string, isError = false) {
  const el = $('jobstatus');
  el.textContent = text;
  el.className = isError ? 'err' : '';
}

export function setBusy(busy: boolean) {
  $<HTMLButtonElement>('go').disabled = busy;
  $('cancel').hidden = !busy;
}

export function showCityInfo(c: City) {
  $('repo').textContent = c.repo.name;
  document.title = `Code City – ${c.repo.name}`;
  const skipped = Object.values(c.stats.skipped).reduce((a, b) => a + b, 0);
  $('stats').title = skipped ? `${fmt(skipped)} files skipped at the newest commit (vendored, binary, generated, …)` : '';

  const langs = Object.entries(c.stats.languages).sort((a, b) => b[1].loc - a[1].loc).slice(0, 12);
  const legend = $('legend');
  legend.replaceChildren();
  for (const [name, s] of langs) {
    const row = document.createElement('div');
    row.className = 'lg';
    const sw = document.createElement('i');
    sw.style.background = '#' + languageColor(name).getHexString();
    const label = document.createElement('span');
    label.textContent = name;
    const n = document.createElement('span');
    n.textContent = fmt(s.loc);
    row.append(sw, label, n);
    legend.append(row);
  }
}

export function showStats(files: number, loc: number, c: City) {
  $('stats').textContent = `${fmt(files)} files · ${fmt(loc)} LOC\n${c.repo.ref}`;
  $('stats').style.whiteSpace = 'pre-line';
}

export function showTip(text: [string, string] | null, x: number, y: number) {
  const tip = $('tip');
  if (!text) { tip.hidden = true; return; }
  tip.replaceChildren();
  const name = document.createElement('b');
  name.textContent = text[0];
  tip.append(name, document.createElement('br'), text[1]);
  tip.hidden = false;
  tip.style.left = Math.min(x + 14, innerWidth - 340) + 'px';
  tip.style.top = Math.min(y + 14, innerHeight - 60) + 'px';
}

export interface InfoData {
  name: string; path: string; lang: string; district: string;
  loc: number; lines: number; bytes: number;
  series: number[]; commit: number;
  churn?: { commits: number; lines: number; allCommits: number; allLines: number; windowLabel: string };
}

export function showInfo(d: InfoData | null) {
  const el = $('info');
  if (!d) { el.hidden = true; return; }
  el.replaceChildren();
  const title = document.createElement('b');
  title.textContent = d.name;
  el.append(title);
  const rows: [string, string][] = [
    ['path', d.path], ['language', d.lang], ['LOC', fmt(d.loc)], ['lines', fmt(d.lines)],
    ['bytes', fmt(d.bytes)], ['district', d.district || '(root)'],
  ];
  if (d.churn) {
    if (d.churn.windowLabel !== 'all so far') rows.push([`changes (${d.churn.windowLabel})`, `${fmt(d.churn.commits)} commits · ${fmt(d.churn.lines)} lines`]);
    rows.push(['changes (all so far)', `${fmt(d.churn.allCommits)} commits · ${fmt(d.churn.allLines)} lines`]);
  }
  for (const [k, v] of rows) {
    const line = document.createElement('div');
    const key = document.createElement('span');
    key.className = 'k';
    key.textContent = k + ': ';
    line.append(key, v);
    el.append(line);
  }
  if (d.series.length > 1) {
    const cv = document.createElement('canvas');
    el.append(cv);
    spark(cv, d.series, d.commit);
  }
  el.hidden = false;
}

function spark(cv: HTMLCanvasElement, s: number[], at: number) {
  const dpr = devicePixelRatio || 1;
  const w = 256, h = 44;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const max = Math.max(1, ...s);
  const x = (i: number) => (i / (s.length - 1)) * (w - 4) + 2;
  const y = (v: number) => h - 3 - (v / max) * (h - 8);
  ctx.strokeStyle = '#6ea8ff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  s.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(x(at), y(s[at]), 3, 0, Math.PI * 2);
  ctx.fill();
}

export interface Controls {
  onMetric(v: Metric): void;
  onScale(v: ScaleMode): void;
  onMult(v: number): void;
  onColor(v: ColorMode): void;
  onSearch(q: string): void;
  onSubmit(source: string, ref: string, commits: number, churn: boolean): void;
  onChurnWindow(v: number): void;
  onHotspot(index: number): void;
  onCancel(): void;
  onScrub(i: number): void;
  onPlay(): void;
  onChanges(v: boolean): void;
  onSpeed(v: number): void;
}

export function bindControls(h: Controls) {
  $<HTMLSelectElement>('metric').onchange = e => h.onMetric((e.target as HTMLSelectElement).value as Metric);
  $<HTMLSelectElement>('scale').onchange = e => h.onScale((e.target as HTMLSelectElement).value as ScaleMode);
  $<HTMLInputElement>('mult').oninput = e => h.onMult(parseFloat((e.target as HTMLInputElement).value));
  $<HTMLSelectElement>('color').onchange = e => h.onColor((e.target as HTMLSelectElement).value as ColorMode);
  $<HTMLInputElement>('search').oninput = e => h.onSearch((e.target as HTMLInputElement).value);
  $('repoform').onsubmit = e => {
    e.preventDefault();
    h.onSubmit(
      $<HTMLInputElement>('source').value.trim(),
      $<HTMLInputElement>('ref').value.trim(),
      Math.max(1, parseInt($<HTMLInputElement>('commits').value, 10) || 1),
      $<HTMLInputElement>('churn').checked,
    );
  };
  $<HTMLSelectElement>('cwin').onchange = e => h.onChurnWindow(parseInt((e.target as HTMLSelectElement).value, 10));
  hotspotHandler = h.onHotspot;
  $('cancel').onclick = () => h.onCancel();
  $<HTMLInputElement>('scrub').oninput = e => h.onScrub(parseInt((e.target as HTMLInputElement).value, 10));
  $('play').onclick = () => h.onPlay();
  $<HTMLInputElement>('changes').onchange = e => h.onChanges((e.target as HTMLInputElement).checked);
  $<HTMLSelectElement>('speed').onchange = e => h.onSpeed(parseFloat((e.target as HTMLSelectElement).value));
}

let hotspotHandler: (i: number) => void = () => undefined;

/** Enable churn-based color modes only when the city carries churn data. */
export function setChurnAvailable(on: boolean) {
  for (const v of ['churn', 'hotspot']) {
    $<HTMLSelectElement>('color').querySelectorAll<HTMLOptionElement>(`option[value="${v}"]`).forEach(o => { o.disabled = !on; });
  }
  $<HTMLSelectElement>('cwin').disabled = !on;
  if (!on && ['churn', 'hotspot'].includes($<HTMLSelectElement>('color').value)) $<HTMLSelectElement>('color').value = 'language';
}

export interface HotspotRow { index: number; path: string; commits: number; loc: number; score: number }

export function showHotspots(rows: HotspotRow[] | null) {
  const el = $('hotspots');
  if (!rows) { el.hidden = true; return; }
  el.replaceChildren();
  const h = document.createElement('h4');
  h.textContent = 'Top hotspots (changes × LOC)';
  h.title = 'Code files only: docs, data and config are excluded from hotspots';
  el.append(h);
  for (const r of rows) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hs';
    b.title = `${r.path}\n${r.commits} commits × ${r.loc} LOC`;
    const name = document.createElement('span');
    name.textContent = '\u200E' + r.path; // keep the file name visible when the path is truncated on the left
    const n = document.createElement('span');
    n.textContent = `${r.commits}×${fmt(r.loc)}`;
    b.append(name, n);
    b.onclick = () => hotspotHandler(r.index);
    el.append(b);
  }
  el.hidden = rows.length === 0;
}

export function setForm(source: string, ref: string, commits: number, churn = true) {
  $<HTMLInputElement>('churn').checked = churn;
  $<HTMLInputElement>('source').value = source;
  $<HTMLInputElement>('ref').value = ref;
  $<HTMLInputElement>('commits').value = String(commits);
}

export function getForm() {
  return {
    source: $<HTMLInputElement>('source').value.trim(),
    ref: $<HTMLInputElement>('ref').value.trim(),
    commits: parseInt($<HTMLInputElement>('commits').value, 10) || 100,
    churn: $<HTMLInputElement>('churn').checked,
  };
}

/** Configure the timeline for a city (hidden when there is only one commit). */
export function setupTimeline(c: City) {
  const tl = $('timeline');
  tl.hidden = c.commits.length < 2;
  const sc = $<HTMLInputElement>('scrub');
  sc.max = String(c.commits.length - 1);
  sc.value = String(c.commits.length - 1);
  setPlaying(false);
}

export function setPlaying(p: boolean) { $('play').textContent = p ? '⏸' : '▶'; }

export function showCommit(c: City, i: number) {
  const k = c.commits[i];
  $<HTMLInputElement>('scrub').value = String(i);
  const when = $('when');
  when.replaceChildren();
  const date = new Date(k.date);
  const b = document.createElement('b');
  b.textContent = isNaN(date.getTime()) ? k.date : date.toISOString().slice(0, 10);
  when.append(b, ` · ${i + 1}/${c.commits.length} · ${k.hash.slice(0, 8)} · ${k.author} · `, k.subject);
}
