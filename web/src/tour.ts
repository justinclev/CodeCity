import type { City } from './types';
import type { CityScene } from './scene';

/** Why a file is on the tour. */
export type StopKind = 'readme' | 'docs' | 'manifest' | 'entry' | 'hub' | 'core' | 'test' | 'hotspot' | 'risk';

export interface TourStop {
  building: number;
  kind: StopKind;
  /** Short heading, e.g. "Entry point". */
  title: string;
  /** Plain-language reasons, each backed by data from the city. */
  why: string[];
}

export const KIND_LABEL: Record<StopKind, string> = {
  readme: 'Start here', docs: 'Architecture notes', manifest: 'Manifest', entry: 'Entry point', hub: 'Wiring',
  core: 'Core module', test: 'Usage by example', hotspot: 'Hotspot', risk: 'Knowledge risk',
};

const ENTRY = [
  /^(?:[^/]+\/)?cmd\/[^/]+\/main\.go$/, /^main\.go$/,
  /^(?:[^/]+\/)?src\/(?:main|lib)\.rs$/, /^src\/bin\/[^/]+\.rs$/,
  /^(?:[^/]+\/)?(?:src\/)?(?:index|main|app|server|cli)\.(?:ts|tsx|js|jsx|mjs|cjs)$/,
  /(?:^|\/)__main__\.py$/, /^(?:[^/]+\/)?(?:manage|app|main|wsgi|asgi|cli)\.py$/,
  /^(?:src\/)?main\.(?:c|cc|cpp)$/, /(?:^|\/)Program\.cs$/, /(?:^|\/)(?:Main|Application)\.(?:java|kt)$/,
];
const MANIFEST = /^(?:go\.mod|package\.json|Cargo\.toml|pyproject\.toml|setup\.py|requirements\.txt|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.csproj|Gemfile|composer\.json)$/;
const DOCS: [RegExp, string][] = [
  [/(?:^|\/)architecture\.md$/i, 'The project describes its own architecture here.'],
  [/(?:^|\/)design\.md$/i, 'Design notes written by the authors.'],
  [/^(?:claude|agents)\.md$/i, 'Notes for (AI) contributors: layout, commands and conventions.'],
  [/^contributing\.md$/i, 'How the project expects changes to be made.'],
];
const TEST = /(?:_test\.go|\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|\/)test_[^/]+\.py|_test\.py|_spec\.rb|Tests?\.(?:cs|java|kt))$|(?:^|\/)(?:tests?|__tests__|spec)\//;

export const isTest = (path: string) => TEST.test(path);

/**
 * A guided route through a codebase, built from what the city already knows:
 * docs first, then the manifest, entry points, the files that wire things together,
 * the most-imported modules (and their tests), the hotspots, and knowledge risks.
 */
