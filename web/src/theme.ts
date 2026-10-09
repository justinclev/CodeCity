import * as THREE from 'three';

export type ThemeName = 'night' | 'day' | 'hacker';

export interface Theme {
  name: ThemeName;
  skyTop: string;
  skyBottom: string; // also the fog color, so the horizon blends into the sky
  ground: string;
  grid: string;
  gridOpacity: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  sun: string;
  sunIntensity: number;
  sunDir: [number, number, number];
  district: (depth: number) => THREE.Color;
  outline: string;
  outlineOpacity: number;
  buildingTint: number; // multiplier on building base colors
  dim: string; // what search/filter-dimmed buildings fade toward
  night: number; // 0 = day glass, 1 = lit windows
  hacker: number; // 1 = glowing-text towers on a circuit-board floor
  heightBoost: number; // multiplier on building heights
  bloom: { strength: number; radius: number; threshold: number };
  exposure: number;
  labelBg: string;
  labelFg: string;
}

export const THEMES: Record<ThemeName, Theme> = {
  night: {
    name: 'night',
    skyTop: '#03050c',
    skyBottom: '#121a33',
    ground: '#0a0e1a',
    grid: '#2a4a8a',
    gridOpacity: 0.22,
    hemiSky: '#6f86c9',
    hemiGround: '#0b0f1c',
    hemiIntensity: 0.5,
    sun: '#9fb6ff',
    sunIntensity: 0.75,
    sunDir: [-0.6, 1.0, 0.45],
    district: d => new THREE.Color().setHSL(0.63, 0.32, Math.max(0.05, 0.11 - d * 0.012)),
    outline: '#5d7fd6',
    outlineOpacity: 0.35,
    buildingTint: 0.78,
    dim: '#141a2c',
    night: 1,
    hacker: 0,
    heightBoost: 1,
    bloom: { strength: 0.75, radius: 0.5, threshold: 0.78 },
    exposure: 1.1,
    labelBg: 'rgba(6,10,22,0.78)',
    labelFg: '#e6edff',
  },
  day: {
    name: 'day',
    skyTop: '#6fa3e8',
    skyBottom: '#dfeaf7',
    ground: '#c9d2dc',
    grid: '#8b9bb0',
    gridOpacity: 0.18,
    hemiSky: '#ffffff',
    hemiGround: '#8e9aa8',
    hemiIntensity: 1.25,
    sun: '#fff1dc',
    sunIntensity: 2.4,
    sunDir: [-0.55, 1.0, 0.35],
    district: d => new THREE.Color().setHSL(0.6, 0.08, Math.min(0.88, 0.7 + d * 0.035)),
    outline: '#7c8ca3',
    outlineOpacity: 0.45,
    buildingTint: 1,
    dim: '#d9dee6',
    night: 0,
    hacker: 0,
    heightBoost: 1,
    bloom: { strength: 0, radius: 0, threshold: 1 },
    exposure: 1.0,
    labelBg: 'rgba(255,255,255,0.82)',
    labelFg: '#1b2333',
  },
  hacker: {
    name: 'hacker',
    skyTop: '#000000',
    skyBottom: '#050a1c',
    ground: '#000000',
    grid: '#1a2a6a',
    gridOpacity: 0,
    hemiSky: '#3a5cff',
    hemiGround: '#000000',
    hemiIntensity: 0.25,
    sun: '#7aa8ff',
    sunIntensity: 0.25,
    sunDir: [-0.6, 1.0, 0.45],
    district: () => new THREE.Color('#03040a'),
    outline: '#d23cff',
    outlineOpacity: 0.85,
    buildingTint: 0.9,
    dim: '#020308',
    night: 1,
    hacker: 1,
    heightBoost: 2.4,
    bloom: { strength: 1.05, radius: 0.55, threshold: 0.3 },
    exposure: 1.0,
    labelBg: 'rgba(2,4,12,0.85)',
    labelFg: '#7ff3ff',
  },
};

/** Vertical sky gradient used as the scene background. */
export function skyTexture(t: Theme): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, t.skyTop);
  g.addColorStop(0.75, t.skyBottom);
  g.addColorStop(1, t.skyBottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------- hacker-mode textures

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
}

/**
 * A tileable sheet of glowing "data" text (white on black; the shader tints it):
 * lines built from the repository's own paths and identifiers, hex dumps,
 * status words and little framed blocks.
 */
