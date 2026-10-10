import type { CityScene } from './scene';
import { INACTIVE_DAYS, RISK } from './scene';
import type { City } from './types';

export interface FileRow { index: number; path: string; a: number; b: number; note?: string }
export interface PairRow { a: number; b: number; shared: number; degree: number }
export interface AreaRow { district: number; name: string; files: number; loc: number; complexity: number; commits: number; owners: number; hotspot: number }
export interface AuthorRow { index: number; name: string; commits: number; files: number; last: number; active: boolean }

export interface Insights {
  hotspots: FileRow[]; // a = commits (window), b = complexity
  coupling: PairRow[];
  orphaned: FileRow[]; // a = complexity, note = owner
  single: FileRow[]; // a = complexity, note = author
  complex: FileRow[]; // a = complexity, b = loc
  areas: AreaRow[];
  authors: AuthorRow[];
  fanIn: { index: number; path: string; n: number }[];
  fanOut: { index: number; path: string; n: number }[];
  cycles: { a: string; b: string; da: number; ab: number; ba: number }[];
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function compute(city: City, scene: CityScene, limit = 15): Insights {
  const n = city.buildings.length;
  const present: number[] = [];
  for (let i = 0; i < n; i++) if (scene.exists(i)) present.push(i);
  const code = present.filter(i => scene.isCode(i));
  const cx = (i: number) => scene.valuesAt(i).complexity;
  const ownerName = (i: number) => {
    const o = city.buildings[i].own;
    return o ? city.authors?.[o[0]]?.name ?? '' : '';
  };
  const byDesc = (key: (i: number) => number) => (x: number, y: number) => key(y) - key(x) || city.buildings[x].path.localeCompare(city.buildings[y].path);

  const hotspots = scene.topHotspots(limit).map(h => ({ index: h.index, path: city.buildings[h.index].path, a: h.commits, b: h.loc, note: ownerName(h.index) }));

  const seen = new Set<string>();
  const coupling: PairRow[] = [];
  for (const i of code) {
    for (const [j, shared, degree] of city.buildings[i].cpl ?? []) {
      if (!scene.exists(j) || !scene.isCode(j)) continue;
      const k = i < j ? `${i}:${j}` : `${j}:${i}`;
      if (seen.has(k)) continue;
      seen.add(k);
      coupling.push({ a: Math.min(i, j), b: Math.max(i, j), shared, degree });
    }
  }
  coupling.sort((x, y) => y.degree * y.shared - x.degree * x.shared);

  const risky = (bucket: number) => code.filter(i => scene.risk(i) === bucket && cx(i) > 0).sort(byDesc(cx)).slice(0, limit)
    .map(i => ({ index: i, path: city.buildings[i].path, a: cx(i), b: 0, note: ownerName(i) }));

  const complex = code.filter(i => cx(i) > 0).sort(byDesc(cx)).slice(0, limit)
    .map(i => ({ index: i, path: city.buildings[i].path, a: cx(i), b: scene.valuesAt(i).loc }));

  // areas = the top-level districts
  const areas: AreaRow[] = [];
  city.districts.forEach((d, di) => {
    if (d.parent !== 0) return;
    const members = scene.districtMembers(di);
    if (!members.length) return;
    const owners = new Set<number>();
    let loc = 0, complexity = 0, commits = 0, hotspot = 0;
    for (const i of members) {
      const v = scene.valuesAt(i);
      loc += v.loc;
      if (scene.isCode(i)) complexity += v.complexity;
      commits += scene.churnAt(i).commits;
      hotspot += scene.hotspotScore(i);
      const o = city.buildings[i].own;
      if (o) owners.add(o[0]);
    }
    areas.push({ district: di, name: d.name, files: members.length, loc, complexity, commits, owners: owners.size, hotspot });
  });
  areas.sort((x, y) => y.hotspot - x.hotspot || y.loc - x.loc);

  const newest = scene.timeOf(city.commits.length - 1);
  const owned = new Map<number, number>();
  for (const i of present) { const o = city.buildings[i].own; if (o) owned.set(o[0], (owned.get(o[0]) ?? 0) + 1); }
  const authors = (city.authors ?? []).map((a, index) => ({
    index, name: a.name, commits: a.commits, files: owned.get(index) ?? 0, last: a.last,
    active: newest - a.last <= INACTIVE_DAYS * 86400,
  })).filter(a => a.files > 0).sort((x, y) => y.files - x.files || y.commits - x.commits);

  // imports between files
  const fanIn = present.map(i => ({ index: i, path: city.buildings[i].path, n: scene.dependents(i) }))
    .filter(r => r.n > 0).sort((a, b) => b.n - a.n).slice(0, limit);
  const fanOut = present.map(i => ({ index: i, path: city.buildings[i].path,
    n: (city.buildings[i].imp?.filter(j => scene.exists(j)).length ?? 0) + (city.buildings[i].impd?.length ?? 0) }))
    .filter(r => r.n > 0).sort((a, b) => b.n - a.n).slice(0, limit);
  // directory cycles between sibling-level directories (depth ≤ 2)
  const ds = city.districts;
  const groupOf = (d: number) => { let x = d; while (x > 0 && ds[x].depth > 2) x = ds[x].parent; return x; };
  const pair = new Map<string, number>();
  for (const i of present) {
    const b = city.buildings[i];
    const ga = groupOf(b.district);
    const add = (gb: number) => { if (ga !== gb && ga > 0 && gb > 0) pair.set(`${ga}:${gb}`, (pair.get(`${ga}:${gb}`) ?? 0) + 1); };
    for (const j of b.imp ?? []) if (scene.exists(j)) add(groupOf(city.buildings[j].district));
    for (const d of b.impd ?? []) add(groupOf(d));
  }
  const cycles: Insights['cycles'] = [];
  for (const [k, ab] of pair) {
    const [ga, gb] = k.split(':').map(Number);
    const ba = pair.get(`${gb}:${ga}`);
    if (ba && ga < gb && !ds[ga].path.startsWith(ds[gb].path + '/') && !ds[gb].path.startsWith(ds[ga].path + '/')) {
      cycles.push({ a: ds[ga].path, b: ds[gb].path, da: ga, ab, ba });
    }
  }
  cycles.sort((x, y) => y.ab + y.ba - x.ab - x.ba);

  return {
    fanIn, fanOut, cycles: cycles.slice(0, limit),
    hotspots, coupling: coupling.slice(0, limit), orphaned: risky(4), single: risky(3), complex, areas, authors,
  };
}

/** Markdown snapshot of what the viewer shows at the current commit. */
export function markdown(city: City, scene: CityScene, ins: Insights, windowLabel: string): string {
  const k = city.commits[scene.commit];
  const t = scene.totals();
  const P = (i: number) => '`' + city.buildings[i].path + '`';
  const out: string[] = [];
  out.push(`# Code City: ${city.repo.name}`, '');
  out.push(`\`${city.repo.ref}\` @ \`${k.hash.slice(0, 8)}\` · ${k.date.slice(0, 10)} · ${fmt(t.files)} files · ${fmt(t.loc)} LOC`, '');
  if (!city.churn) out.push('_Churn not analyzed: hotspots, coupling and ownership are unavailable._', '');
  if (city.repos?.length) {
    const name = (k: number) => city.repos![k].name;
    out.push('## Repositories', '', city.repos.map(r => `- \`${r.name}\` (${r.remote || r.source})`).join('\n'), '');
    const links = city.links ?? [];
    out.push('## Connections', '');
    if (!links.length) out.push('_No connections: no shared dependencies, imports or contributors._');
    for (const l of links) {
      const head = l.kind === 'dependency' ? `**${name(l.from)} → ${name(l.to)}** (dependency)` : `**${name(l.from)} ↔ ${name(l.to)}** (shared people)`;
      out.push(`- ${head}: ${(l.evidence ?? []).join('; ')}${l.people?.length ? ` (${l.people.join(', ')})` : ''}`);
    }
    out.push('');
  }
  if (ins.hotspots.length) {
    out.push(`## Hotspots (changes ${windowLabel} × complexity)`, '', '| # | File | Commits | Complexity | Owner |', '|---|---|---:|---:|---|');
    ins.hotspots.forEach((h, i) => out.push(`| ${i + 1} | ${P(h.index)} | ${h.a} | ${fmt(h.b)} | ${h.note ?? ''} |`));
    out.push('');
  }
  if (ins.coupling.length) {
    out.push('## Change coupling', '', '| File A | File B | Shared commits | Degree |', '|---|---|---:|---:|');
    ins.coupling.forEach(c => out.push(`| ${P(c.a)} | ${P(c.b)} | ${c.shared} | ${c.degree}% |`));
    out.push('');
  }
  if (ins.orphaned.length) {
    out.push(`## Knowledge risk: owner inactive > ${INACTIVE_DAYS} days`, '', '| File | Owner | Complexity |', '|---|---|---:|');
    ins.orphaned.forEach(f => out.push(`| ${P(f.index)} | ${f.note} | ${fmt(f.a)} |`));
    out.push('');
  }
  if (ins.single.length) {
    out.push(`## Knowledge risk: ${RISK[3]}`, '', '| File | Author | Complexity |', '|---|---|---:|');
    ins.single.forEach(f => out.push(`| ${P(f.index)} | ${f.note} | ${fmt(f.a)} |`));
    out.push('');
  }
  if (ins.areas.length) {
    out.push('## Areas', '', '| Directory | Files | LOC | Complexity | Commits | Owners |', '|---|---:|---:|---:|---:|---:|');
    ins.areas.forEach(a => out.push(`| \`${a.name}\` | ${fmt(a.files)} | ${fmt(a.loc)} | ${fmt(a.complexity)} | ${fmt(a.commits)} | ${a.owners} |`));
    out.push('');
  }
  return out.join('\n');
}
