import * as THREE from 'three';

const FIXED: Record<string, string> = {
  Go: '#00add8', Python: '#3776ab', JavaScript: '#f1e05a', TypeScript: '#3178c6', Rust: '#dea584',
  Java: '#b07219', Kotlin: '#a97bff', C: '#8a8a8a', 'C++': '#f34b7d', 'C#': '#178600', Ruby: '#cc342d',
  PHP: '#4f5d95', Swift: '#f05138', Shell: '#89e051', HTML: '#e34c26', CSS: '#7e57c2', Vue: '#41b883',
  Svelte: '#ff3e00', JSON: '#9aa5b1', YAML: '#cb171e', Markdown: '#083fa1', SQL: '#e38c00', Docker: '#2496ed',
  Makefile: '#427819', Other: '#6b7488',
};

export function languageColor(lang: string): THREE.Color {
  if (FIXED[lang]) return new THREE.Color(FIXED[lang]);
  let h = 0;
  for (let i = 0; i < lang.length; i++) h = (h * 31 + lang.charCodeAt(i)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.55, 0.55);
}

/** t in [0,1] → cool-to-hot gradient. */
export function heat(t: number): THREE.Color {
  t = Math.min(1, Math.max(0, t));
  return new THREE.Color().setHSL(0.62 - 0.62 * t, 0.8, 0.35 + 0.25 * t);
}

export function depthColor(depth: number, maxDepth: number): THREE.Color {
  const t = maxDepth > 0 ? depth / maxDepth : 0;
  return new THREE.Color().setHSL(0.58 + 0.12 * t, 0.45, 0.75 - 0.35 * t);
}

export function districtColor(depth: number): THREE.Color {
  const l = Math.max(0.07, 0.17 - depth * 0.018);
  return new THREE.Color().setHSL(0.62, 0.35, l);
}

const AUTHOR_PALETTE = ['#ff6b6b', '#4dabf7', '#ffd43b', '#69db7c', '#da77f2', '#ff922b', '#38d9a9', '#f783ac', '#a9e34b', '#74c0fc', '#e599f7', '#ffa94d'];

/** Distinct colors for the top authors; everyone else shares a neutral grey. */
export function authorColor(index: number): THREE.Color {
  return new THREE.Color(index < AUTHOR_PALETTE.length ? AUTHOR_PALETTE[index] : '#7d8597');
}

export const AUTHOR_COLORS = AUTHOR_PALETTE.length;
