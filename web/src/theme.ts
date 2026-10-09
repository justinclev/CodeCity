import * as THREE from 'three';

export type ThemeName = 'night' | 'day';

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
    bloom: { strength: 0, radius: 0, threshold: 1 },
    exposure: 1.0,
    labelBg: 'rgba(255,255,255,0.82)',
    labelFg: '#1b2333',
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
