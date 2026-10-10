/** Read-only source viewer with lightweight, language-agnostic highlighting. */

export interface Piece { name: string; kind: string; start: number; end: number; parent: number; loc: number; complexity: number }
export interface FileData { path: string; commit: string; lang: string; content: string; lines: number; pieces: Piece[]; partial?: boolean }

const KEYWORDS = new Set(('break case catch class const continue default def defer delete do else elif enum export extends false final ' +
  'finally fn for from func function go if impl import in interface is let match mod mut new nil None null package private protected pub ' +
  'public return self static struct super switch this throw throws True False true try type typeof use var void while yield async await ' +
  'lambda except raise pass with as not and or select chan map range trait where loop unsafe crate override val fun object when namespace ' +
  'using readonly abstract implements module require end begin then local unless until elsif rescue ensure goto sizeof template typename ' +
  'virtual inline volatile extern unsigned signed int float double char bool boolean string long short byte void').split(' '));

export function commentToken(lang: string): string {
  if (['Python', 'Ruby', 'Shell', 'YAML', 'TOML', 'Elixir', 'R', 'Makefile', 'Docker', 'Config', 'Julia', 'Terraform', 'PowerShell'].includes(lang)) return '#';
  if (['Lua', 'SQL', 'Haskell'].includes(lang)) return '--';
  if (['Markdown', 'Text', 'JSON'].includes(lang)) return '';
  return '//';
}

export type Tok = [cls: string, text: string];

/** Tokenize one line; `block` carries an open /* comment across lines. */
export function tokenize(line: string, lc: string, state: { block: boolean }): Tok[] {
  const out: Tok[] = [];
  let i = 0, plain = '';
  const flush = () => { if (plain) { out.push(['', plain]); plain = ''; } };
  while (i < line.length) {
    if (state.block) {
      const e = line.indexOf('*/', i);
      const end = e < 0 ? line.length : e + 2;
      out.push(['c', line.slice(i, end)]);
      i = end;
      if (e >= 0) state.block = false;
      continue;
    }
    const rest = line.slice(i);
    if (lc && rest.startsWith(lc)) { flush(); out.push(['c', rest]); break; }
    if (lc === '//' && rest.startsWith('/*')) { flush(); state.block = true; continue; }
    const ch = line[i];
    if (ch === '"' || ch === '\'' || ch === '`') {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
      flush();
      out.push(['s', line.slice(i, j + 1)]);
      i = j + 1;
      continue;
    }
    const m = /^[A-Za-z_$][\w$]*/.exec(rest) ?? /^\d[\w.]*/.exec(rest);
    if (m) {
      const w = m[0];
      flush();
      if (/^\d/.test(w)) out.push(['n', w]);
      else if (KEYWORDS.has(w)) out.push(['k', w]);
      else if (/^\s*\(/.test(line.slice(i + w.length))) out.push(['f', w]);
      else if (/^[A-Z]/.test(w)) out.push(['t', w]);
      else out.push(['', w]);
      i += w.length;
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}

export interface CodeHandlers { onClose(): void; onStep(delta: number): void }

const MAX_RENDER = 4000;

export function showCode(f: FileData | null, piece: number, h: CodeHandlers) {
  const box = document.getElementById('code')!;
  if (!f) { box.hidden = true; return; }
  const p = f.pieces[piece];
  const lines = f.content.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const head = document.createElement('div');
  head.className = 'codehead';
  const title = document.createElement('div');
  title.className = 'codetitle';
  const nm = document.createElement('b');
  nm.textContent = p ? p.name : f.path;
  const sub = document.createElement('span');
  sub.textContent = `${f.path} · ${f.commit.slice(0, 8)}` + (p ? ` · lines ${p.start}–${p.end} · ${p.loc} LOC · complexity ${p.complexity}` : '');
  title.append(nm, sub);
  const btn = (label: string, tip: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label; b.title = tip; b.onclick = fn;
    return b;
  };
  const copy = btn('Copy', 'copy this piece', () => {
    const text = p ? lines.slice(p.start - 1, p.end).join('\n') : f.content;
    void navigator.clipboard?.writeText(text).then(() => { copy.textContent = 'Copied'; });
  });
  head.append(title, btn('‹', 'previous piece ([)', () => h.onStep(-1)), btn('›', 'next piece (])', () => h.onStep(1)), copy, btn('×', 'close (Esc)', h.onClose));

  const body = document.createElement('div');
  body.className = 'codebody';
  // very large files: only render around the piece
  let from = 0, to = lines.length;
  if (lines.length > MAX_RENDER) {
    const c = p ? p.start - 1 : 0;
    from = Math.max(0, c - 300);
    to = Math.min(lines.length, (p ? p.end : c) + 300);
  }
  const lc = commentToken(f.lang);
  const state = { block: false };
  const frag = document.createDocumentFragment();
  let target: HTMLElement | null = null;
  for (let i = from; i < to; i++) {
    const row = document.createElement('div');
    row.className = 'ln' + (p && i + 1 >= p.start && i + 1 <= p.end ? ' hl' : '');
    const num = document.createElement('span');
    num.className = 'no';
    num.textContent = String(i + 1);
    const code = document.createElement('span');
    code.className = 'src';
    for (const [cls, text] of tokenize(lines[i], lc, state)) {
      if (!cls) { code.append(text); continue; }
      const s = document.createElement('span');
      s.className = 't' + cls;
      s.textContent = text;
      code.append(s);
    }
    row.append(num, code);
    frag.append(row);
    if (p && i + 1 === p.start) target = row;
  }
  body.append(frag);
  if (f.partial) {
    const note = document.createElement('div');
    note.className = 'help';
    note.textContent = 'File truncated at 1 MB.';
    body.append(note);
  }
  box.replaceChildren(head, body);
  box.hidden = false;
  if (target) body.scrollTop = Math.max(0, target.offsetTop - 40);
}
