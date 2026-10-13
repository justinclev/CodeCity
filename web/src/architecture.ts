import type { Building, City, Role, ShapeKind } from './types';

/**
 * Architecture: how each building is built, derived from its code — never at random.
 * One spec per building, shared by the night/day renderer, hacker mode and walk mode.
 *
 * - shape (tiers): the file's dominant declaration groups stacked as setbacks on a podium
 *   (see Shape in types.ts); the archetype comes from the analyzer;
 * - material (facade): the language;
 * - rooftop: the roles the flow analysis found (entry point, served routes, database, …);
 * - condition (per commit, in the scene): scaffolding for recent churn, irregular windows
 *   for complexity, weathering for age.
 * Color stays free for the color modes.
 */

/** Facade styles (shader codes, see material.ts). */
export const FACADE = {
  plain: 0, concrete: 1, glass: 2, brick: 3, steel: 4, storefront: 5, library: 6, utility: 7, lattice: 8, crystal: 9, colonnade: 10,
} as const;
export type Facade = keyof typeof FACADE;

export type RoofKind = 'spire' | 'antenna' | 'tanks' | 'chimney' | 'vents' | 'uplink' | 'watertower';
export type Archetype = ShapeKind | 'mixed';

export interface TierSpec {
  /** Vertical extent as fractions of the building's height (0 = ground, 1 = roof). */
  y0: number; y1: number;
  /** Footprint scale (both axes, centred). */
  s: number;
  facade: Facade;
  /** What this tier is (a declaration group, a chapter, "podium", "lobby"). */
  name: string;
  /** Lines of code it stands for. */
  loc: number;
}

export interface BuildingSpec {
  kind: Archetype;
  facade: Facade;
  /** At least one; bottom first. */
  tiers: TierSpec[];
  roof: RoofKind[];
  roles: Role[];
  /** Imported by many files: a columned lobby on a full-width plinth. */
  plinth: boolean;
  /** Slabs get continuous ribbon windows. */
  ribbon: boolean;
}

/** Language → facade. */
const LANG_FACADE: Record<string, Facade> = {
  Go: 'concrete',
  TypeScript: 'glass', JavaScript: 'glass',
  Python: 'brick',
  Rust: 'steel', C: 'steel', 'C++': 'steel', Zig: 'steel',
  HTML: 'storefront', CSS: 'storefront', Vue: 'storefront', Svelte: 'storefront',
  Markdown: 'library', Text: 'library',
  JSON: 'utility', YAML: 'utility', TOML: 'utility', XML: 'utility', Config: 'utility', Protobuf: 'utility', Terraform: 'utility',
};

export const FACADE_LABEL: Record<Facade, string> = {
  plain: 'office windows', concrete: 'concrete grid (Go)', glass: 'glass curtain wall (TypeScript / JavaScript)',
  brick: 'brick with arched windows (Python)', steel: 'steel bracing (Rust, C, C++)', storefront: 'storefronts (HTML, CSS, Vue, Svelte)',
  library: 'library columns (docs)', utility: 'utility block (data, config)', lattice: 'lattice (tests)', crystal: 'glass box (types only)',
  colonnade: 'columned lobby (imported by many)',
};

export const ROOF_LABEL: Record<RoofKind, string> = {
  spire: 'spire and beacon: program entry point (main)',
  antenna: 'antenna dish: serves HTTP routes',
  tanks: 'tanks: talks to a database or storage',
  chimney: 'chimney: runs processes',
  vents: 'vents: reads or writes files',
  uplink: 'uplink mast: calls HTTP services',
  watertower: 'water tower: JSON / YAML data',
};

export const KIND_LABEL: Record<Archetype, string> = {
  tower: 'Tower on a podium: one type with its methods dominates the file',
  slab: 'Slab: many small functions, none stands out',
  types: 'Glass box: declarations only (types, interfaces)',
  data: 'Utility block: data or configuration',
  doc: 'Library: documentation, chapters as tiers',
  test: 'Lattice annex: tests',
  mixed: 'Setbacks: each large declaration is a tier',
};

const ROLE_ROOF: Record<Role, RoofKind> = { entry: 'spire', serve: 'antenna', db: 'tanks', exec: 'chimney', files: 'vents', call: 'uplink' };

const MIN_PODIUM = 0.12, MIN_TIER = 0.08, PLINTH = 0.07;

/**
 * Specs for every building. fanIn(i) = files importing building i at the newest commit
 * (the plinth goes to the most-imported few).
 */