export function buildTour(city: City, scene: CityScene, max = 14): TourStop[] {
  const stops: TourStop[] = [];
  const used = new Set<number>();
  const n = city.buildings.length;
  const repoPrefix = (i: number) => (city.repos ? (city.repos[city.buildings[i].repo ?? 0]?.name ?? '') + '/' : '');
  const rel = (i: number) => city.buildings[i].path.slice(repoPrefix(i).length);
  const dir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : './');
  const live: number[] = [];
  for (let i = 0; i < n; i++) if (scene.exists(i)) live.push(i);
  const fanIn = new Map<number, number[]>();
  for (const i of live) fanIn.set(i, scene.importersOf(i));
  const fanOut = (i: number) => (city.buildings[i].imp?.filter(j => scene.exists(j)).length ?? 0) + (city.buildings[i].impd?.length ?? 0);
  const loc = (i: number) => scene.valuesAt(i).loc;
  const add = (building: number, kind: StopKind, why: string[]) => {
    if (used.has(building) || stops.length >= max) return false;
    used.add(building);
    stops.push({ building, kind, title: KIND_LABEL[kind], why });
    return true;
  };
  const names = (ids: number[], k = 3) => ids.slice(0, k).map(j => city.buildings[j].name).join(', ') + (ids.length > k ? ` +${ids.length - k} more` : '');

  // README at each repository's root
  for (const i of live) {
    if (/^readme(?:\.\w+)?$/i.test(rel(i))) add(i, 'readme', ['The authors’ own introduction: what this is, how to build and run it.']);
  }
  // one architecture-style document
  for (const [re, why] of DOCS) {
    const i = live.find(j => re.test(rel(j)));
    if (i !== undefined && add(i, 'docs', [why])) break;
  }
  // the shallowest manifest per repository
  const manifests = new Map<number, number>();
  for (const i of live) {
    if (!MANIFEST.test(city.buildings[i].name)) continue;
    const r = city.buildings[i].repo ?? 0, cur = manifests.get(r);
    if (cur === undefined || rel(i).split('/').length < rel(cur).split('/').length) manifests.set(r, i);
  }
  for (const i of manifests.values()) add(i, 'manifest', ['Declares the module name, dependencies and build/run scripts — the project’s outer shape.']);

  // entry points, the ones that pull in the most first
  const entries = live.filter(i => !isTest(rel(i)) && ENTRY.some(re => re.test(rel(i)))).sort((a, b) => fanOut(b) - fanOut(a) || rel(a).localeCompare(rel(b)));
  for (const i of entries.slice(0, 3)) {
    const out = fanOut(i);
    add(i, 'entry', ['Execution starts here.', out ? `It imports ${out} module${out === 1 ? '' : 's'} of this project: follow them outward.` : 'Read top to bottom to see what runs first.']);
  }

  // files that wire many modules together
  const hubs = live.filter(i => scene.isCode(i) && !isTest(rel(i)) && fanOut(i) >= 3).sort((a, b) => fanOut(b) - fanOut(a) || loc(b) - loc(a));
  let h = 0;
  for (const i of hubs) {
    if (h >= 2) break;
    const imp = (city.buildings[i].imp ?? []).filter(j => scene.exists(j));
    if (add(i, 'hub', [`Imports ${fanOut(i)} parts of the project${imp.length ? ` (${names(imp)})` : ''} — read it to see how they connect.`])) h++;
  }

  // the most-imported modules, each followed by its tests when there are some
  const core = live.filter(i => scene.isCode(i) && !isTest(rel(i)) && (fanIn.get(i)?.length ?? 0) >= 2)
    .sort((a, b) => fanIn.get(b)!.length - fanIn.get(a)!.length || loc(b) - loc(a));
  let c = 0;
  for (const i of core) {
    if (c >= 3) break;
    const by = fanIn.get(i)!;
    const dirs = new Set(by.map(k => dir(rel(k))));
    if (!add(i, 'core', [`Imported by ${by.length} files across ${dirs.size} director${dirs.size === 1 ? 'y' : 'ies'} (${names(by)}).`,
      'Learn its names and types first — the rest of the code speaks them.'])) continue;
    c++;
    const stem = city.buildings[i].name.replace(/\.[^.]+$/, '');
    const d = dir(rel(i));
    const t = live.find(j => isTest(rel(j)) && dir(rel(j)).startsWith(d.replace(/^\.\//, '')) &&
      new RegExp(`(?:^|[/_.])(?:test_)?${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[._](?:test|spec))?\\.`).test(city.buildings[j].name));
    if (t !== undefined) add(t, 'test', [`Tests for ${city.buildings[i].name}: the quickest way to see how it is meant to be used.`]);
  }

  // where change happens
  if (city.churn) {
    for (const hs of scene.topHotspots(6)) {
      if (stops.filter(s => s.kind === 'hotspot').length >= 2) break;
      if (isTest(rel(hs.index))) continue;
      add(hs.index, 'hotspot', [`Changed in ${hs.commits} commits with indentation complexity ${hs.loc} — the busiest intricate code.`, 'Expect to work here; read it slowly.']);
    }
    // knowledge risk: biggest file whose main author has gone quiet
    const risky = live.filter(i => scene.isCode(i) && scene.risk(i) === 4).sort((a, b) => loc(b) - loc(a))[0];
    if (risky !== undefined) {
      const own = city.buildings[risky].own!, a = city.authors?.[own[0]];
      add(risky, 'risk', [`Mostly written by ${a?.name ?? 'one author'}, who has not committed for months.`, 'Its history (commit messages) may be the best documentation left.']);
    }
  }
  return stops;
}
