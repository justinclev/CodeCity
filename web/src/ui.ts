import type { Building, City, ColorMode, Metric, ScaleMode } from './types';
import { languageColor } from './colors';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export const fmt = (n: number) => n.toLocaleString('en-US');

export function setMessage(text: string) { $('msg').textContent = text; }

export function showCityInfo(c: City) {
  $('repo').textContent = c.repo.name;
  document.title = `Code City – ${c.repo.name}`;
  const skipped = Object.values(c.stats.skipped).reduce((a, b) => a + b, 0);
  $('stats').textContent =
    `${fmt(c.stats.files)} files · ${fmt(c.stats.dirs)} dirs · ${fmt(c.stats.loc)} LOC\n` +
    `${c.repo.ref} @ ${c.repo.commit.slice(0, 8)}` + (skipped ? ` · ${fmt(skipped)} skipped` : '');
  $('stats').style.whiteSpace = 'pre-line';

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

export function showTip(b: Building | null, x: number, y: number) {
  const tip = $('tip');
  if (!b) { tip.hidden = true; return; }
  tip.replaceChildren();
  const name = document.createElement('b');
  name.textContent = b.path;
  tip.append(name, document.createElement('br'), `${b.lang} · ${fmt(b.loc)} LOC`);
  tip.hidden = false;
  tip.style.left = Math.min(x + 14, innerWidth - 340) + 'px';
  tip.style.top = Math.min(y + 14, innerHeight - 60) + 'px';
}

export function showInfo(b: Building | null, c: City) {
  const el = $('info');
  if (!b) { el.hidden = true; return; }
  el.replaceChildren();
  const title = document.createElement('b');
  title.textContent = b.name;
  el.append(title);
  const rows: [string, string][] = [
    ['path', b.path], ['language', b.lang], ['LOC', fmt(b.loc)], ['lines', fmt(b.lines)],
    ['bytes', fmt(b.bytes)], ['district', c.districts[b.district].path || '(root)'],
  ];
  for (const [k, v] of rows) {
    const line = document.createElement('div');
    const key = document.createElement('span');
    key.className = 'k';
    key.textContent = k + ': ';
    line.append(key, v);
    el.append(line);
  }
  el.hidden = false;
}

export interface Controls {
  onMetric(v: Metric): void;
  onScale(v: ScaleMode): void;
  onMult(v: number): void;
  onColor(v: ColorMode): void;
  onSearch(q: string): void;
}

export function bindControls(h: Controls) {
  $<HTMLSelectElement>('metric').onchange = e => h.onMetric((e.target as HTMLSelectElement).value as Metric);
  $<HTMLSelectElement>('scale').onchange = e => h.onScale((e.target as HTMLSelectElement).value as ScaleMode);
  $<HTMLInputElement>('mult').oninput = e => h.onMult(parseFloat((e.target as HTMLInputElement).value));
  $<HTMLSelectElement>('color').onchange = e => h.onColor((e.target as HTMLSelectElement).value as ColorMode);
  $<HTMLInputElement>('search').oninput = e => h.onSearch((e.target as HTMLInputElement).value);
}