export function buildSpecs(city: City, fanIn: (i: number) => number): BuildingSpec[] {
  const fans = city.buildings.map((_, i) => fanIn(i));
  const sorted = fans.filter(x => x > 0).sort((a, b) => b - a);
  const cut = Math.max(5, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.04))] ?? Infinity);
  return city.buildings.map((b, i) => specOf(b, fans[i] >= cut));
}

export function specOf(b: Building, plinth: boolean): BuildingSpec {
  const sh = b.shape;
  const kind: Archetype = sh?.k ?? 'mixed';
  let facade: Facade = LANG_FACADE[b.lang] ?? 'plain';
  if (kind === 'test') facade = 'lattice';
  else if (kind === 'types') facade = 'crystal';
  else if (kind === 'data') facade = 'utility';
  else if (kind === 'doc') facade = 'library';

  const locs = sh?.t?.length ? sh.t.map(x => Math.max(0, x)) : [1];
  const total = locs.reduce((a, x) => a + x, 0) || 1;
  let shares = locs.map(x => x / total);
  if (shares.length > 1) {
    shares[0] = Math.max(MIN_PODIUM, shares[0]);
    for (let k = 1; k < shares.length; k++) shares[k] = Math.max(MIN_TIER, shares[k]);
    const sum = shares.reduce((a, x) => a + x, 0);
    shares = shares.map(x => x / sum);
  }
  const tiers: TierSpec[] = [];
  let y = 0, s = 1;
  shares.forEach((share, k) => {
    if (k > 0) s = Math.max(0.3, Math.min(s - (k > 1 ? 0.08 : 0), 0.35 + 0.4 * Math.sqrt(locs[k] / total)));
    tiers.push({ y0: y, y1: y + share, s, facade, name: k === 0 ? (shares.length > 1 ? 'podium' : b.name) : sh?.n?.[k - 1] ?? `tier ${k}`, loc: locs[k] });
    y += share;
  });
  tiers[tiers.length - 1].y1 = 1;
  if (plinth) {
    // the lobby takes the bottom of the building at full width; everything above steps in
    for (const t of tiers) { t.y0 = PLINTH + t.y0 * (1 - PLINTH); t.y1 = PLINTH + t.y1 * (1 - PLINTH); t.s *= 0.86; }
    tiers.unshift({ y0: 0, y1: PLINTH, s: 1, facade: 'colonnade', name: 'lobby', loc: 0 });
  }

  const roles = sh?.r ?? [];
  const roof: RoofKind[] = [];
  for (const r of roles) {
    const k = ROLE_ROOF[r];
    if (k && !roof.includes(k)) roof.push(k);
  }
  if (kind === 'data' && (b.lang === 'JSON' || b.lang === 'YAML')) roof.push('watertower');
  return { kind, facade, tiers, roof: roof.slice(0, 3), roles, plinth, ribbon: kind === 'slab' };
}

/** Interior finish color per facade (walk-mode interiors wear the building's material). */
export const FINISH_COLOR: Record<Facade, string> = {
  plain: '#5ff0ff', concrete: '#a9bccf', glass: '#5ff0ff', brick: '#ff9a5c', steel: '#b8c4d6', storefront: '#ff6bd6',
  library: '#ffe08a', utility: '#8fa3b0', lattice: '#7dff9a', crystal: '#bff8ff', colonnade: '#ffe08a',
};

/** Accent per tier (podium first), shared by interiors and the inspector. */
export const TIER_COLORS = ['#5ff0ff', '#ffb547', '#ff6bd6', '#7dff9a', '#b18cff'];

/**
 * Which tier each storey (a piece of the file, named like "Server.Start", "Server (body)" or "helper")
 * belongs to: the tier named after its declaration group, else the podium (0). Indexes spec.tiers.
 */
export function tierOfFloors(spec: BuildingSpec, floorNames: string[]): number[] {
  return floorNames.map(n => {
    for (let k = spec.tiers.length - 1; k >= 0; k--) {
      const t = spec.tiers[k].name;
      if (t === 'podium' || t === 'lobby' || !t) continue;
      if (n === t || n.startsWith(t + '.') || n.startsWith(t + ' ') || n.startsWith(t + '::') || n.endsWith(' for ' + t) || n.includes(' for ' + t + '.')) return k;
    }
    return spec.plinth && spec.tiers.length > 1 ? 1 : 0; // the podium sits on the lobby when there is one
  });
}

