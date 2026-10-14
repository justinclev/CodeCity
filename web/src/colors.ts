import * as THREE from 'three';

const FIXED: Record<string, string> = {
  Go: '#00add8', Python: '#3776ab', JavaScript: '#f1e05a', TypeScript: '#3178c6', Rust: '#dea584',
  Java: '#b07219', Kotlin: '#a97bff', C: '#8a8a8a', 'C++': '#f34b7d', 'C#': '#178600', Ruby: '#cc342d',
  PHP: '#4f5d95', Swift: '#f05138', Shell: '#89e051', HTML: '#e34c26', CSS: '#7e57c2', Vue: '#41b883',
  Svelte: '#ff3e00', JSON: '#9aa5b1', YAML: '#cb171e', Markdown: '#083fa1', SQL: '#e38c00', Docker: '#2496ed',
  Makefile: '#427819', Other: '#6b7488',
};

// Pre-built cache for every language seen so far — avoids repeated allocations
// during buildBaseColors() which maps over thousands of buildings.
const _langCache = new Map<string, THREE.Color>();

export function languageColor(lang: string): THREE.Color {
  let c = _langCache.get(lang);
  if (c) return c;
  if (FIXED[lang]) {
    c = new THREE.Color(FIXED[lang]);
  } else {
    let h = 0;
    for (let i = 0; i < lang.length; i++) h = (h * 31 + lang.charCodeAt(i)) >>> 0;
    c = new THREE.Color().setHSL((h % 360) / 360, 0.55, 0.55);
  }
  _langCache.set(lang, c);
  return c;
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


const AUTHOR_PALETTE = ['#ff6b6b', '#4dabf7', '#ffd43b', '#69db7c', '#da77f2', '#ff922b', '#38d9a9', '#f783ac', '#a9e34b', '#74c0fc', '#e599f7', '#ffa94d'];

// Pre-built author color objects — authorColor is called once per building per commit change.
const _authorCache: THREE.Color[] = AUTHOR_PALETTE.map(c => new THREE.Color(c));
const _authorFallback = new THREE.Color('#7d8597');

/** Distinct colors for the top authors; everyone else shares a neutral grey. */
export function authorColor(index: number): THREE.Color {
  return index < _authorCache.length ? _authorCache[index] : _authorFallback;
}

export const AUTHOR_COLORS = AUTHOR_PALETTE.length;
