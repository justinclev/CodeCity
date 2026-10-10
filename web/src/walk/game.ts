/**
 * The learning game layered on walk mode: what you have seen and studied, XP and ranks,
 * quests generated from the repository's structure, achievements, and quiz questions
 * built from real definitions and imports. Progress is kept per repository (by path, so it
 * survives re-analysis) in localStorage, best effort.
 */

export interface GameFile { path: string; name: string; dir: string; top: string; loc: number; code: boolean; test: boolean; lang: string }

/** Everything the game needs to know about the city, by building index. */
export interface GameWorld {
  key: string; // repository identity for storage
  files: (GameFile | null)[]; // null = not present at the newest commit
  importsOf(i: number): number[];
  importersOf(i: number): number[];
  entries: number[];
  readme: number[];
  core: number[]; // most-imported first
  hubs: number[];
  hotspots: number[];
  tops: string[]; // top-level directories that contain files
}

interface State {
  xp: number;
  seen: string[]; studied: string[]; entered: string[]; exploded: string[]; origins: string[]; shards: string[];
  traces: number; quizRight: number; quizWrong: number; flewHigh: boolean; mapTravel: number; tourDone: boolean;
  quests: string[]; achievements: string[];
}

const empty = (): State => ({ xp: 0, seen: [], studied: [], entered: [], exploded: [], origins: [], shards: [], traces: 0,
  quizRight: 0, quizWrong: 0, flewHigh: false, mapTravel: 0, tourDone: false, quests: [], achievements: [] });

export const RANKS: [number, string][] = [[0, 'Intern'], [120, 'Junior Dev'], [350, 'Contributor'], [750, 'Senior Dev'], [1400, 'Maintainer'], [2400, 'Architect']];

export interface Quest { id: string; title: string; desc: string; xp: number; target: number; progress: () => number; /** buildings that advance it, for map pins */ pins?: () => number[] }
export interface Achievement { id: string; title: string; desc: string; xp: number; done: () => boolean }

export type Reward = { kind: 'xp'; amount: number; why: string } | { kind: 'quest'; quest: Quest } | { kind: 'achievement'; a: Achievement } | { kind: 'rank'; rank: string };

export interface QuizQuestion { prompt: string; code?: string; options: { label: string; building: number; line?: number }[]; answer: number; explain: string }

export class Game {
  private s: State;
  private sets: Record<'seen' | 'studied' | 'entered' | 'exploded' | 'origins' | 'shards', Set<string>>;
  readonly quests: Quest[];
  readonly achievements: Achievement[];
  private listeners: ((r: Reward) => void)[] = [];
  private totalLoc: number;
  private saveTimer = 0;

  constructor(readonly w: GameWorld) {
    this.s = { ...empty(), ...(load(w.key) ?? {}) };
    this.sets = {
      seen: new Set(this.s.seen), studied: new Set(this.s.studied), entered: new Set(this.s.entered),
      exploded: new Set(this.s.exploded), origins: new Set(this.s.origins), shards: new Set(this.s.shards),
    };
    this.totalLoc = w.files.reduce((a, f) => a + (f?.loc ?? 0), 0) || 1;
    this.quests = this.makeQuests();
    this.achievements = this.makeAchievements();
  }

  onReward(fn: (r: Reward) => void) { this.listeners.push(fn); }

  // ------------------------------------------------------------------ queries

  get xp() { return this.s.xp; }
  get rank(): { name: string; next: number | null; floor: number } {
    let k = 0;
    while (k + 1 < RANKS.length && this.s.xp >= RANKS[k + 1][0]) k++;
    return { name: RANKS[k][1], floor: RANKS[k][0], next: k + 1 < RANKS.length ? RANKS[k + 1][0] : null };
  }
  private path(i: number) { return this.w.files[i]?.path ?? ''; }
  isSeen(i: number) { return this.sets.seen.has(this.path(i)); }
  isStudied(i: number) { return this.sets.studied.has(this.path(i)); }
  hasShard(i: number) { return this.sets.shards.has(this.path(i)); }
  get quizRight() { return this.s.quizRight; }
  /** Fraction of the code (by LOC) studied, and files studied / present. */
  explored() {
    let loc = 0, files = 0, total = 0;
    this.w.files.forEach(f => {
      if (!f) return;
      total++;
      if (this.sets.studied.has(f.path)) { files++; loc += f.loc; }
    });
    return { loc: loc / this.totalLoc, files, total };
  }
  questDone(q: Quest) { return this.s.quests.includes(q.id); }
  /** The first unfinished quest (shown in the tracker). */
  activeQuest(): Quest | null { return this.quests.find(q => !this.questDone(q)) ?? null; }
  achieved(a: Achievement) { return this.s.achievements.includes(a.id); }