/** A single box (the "Classic boxes" toggle). */
export function classicSpec(b: Building): BuildingSpec {
  return { kind: 'mixed', facade: 'plain', tiers: [{ y0: 0, y1: 1, s: 1, facade: 'plain', name: b.name, loc: 0 }], roof: [], roles: [], plinth: false, ribbon: false };
}

/** Shader code for a tier's facade (+0.5 marks ribbon windows). */
export function facadeCode(spec: BuildingSpec, t: TierSpec): number {
  return FACADE[t.facade] + (spec.ribbon && t.facade !== 'colonnade' ? 0.5 : 0);
}

/** Stable 0..1 number from a path (window rhythm phase; never shape). */
export function pathSeed(p: string): number {
  let h = 2166136261;
  for (let i = 0; i < p.length; i++) { h ^= p.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10007) / 10007;
}

export interface Condition {
  /** Changed a lot recently: scaffolding (and a crane for the busiest). */
  scaffold: boolean; crane: boolean;
  /** 0..1 complexity density relative to the city: irregular windows / glitching glyphs. */
  irregular: number;
  /** 0..1 time since the last change (2 years = 1): weathering / dimmer glow. */
  age: number;
}

/** Plain-language reasons for a building's look. */
export function explain(b: Building, spec: BuildingSpec, cond?: Condition): string[] {
  const out: string[] = [];
  const sh = b.shape;
  const upper = spec.tiers.filter(t => t.name !== 'podium' && t.name !== 'lobby' && t.loc > 0 && spec.tiers.length > 1);
  if (spec.kind === 'tower' && upper.length) out.push(`Tower: ${upper[0].name} carries ${pct(upper[0].loc, sh)} of the file`);
  else if (spec.kind === 'slab') out.push(`Slab: ${sh?.f ?? 0} small functions, none dominates`);
  else if (spec.kind === 'types') out.push(`Glass box: ${sh?.y ?? 0} type declaration${sh?.y === 1 ? '' : 's'}, no functions`);
  else if (spec.kind === 'data') out.push('Utility block: data / configuration');
  else if (spec.kind === 'doc') out.push(upper.length ? `Library: chapters ${upper.map(t => `“${t.name}”`).join(', ')}` : 'Library: documentation');
  else if (spec.kind === 'test') out.push('Lattice annex: a test file');
  if (spec.kind !== 'tower' && spec.kind !== 'doc' && upper.length) out.push(`Setbacks: ${upper.map(t => `${t.name} (${pct(t.loc, sh)})`).join(', ')}`);
  out.push(`Facade: ${FACADE_LABEL[spec.facade]}`);
  for (const r of spec.roof) out.push(`Roof: ${ROOF_LABEL[r]}`);
  if (spec.plinth) out.push('Lobby: one of the most-imported files');
  if (cond?.scaffold) out.push(cond.crane ? 'Crane and scaffolding: changing a lot right now' : 'Scaffolding: changed recently');
  if (cond && cond.irregular > 0.5) out.push('Irregular windows: dense, deeply nested code');
  if (cond && cond.age > 0.6) out.push('Weathered: untouched for a long time');
  return out;
}

function pct(loc: number, sh: Building['shape']) {
  const total = sh?.t.reduce((a, x) => a + x, 0) || 1;
  return `${Math.round((100 * loc) / total)}%`;
}

/** Legend rows: [group, items]. */
export function legend(): [string, string[]][] {
  return [
    ['Shape (what the file is made of)', (['tower', 'slab', 'types', 'data', 'doc', 'test', 'mixed'] as Archetype[]).map(k => KIND_LABEL[k])],
    ['Facade (language)', (['concrete', 'glass', 'brick', 'steel', 'storefront', 'library', 'utility', 'plain'] as Facade[]).map(f => FACADE_LABEL[f])],
    ['Roof (what the code does)', (Object.keys(ROOF_LABEL) as RoofKind[]).map(r => ROOF_LABEL[r]).concat(['columned lobby: imported by many files'])],
    ['Walkways', ['skybridge: joins a test to the code it tests (walk across it)']],
    ['Highways (several repos): road colour = what connects the cities', ['amber: API calls (HTTP, gRPC, GraphQL, WebSocket)', 'green: messages through a broker (Kafka, NATS, RabbitMQ, ...)', 'purple: the same database table', 'cars drive publisher → subscriber, caller ⇄ server']],
    ['Condition (history at this commit)', ['scaffolding / crane: recent heavy churn', 'irregular windows: complex code', 'weathering: long untouched']],
  ];
}
