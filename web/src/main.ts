import './style.css';
import { CityScene } from './scene';
import { bindControls, setMessage, showCityInfo, showInfo, showTip } from './ui';
import type { City } from './types';

const scene = new CityScene(document.getElementById('c') as HTMLCanvasElement);
let city: City | null = null;

function isCity(x: unknown): x is City {
  const c = x as City;
  return !!c && c.version === 1 && Array.isArray(c.districts) && Array.isArray(c.buildings) && !!c.bounds;
}

function show(c: City) {
  if (c.buildings.length === 0) { setMessage('This repository has no countable source files.'); return; }
  city = c;
  setMessage('');
  scene.load(c);
  showCityInfo(c);
  showInfo(null, c);
}

async function fetchCity(url: string) {
  setMessage('Loading city…');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const data: unknown = await res.json();
  if (!isCity(data)) throw new Error('not a city.json (version 1)');
  show(data);
}

async function loadFile(f: File) {
  try {
    const data: unknown = JSON.parse(await f.text());
    if (!isCity(data)) throw new Error('not a city.json (version 1)');
    show(data);
  } catch (e) { setMessage(`Could not read ${f.name}: ${(e as Error).message}`); }
}

bindControls({
  onMetric: v => { scene.metric = v; scene.rebuild(); },
  onScale: v => { scene.scale = v; scene.rebuild(); },
  onMult: v => { scene.mult = v; scene.rebuild(); },
  onColor: v => { scene.colorMode = v; scene.rebuild(); },
  onSearch: q => { scene.search(q); },
});

// hover (throttled to one raycast per frame) and click-to-select
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
    showTip(i >= 0 ? city.buildings[i] : null, p.x, p.y);
    canvas.style.cursor = i >= 0 ? 'pointer' : 'grab';
  });
});
canvas.addEventListener('pointerleave', () => { scene.setHover(-1); showTip(null, 0, 0); });

let down: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', e => {
  if (!down || !city) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
  down = null;
  if (moved) return; // it was an orbit drag
  const i = scene.pick(e.clientX, e.clientY);
  scene.setSelected(i);
  showInfo(i >= 0 ? city.buildings[i] : null, city);
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

const src = new URLSearchParams(location.search).get('src') ?? 'city.json';
fetchCity(src).catch(() =>
  setMessage('No city loaded.\n\nRun `codecity serve <repo>`, or drop a city.json onto this page.'));
