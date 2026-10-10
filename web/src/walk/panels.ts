/** DOM pieces of the walk-mode HUD: status bar, banners, info card, tour card, quiz, search, quest log. */
import type { Achievement, Game, Quest, QuizQuestion } from './game';

export interface CardItem { text: string; sub?: string; go?: () => void }
export interface CardSection { title: string; lines?: string[]; items?: CardItem[]; tone?: 'why' | 'plain' }
export interface CardData { title: string; subtitle: string; tag?: string; sections: CardSection[] }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** Top-left: rank, XP bar, explored %, current quest. */
export class StatusBar {
  readonly root = el('div', 'wstatus');
  private rank = el('div', 'wrank');
  private bar = el('div', 'wxpbar');
  private fill = el('div', 'wxpfill');
  private xp = el('div', 'wxp');
  private quest = el('div', 'wquest');
  constructor() {
    this.bar.append(this.fill);
    this.root.append(this.rank, this.bar, this.xp, this.quest);
  }
  update(g: Game) {
    const r = g.rank, e = g.explored();
    this.rank.textContent = r.name.toUpperCase();
    const span = r.next === null ? 1 : (g.xp - r.floor) / (r.next - r.floor);
    this.fill.style.width = `${Math.round(Math.min(1, span) * 100)}%`;
    this.xp.textContent = `${g.xp} XP${r.next !== null ? ` · ${r.next - g.xp} to next rank` : ''} · explored ${Math.round(e.loc * 100)}% of the code (${e.files}/${e.total} files)`;
    const q = g.activeQuest();
    this.quest.replaceChildren();
    if (q) {
      const t = el('div', 'wqt', `◆ ${q.title}`);
      const d = el('div', 'wqd', q.desc);
      const p = el('div', 'wqp', `${Math.min(q.progress(), q.target)}/${q.target}  ·  J quest log`);
      this.quest.append(t, d, p);
    } else this.quest.append(el('div', 'wqt', '◆ All quests complete — J for the log'));
  }
}

/** Big centred banners (quest complete, achievement, rank up) and a stream of small XP notes. */
export class Rewards {
  readonly root = el('div', 'wrewards');
  private banner = el('div', 'wbanner');
  private feed = el('div', 'wfeed');
  private queue: { kicker: string; title: string; sub: string; tone: string }[] = [];
  private showing = false;
  constructor() { this.root.append(this.banner, this.feed); }
  xp(amount: number, why: string) {
    const n = el('div', 'wfeedrow', `+${amount} XP  ${why}`);
    this.feed.prepend(n);
    while (this.feed.childElementCount > 5) this.feed.lastElementChild!.remove();
    window.setTimeout(() => n.classList.add('out'), 2600);
    window.setTimeout(() => n.remove(), 3200);
  }
  quest(q: Quest) { this.push({ kicker: 'QUEST COMPLETE', title: q.title, sub: `+${q.xp} XP`, tone: 'quest' }); }
  achievement(a: Achievement) { this.push({ kicker: 'ACHIEVEMENT UNLOCKED', title: a.title, sub: `${a.desc}  +${a.xp} XP`, tone: 'ach' }); }
  rank(name: string) { this.push({ kicker: 'RANK UP', title: name, sub: 'keep exploring', tone: 'rank' }); }
  private push(b: { kicker: string; title: string; sub: string; tone: string }) { this.queue.push(b); if (!this.showing) this.next(); }
  private next() {
    const b = this.queue.shift();
    if (!b) { this.showing = false; return; }
    this.showing = true;
    this.banner.replaceChildren(el('div', 'wbk', b.kicker), el('div', 'wbt', b.title), el('div', 'wbs', b.sub));
    this.banner.className = `wbanner on ${b.tone}`;
    window.setTimeout(() => { this.banner.className = 'wbanner'; window.setTimeout(() => this.next(), 350); }, 2600);
  }
}

/** Right-side details card for a building. */
export class InfoCard {
  readonly root = el('div', 'wcard');
  get open() { return this.root.classList.contains('on'); }
  show(d: CardData, onClose: () => void) {
    this.root.replaceChildren();
    const head = el('div', 'wch');
    if (d.tag) head.append(el('div', 'wctag', d.tag));
    head.append(el('div', 'wct', d.title), el('div', 'wcs', d.subtitle));
    const x = el('button', 'wcx', '×');
    x.title = 'Close (I)';
    x.onclick = onClose;
    head.append(x);
    this.root.append(head);
    const body = el('div', 'wcb');
    this.root.append(body);
    for (const s of d.sections) this.addSection(s, body);
    this.root.classList.add('on');
  }
  addSection(s: CardSection, body = this.root.querySelector<HTMLElement>('.wcb')) {
    if (!body) return;
    const sec = el('div', `wsec ${s.tone ?? ''}`);
    sec.append(el('div', 'wsh', s.title));
    for (const l of s.lines ?? []) sec.append(el('div', 'wsl', l));
    for (const it of s.items ?? []) {
      const b = el(it.go ? 'button' : 'div', 'wsi');
      b.append(el('span', 'wsit', it.text));
      if (it.sub) b.append(el('span', 'wsis', it.sub));
      if (it.go) (b as HTMLButtonElement).onclick = it.go;
      sec.append(b);
    }
    body.append(sec);
  }
  hide() { this.root.classList.remove('on'); }
}

/** Bottom-left guided-tour card. */
export class TourCard {
  readonly root = el('div', 'wtour');
  show(k: number, n: number, title: string, path: string, why: string[], hint: string) {
    this.root.replaceChildren(
      el('div', 'wtk', `TOUR ${k + 1}/${n} · ${title.toUpperCase()}`),
      el('div', 'wtp', path),
      ...why.map(w => el('div', 'wtw', w)),
      el('div', 'wth', hint),
    );
    this.root.classList.add('on');
  }
  hide() { this.root.classList.remove('on'); }
}