  // ------------------------------------------------------------------ events

  /** Walked near a building: reveals it on the map (no XP). */
  see(i: number) {
    const p = this.path(i);
    if (!p || this.sets.seen.has(p)) return;
    this.sets.seen.add(p);
    this.s.seen.push(p);
    this.dirty(false);
  }
  /** Looked at a building's details (card, explode, interior): it counts as studied. */
  study(i: number, how: 'entered' | 'exploded' | 'card', xp: number) {
    const p = this.path(i);
    if (!p) return;
    this.see(i);
    let gained = 0;
    if (!this.sets.studied.has(p)) { this.sets.studied.add(p); this.s.studied.push(p); gained += xp; }
    if (how !== 'card' && !this.sets[how].has(p)) { this.sets[how].add(p); this.s[how].push(p); gained += how === 'entered' ? 5 : 3; }
    if (gained) this.give(gained, how === 'entered' ? `entered ${this.w.files[i]!.name}` : how === 'exploded' ? `took apart ${this.w.files[i]!.name}` : `studied ${this.w.files[i]!.name}`);
    this.dirty(true);
  }
  readOrigin(i: number) {
    const p = this.path(i);
    if (!p || this.sets.origins.has(p)) return;
    this.sets.origins.add(p); this.s.origins.push(p);
    this.give(6, `origin story of ${this.w.files[i]!.name}`);
    this.dirty(true);
  }
  shard(i: number) {
    const p = this.path(i);
    if (!p || this.sets.shards.has(p)) return false;
    this.sets.shards.add(p); this.s.shards.push(p);
    this.give(25, 'data shard');
    this.dirty(true);
    return true;
  }
  trace() { this.s.traces++; this.give(8, 'traced a definition'); this.dirty(true); }
  quiz(ok: boolean) {
    if (ok) { this.s.quizRight++; this.give(20, 'correct answer'); } else this.s.quizWrong++;
    this.dirty(true);
  }
  flewHigh() { if (this.s.flewHigh) return; this.s.flewHigh = true; this.dirty(true); }
  mapTravel() { this.s.mapTravel++; this.dirty(true); }
  tourDone() { if (this.s.tourDone) return; this.s.tourDone = true; this.give(50, 'finished the tour'); this.dirty(true); }
  reset() { this.s = empty(); for (const k of Object.keys(this.sets) as (keyof Game['sets'])[]) this.sets[k].clear(); save(this.w.key, this.s); }

  private give(amount: number, why: string) {
    const before = this.rank.name;
    this.s.xp += amount;
    this.emit({ kind: 'xp', amount, why });
    const after = this.rank.name;
    if (after !== before) this.emit({ kind: 'rank', rank: after });
  }
  private emit(r: Reward) { for (const f of this.listeners) f(r); }