export function glyphAtlas(words: string[]): THREE.CanvasTexture {
  const S = 1024, rows = 64, lh = S / rows;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  const rand = rng(words.length * 7919 + 17);
  const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
  const status = ['STATUS', 'REPORT', 'ACCESS', 'GRANTED', 'COMMIT', 'MERGE', 'BRANCH', 'HEAD', 'REF', 'DIFF', 'TRACE', 'SYNC', 'INDEX', 'BLOB', 'TREE', 'NODE', 'ROOT', 'OK', 'READY', 'WRITE', 'READ', 'EXEC'];
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('').toUpperCase();
  const pool = words.length ? words : ['main', 'index', 'server', 'client', 'router', 'config'];
  ctx.textBaseline = 'middle';
  for (let r = 0; r < rows; r++) {
    const y = r * lh + lh / 2;
    let x = 4 + Math.floor(rand() * 3) * 24;
    if (rand() < 0.12) continue; // empty row
    while (x < S - 20) {
      const k = rand();
      let t: string;
      if (k < 0.32) t = pick(pool);
      else if (k < 0.55) t = hex(4 + Math.floor(rand() * 8));
      else if (k < 0.72) t = pick(status);
      else if (k < 0.85) t = String(Math.floor(rand() * 99999)).padStart(5, '0');
      else t = pick(['>>', '::', '->', '[ ]', '{ }', '0x' + hex(6), '#' + hex(3), '|||', '--']);
      const bright = 0.35 + rand() * 0.65;
      ctx.font = `${rand() < 0.15 ? 700 : 500} ${Math.round(lh * 0.62)}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.fillStyle = `rgba(255,255,255,${bright.toFixed(2)})`;
      ctx.fillText(t, x, y);
      x += ctx.measureText(t).width + 10 + rand() * 40;
      if (rand() < 0.08) break;
    }
    if (rand() < 0.06) { // framed panel
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 2;
      const w = 80 + rand() * 220, h = lh * (2 + Math.floor(rand() * 3));
      ctx.strokeRect(10 + rand() * (S - w - 20), y - lh / 2, w, h);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** Tileable circuit-board traces: magenta/violet lines with pads, a few cyan. */
export function circuitTexture(): THREE.CanvasTexture {
  const S = 1024, G = 32;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  const rand = rng(1337);
  const colors = ['#d23cff', '#a52cff', '#ff3cd0', '#7a3cff', '#d23cff', '#3ce0ff'];
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const seg = (pts: [number, number][], color: string, width: number) => {
    // draw wrapped so the tile repeats seamlessly
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x + ox, y + oy) : ctx.moveTo(x + ox, y + oy)));
      ctx.stroke();
      const [ex, ey] = pts[pts.length - 1];
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(ex + ox, ey + oy, width * 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.arc(ex + ox, ey + oy, width * 0.8, 0, Math.PI * 2); ctx.fill();
    }
  };
  const dirs: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let t = 0; t < 26; t++) {
    let x = Math.floor(rand() * (S / G)) * G, y = Math.floor(rand() * (S / G)) * G;
    let d = dirs[Math.floor(rand() * 4)];
    const pts: [number, number][] = [[x, y]];
    const n = 3 + Math.floor(rand() * 6);
    for (let k = 0; k < n; k++) {
      const len = (1 + Math.floor(rand() * 6)) * G;
      x += d[0] * len; y += d[1] * len;
      pts.push([x, y]);
      // turn 90° or 45°
      const turn = rand();
      if (turn < 0.4) d = [d[1], -d[0]]; else if (turn < 0.8) d = [-d[1], d[0]];
      else if (d[0] && d[1]) d = rand() < 0.5 ? [d[0], 0] : [0, d[1]]; else d = dirs[4 + Math.floor(rand() * 4)];
    }
    const color = colors[Math.floor(rand() * colors.length)];
    seg(pts, color, rand() < 0.2 ? 4 : 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** A building-face texture of real source code (white on black; additive). */
export function codeTexture(lines: string[], aspect: number): THREE.CanvasTexture {
  const W = 512;
  const H = Math.max(256, Math.min(4096, Math.round(W * aspect)));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const lh = 11;
  ctx.font = '9.5px "JetBrains Mono", ui-monospace, monospace';
  ctx.textBaseline = 'top';
  const rows = Math.floor((H - 8) / lh);
  for (let r = 0; r < rows && lines.length; r++) {
    const line = lines[r % lines.length].replace(/\t/g, '    ');
    const lead = line.length - line.trimStart().length;
    ctx.fillStyle = `rgba(255,255,255,${0.55 + 0.45 * ((r * 7919) % 13) / 13})`;
    ctx.fillText(line.trim().slice(0, 90), 6 + lead * 5.6, 4 + r * lh);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 8;
  return tex;
}