/** Centre dialog: a multiple-choice question. */
export class QuizBox {
  readonly root = el('div', 'wquiz');
  private q: QuizQuestion | null = null;
  private answered = -1;
  private handlers: { answer: (ok: boolean) => void; go: (i: number) => void; next: () => void; close: () => void } | null = null;
  get open() { return this.root.classList.contains('on'); }
  get waiting() { return this.open && this.answered < 0; }
  show(title: string, q: QuizQuestion, h: QuizBox['handlers']) {
    this.q = q; this.answered = -1; this.handlers = h;
    this.render(title);
    this.root.classList.add('on');
  }
  private render(title: string) {
    const q = this.q!;
    this.root.replaceChildren(el('div', 'wzk', title), el('div', 'wzq', q.prompt));
    q.options.forEach((o, k) => {
      const b = el('button', 'wzo');
      b.append(el('span', 'mk', String(k + 1)), el('span', 'ml', o.label));
      if (this.answered >= 0) {
        if (k === q.answer) b.classList.add('right');
        else if (k === this.answered) b.classList.add('wrong');
        b.onclick = () => this.handlers!.go(k);
        b.title = 'Teleport there';
      } else b.onclick = () => this.choose(k, title);
      this.root.append(b);
    });
    if (this.answered >= 0) {
      const ok = this.answered === q.answer;
      this.root.append(el('div', `wzr ${ok ? 'ok' : 'no'}`, ok ? 'Correct!' : 'Not quite.'), el('div', 'wze', q.explain),
        el('div', 'mhint', `click an answer to teleport there · N next question · Esc close`));
    } else this.root.append(el('div', 'mhint', 'press 1–4 or click · Esc close'));
  }
  choose(k: number, title = this.root.querySelector('.wzk')?.textContent ?? '') {
    if (!this.q || this.answered >= 0 || k < 0 || k >= this.q.options.length) return;
    this.answered = k;
    this.handlers?.answer(k === this.q.answer);
    this.render(title);
  }
  next() { this.handlers?.next(); }
  goTo(k: number) { if (this.answered >= 0) this.handlers?.go(k); }
  hide() { this.root.classList.remove('on'); this.q = null; }
}

export interface SearchHit { label: string; sub: string; go: () => void }

/** "/" search: files and definitions. */
export class SearchBox {
  readonly root = el('div', 'wsearch');
  private input = el('input');
  private list = el('div', 'wsr');
  private hits: SearchHit[] = [];
  private sel = 0;
  constructor(private find: (q: string) => SearchHit[], private onClose: () => void) {
    this.input.placeholder = 'search files and definitions…  (Enter to teleport, Esc to close)';
    this.input.spellcheck = false;
    this.root.append(this.input, this.list);
    this.input.addEventListener('input', () => this.run());
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); this.onClose(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.sel = Math.min(this.hits.length - 1, this.sel + 1); this.draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.sel = Math.max(0, this.sel - 1); this.draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); const h = this.hits[this.sel]; if (h) { this.onClose(); h.go(); } }
      e.stopPropagation();
    });
  }
  get open() { return this.root.classList.contains('on'); }
  show() { this.root.classList.add('on'); this.input.value = ''; this.run(); window.setTimeout(() => this.input.focus(), 0); }
  hide() { this.root.classList.remove('on'); this.input.blur(); }
  private run() { this.hits = this.find(this.input.value.trim()); this.sel = 0; this.draw(); }
  private draw() {
    this.list.replaceChildren(...this.hits.map((h, k) => {
      const b = el('button', k === this.sel ? 'sel' : '');
      b.append(el('span', 'ml', h.label), el('span', 'ms', h.sub));
      b.onclick = () => { this.onClose(); h.go(); };
      return b;
    }));
  }
}

/** J: quests and achievements. */
export class QuestLog {
  readonly root = el('div', 'wlog');
  get open() { return this.root.classList.contains('on'); }
  show(g: Game, onReset: () => void) {
    const r = g.rank, e = g.explored();
    const quests = el('div', 'wlq');
    for (const q of g.quests) {
      const done = g.questDone(q), p = Math.min(q.progress(), q.target);
      const row = el('div', `wlr ${done ? 'done' : ''}`);
      const bar = el('div', 'wlbar'); const f = el('div', 'wlfill'); f.style.width = `${(p / q.target) * 100}%`; bar.append(f);
      row.append(el('div', 'wlt', `${done ? '✔' : '◆'} ${q.title}`), el('div', 'wld', q.desc), bar, el('div', 'wlp', `${p}/${q.target} · ${q.xp} XP`));
      quests.append(row);
    }
    const ach = el('div', 'wla');
    for (const a of g.achievements) {
      const got = g.achieved(a);
      const t = el('div', `wlach ${got ? 'got' : ''}`);
      t.append(el('div', 'wlat', got ? a.title : '???'), el('div', 'wlad', a.desc));
      ach.append(t);
    }
    const reset = el('button', 'wlreset', 'Reset progress');
    reset.onclick = () => { if (confirm('Reset all progress for this repository?')) onReset(); };
    this.root.replaceChildren(
      el('div', 'wlh', `${r.name.toUpperCase()} · ${g.xp} XP · explored ${Math.round(e.loc * 100)}% of the code`),
      el('div', 'wls', 'QUESTS'), quests, el('div', 'wls', 'ACHIEVEMENTS'), ach,
      el('div', 'mhint', 'J or Esc to close'), reset,
    );
    this.root.classList.add('on');
  }
  hide() { this.root.classList.remove('on'); }
}