  /** Persist soon; check quests/achievements when progress may have moved. */
  private dirty(check: boolean) {
    if (check) this.check();
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => save(this.w.key, this.s), 400);
  }

  private check() {
    for (const q of this.quests) {
      if (this.questDone(q) || q.progress() < q.target) continue;
      this.s.quests.push(q.id);
      this.emit({ kind: 'quest', quest: q });
      this.give(q.xp, `quest: ${q.title}`);
    }
    for (const a of this.achievements) {
      if (this.achieved(a) || !a.done()) continue;
      this.s.achievements.push(a.id);
      this.emit({ kind: 'achievement', a });
      this.give(a.xp, `achievement: ${a.title}`);
    }
  }

  // ------------------------------------------------------------------ content

  private makeQuests(): Quest[] {
    const w = this.w, q: Quest[] = [];
    const st = this.sets;
    const count = (ids: number[], set: Set<string>) => ids.filter(i => set.has(this.path(i))).length;
    if (w.readme.length) q.push({ id: 'readme', title: 'Read the manual', desc: `Enter ${w.files[w.readme[0]]!.path} — the authors’ own introduction.`, xp: 30, target: 1,
      progress: () => count(w.readme, st.studied), pins: () => w.readme });
    if (w.entries.length) q.push({ id: 'entry', title: 'Where it all begins', desc: `Find an entry point (${w.entries.slice(0, 2).map(i => w.files[i]!.name).join(' or ')}) and step inside.`, xp: 40, target: 1,
      progress: () => count(w.entries, st.entered), pins: () => w.entries });
    const core = w.core.slice(0, 3);
    if (core.length) q.push({ id: 'core', title: 'Meet the core', desc: `Study the ${core.length} most-imported modules: ${core.map(i => w.files[i]!.name).join(', ')}.`, xp: 60, target: core.length,
      progress: () => count(core, st.studied), pins: () => core });
    if (w.hubs.length) q.push({ id: 'wiring', title: 'Wiring diagram', desc: `Take ${w.files[w.hubs[0]]!.name} apart (X) to see the pieces that tie the project together.`, xp: 40, target: 1,
      progress: () => count(w.hubs.slice(0, 1), st.exploded), pins: () => w.hubs.slice(0, 1) });
    q.push({ id: 'trace', title: 'Follow the trace', desc: 'Inside a building, click a name on the code wall and teleport to its definition — 3 times.', xp: 50, target: 3, progress: () => this.s.traces });
    q.push({ id: 'origins', title: 'Archaeologist', desc: 'Read the origin story (the commit that created it) of 3 files — open a card with I.', xp: 40, target: 3, progress: () => st.origins.size });
    if (w.hotspots.length) {
      const hs = w.hotspots.slice(0, 2);
      q.push({ id: 'hot', title: 'Hot zone', desc: `Visit the hotspots — the code that changes most: ${hs.map(i => w.files[i]!.name).join(', ')}.`, xp: 50, target: hs.length,
        progress: () => count(hs, st.studied), pins: () => hs });
    }
    if (w.tops.length > 1) q.push({ id: 'districts', title: 'Grand tour', desc: `Study at least one file in every top-level directory (${w.tops.length}).`, xp: 70, target: w.tops.length,
      progress: () => w.tops.filter(t => w.files.some(f => f && f.top === t && st.studied.has(f.path))).length });
    q.push({ id: 'quiz', title: 'Pop quiz', desc: 'Answer 5 questions right at the ? terminals.', xp: 60, target: 5, progress: () => this.s.quizRight });
    q.push({ id: 'map', title: 'Cartographer', desc: 'Study a quarter of the code (by lines).', xp: 80, target: 25, progress: () => Math.floor(this.explored().loc * 100) });
    return q;
  }

  private makeAchievements(): Achievement[] {
    const st = this.sets;
    return [
      { id: 'first', title: 'First steps', desc: 'Enter a building.', xp: 10, done: () => st.entered.size >= 1 },
      { id: 'fly', title: 'High flyer', desc: 'Fly above the skyline (double-tap Space).', xp: 20, done: () => this.s.flewHigh },
      { id: 'demolition', title: 'Demolition crew', desc: 'Take apart 10 buildings.', xp: 40, done: () => st.exploded.size >= 10 },
      { id: 'tracer', title: 'Tracer', desc: 'Teleport to 10 definitions.', xp: 50, done: () => this.s.traces >= 10 },
      { id: 'historian', title: 'Historian', desc: 'Read 10 origin stories.', xp: 50, done: () => st.origins.size >= 10 },
      { id: 'shards', title: 'Shard collector', desc: 'Collect every data shard.', xp: 80, done: () => this.shardTotal > 0 && st.shards.size >= this.shardTotal },
      { id: 'quizwhiz', title: 'Quiz whiz', desc: 'Answer 15 questions right.', xp: 80, done: () => this.s.quizRight >= 15 },
      { id: 'tour', title: 'Tourist', desc: 'Finish the guided tour (T).', xp: 30, done: () => this.s.tourDone },
      { id: 'half', title: 'Know the place', desc: 'Study half of the code.', xp: 120, done: () => this.explored().loc >= 0.5 },
      { id: 'all', title: 'Architect’s eye', desc: 'Study 90% of the code.', xp: 250, done: () => this.explored().loc >= 0.9 },
    ];
  }

  /** Shards exist at these buildings (set by walk mode). */
  shardTotal = 0;

  /** A question about directory `top` (or anywhere), from definitions and imports; null if none can be made. */
  question(symbols: [string, string, string, number, number][] | null, byPath: Map<string, number>, top: string | null, rnd = Math.random): QuizQuestion | null {
    const w = this.w;
    const inTop = (i: number) => !!w.files[i] && (top === null || w.files[i]!.top === top);
    const pool = w.files.map((f, i) => (f && f.code && !f.test ? i : -1)).filter(i => i >= 0);
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
    const shuffle = <T,>(a: T[]) => { for (let k = a.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [a[k], a[j]] = [a[j], a[k]]; } return a; };
    const decoys = (right: number, avoid: Set<number>, n: number, prefer: (i: number) => boolean) => {
      const near = shuffle(pool.filter(i => i !== right && !avoid.has(i) && prefer(i)));
      const far = shuffle(pool.filter(i => i !== right && !avoid.has(i) && !prefer(i)));
      return [...near, ...far].slice(0, n);
    };
    const build = (prompt: string, right: number, wrong: number[], explain: string, line?: number, code?: string): QuizQuestion | null => {
      if (wrong.length < 2) return null;
      const opts = shuffle([right, ...wrong]).map(i => ({ label: w.files[i]!.path, building: i, line: i === right ? line : undefined }));
      return { prompt, code, options: opts, answer: opts.findIndex(o => o.building === right), explain };
    };
    const kinds = shuffle(['def', 'importer', 'import']);
    for (let attempt = 0; attempt < 12; attempt++) {
      const kind = kinds[attempt % kinds.length];
      if (kind === 'def' && symbols?.length) {
        const cands = symbols.filter(s => {
          const i = byPath.get(s[2]);
          return i !== undefined && inTop(i) && /^(func|function|method|class|struct|interface|type|trait|enum|impl)/.test(s[1]) && s[0].length >= 4 && !s[0].startsWith('_');
        });
        if (!cands.length) continue;
        const s = pick(cands);
        const right = byPath.get(s[2])!;
        // the name must not also be defined in a decoy
        const elsewhere = new Set(symbols.filter(x => x[0] === s[0]).map(x => byPath.get(x[2])).filter((x): x is number => x !== undefined));
        const q = build(`Where is ${s[1]} ${s[0]} defined?`, right, decoys(right, elsewhere, 3, i => w.files[i]!.lang === w.files[right]!.lang), `${s[0]} is defined in ${s[2]} at line ${s[3]}.`, s[3], s[0]);
        if (q) return q;
      } else if (kind === 'importer') {
        const cands = pool.filter(i => inTop(i) && w.importersOf(i).length > 0);
        if (!cands.length) continue;
        const target = pick(cands);
        const by = w.importersOf(target);
        const right = pick(by);
        const q = build(`Which of these files uses (imports) ${w.files[target]!.path}?`, right, decoys(right, new Set([target, ...by]), 3, i => w.files[i]!.top === w.files[right]!.top),
          `${w.files[right]!.path} imports it${by.length > 1 ? `, and so do ${by.length - 1} other file${by.length > 2 ? 's' : ''}` : ''}.`);
        if (q) return q;
      } else if (kind === 'import') {
        const cands = pool.filter(i => inTop(i) && w.importsOf(i).filter(j => w.files[j]).length > 0);
        if (!cands.length) continue;
        const from = pick(cands);
        const imps = w.importsOf(from).filter(j => w.files[j]);
        const right = pick(imps);
        const q = build(`Which file does ${w.files[from]!.path} import?`, right, decoys(right, new Set([from, ...imps]), 3, i => w.files[i]!.dir === w.files[right]!.dir),
          `${w.files[from]!.name} imports ${imps.length} file${imps.length === 1 ? '' : 's'} of this project, including ${w.files[right]!.path}.`);
        if (q) return q;
      }
    }
    return null;
  }
}

function load(key: string): Partial<State> | null {
  try { return JSON.parse(localStorage.getItem('codecity.game.' + key) ?? 'null'); } catch { return null; }
}
function save(key: string, s: State) {
  try { localStorage.setItem('codecity.game.' + key, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
