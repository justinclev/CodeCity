/**
 * Branch selection: a branch/tag dropdown under each repository line of the
 * analyze form, and a quick switcher on the loaded city's name. Refs come from
 * POST /api/refs (for-each-ref locally, ls-remote for URLs — no clone).
 */

export interface RefInfo { name: string; kind: 'branch' | 'remote' | 'tag'; commit: string; date?: string }
export interface Refs { default: string; current?: string; refs: RefInfo[]; more?: boolean }

const cache = new Map<string, Promise<Refs>>();

export function fetchRefs(source: string): Promise<Refs> {
  let p = cache.get(source);
  if (!p) {
    p = fetch('/api/refs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) })
      .then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
        return body as Refs;
      });
    p.catch(() => window.setTimeout(() => cache.delete(source), 15000)); // retry later
    cache.set(source, p);
  }
  return p;
}

/** Forget cached refs (after an analysis, branches may have moved). */
export function clearRefs() { cache.clear(); }

interface Line { index: number; source: string; ref: string }

/** Non-empty, non-comment lines of the source box: "source [ref]". */
export function parseLines(text: string): Line[] {
  const out: Line[] = [];
  text.split('\n').forEach((raw, index) => {
    const f = raw.trim().split(/\s+/).filter(Boolean);
    if (!f.length || f[0].startsWith('#')) return;
    out.push({ index, source: f[0], ref: f[1] ?? '' });
  });
  return out;
}

export const repoLabel = (source: string) => source.replace(/[/\\]+$/, '').replace(/\.git$/, '').split(/[/\\:]/).pop() || source;

/** A source worth asking about: a URL with a host and path, or a path. */
function complete(source: string) {
  if (/^(https?|ssh|git|file):\/\/[^/]+\/.+/.test(source)) return true;
  if (/^[^@\s/]+@[^:\s]+:.+/.test(source)) return true; // scp-like
  return /^(\/|~|\.|[A-Za-z]:[\\/])/.test(source);
}

const ago = (iso?: string) => {
  if (!iso) return '';
  const d = (Date.now() - Date.parse(iso)) / 86400000;
  if (!isFinite(d)) return '';
  return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 60 ? `${Math.round(d)}d ago` : d < 730 ? `${Math.round(d / 30)}mo ago` : `${Math.round(d / 365)}y ago`;
};

const TAG_LIMIT = 80;

function options(sel: HTMLSelectElement, refs: Refs | null, current: string, state: string) {
  sel.replaceChildren();
  const opt = (value: string, label: string, parent: HTMLElement = sel) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = label;
    parent.append(o);
    return o;
  };
  opt('', refs ? `default · ${refs.default}` : state);
  if (refs) {
    const group = (label: string, list: RefInfo[]) => {
      if (!list.length) return;
      const g = document.createElement('optgroup');
      g.label = label;
      for (const r of list) opt(r.name, r.date ? `${r.name}  ·  ${ago(r.date)}` : r.name, g);
      sel.append(g);
    };
    group('Branches', refs.refs.filter(r => r.kind === 'branch'));
    group('Remote branches', refs.refs.filter(r => r.kind === 'remote'));
    const tags = refs.refs.filter(r => r.kind === 'tag');
    group(tags.length > TAG_LIMIT ? `Tags (newest ${TAG_LIMIT} of ${tags.length})` : 'Tags', tags.slice(0, TAG_LIMIT));
  }
  if (current && ![...sel.options].some(o => o.value === current)) opt(current, `${current}  (custom)`);
  opt('__other', 'Other ref or commit…');
  sel.value = current;
}

/**
 * Keep one branch row per repository line of the source box. Picking a branch
 * rewrites that line to "source ref" (or just "source" for the default branch).
 */
export function bindBranchRows(box: HTMLTextAreaElement, rows: HTMLElement, enabled: () => boolean, nameOf: (source: string) => string | undefined = () => undefined) {
  let timer = 0;
  const write = (index: number, source: string, ref: string) => {
    const lines = box.value.split('\n');
    lines[index] = ref ? `${source} ${ref}` : source;
    box.value = lines.join('\n');
    render();
  };
  const render = () => {
    const lines = parseLines(box.value);
    rows.replaceChildren();
    if (!enabled()) return;
    for (const l of lines) {
      const row = document.createElement('div');
      row.className = 'brow';
      const name = document.createElement('span');
      name.className = 'bname';
      name.textContent = nameOf(l.source) ?? repoLabel(l.source);
      name.title = l.source;
      const sel = document.createElement('select');
      sel.title = 'branch, tag or commit to analyze';
      row.append(name, sel);
      rows.append(row);
      if (!complete(l.source)) { options(sel, null, l.ref, 'default branch'); continue; }
      options(sel, null, l.ref, 'loading branches…');
      fetchRefs(l.source).then(refs => {
        if (!row.isConnected) return;
        options(sel, refs, l.ref, '');
        if (refs.more) sel.title = 'branches and tags (list truncated)';
      }, (e: Error) => {
        if (!row.isConnected) return;
        options(sel, null, l.ref, 'default branch');
        row.classList.add('err');
        row.title = `branches unavailable: ${e.message}`;
      });
      sel.onchange = () => {
        if (sel.value !== '__other') { write(l.index, l.source, sel.value); return; }
        // free text: a tag, a commit hash, anything git can resolve
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'ref or commit, Enter to keep';
        input.value = l.ref;
        input.spellcheck = false;
        sel.replaceWith(input);
        input.focus();
        const done = (keep: boolean) => { const v = input.value.trim(); if (keep && v && !v.startsWith('-') && !/\s/.test(v)) write(l.index, l.source, v); else render(); };
        input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); done(true); } else if (e.key === 'Escape') { e.preventDefault(); done(false); } };
        input.onblur = () => done(true);
      };
    }
  };
  box.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(render, 600); });
  return render;
}

/** The loaded city's repositories, as the switcher sees them. */
export interface LoadedRepo { name: string; source: string; ref: string }

/** Popover under the city name: pick another branch and re-analyze. */
export function showSwitcher(pop: HTMLElement, anchor: HTMLElement, repos: LoadedRepo[], pick: (repo: number, ref: string) => void) {
  if (!pop.hidden) { pop.hidden = true; return; }
  pop.replaceChildren();
  const close = () => { pop.hidden = true; document.removeEventListener('mousedown', outside, true); };
  const outside = (e: MouseEvent) => { if (!pop.contains(e.target as Node) && e.target !== anchor) close(); };
  repos.forEach((r, k) => {
    const sec = document.createElement('div');
    sec.className = 'bsec';
    const h = document.createElement('div');
    h.className = 'bh';
    h.textContent = repos.length > 1 ? r.name : 'Switch branch';
    const filter = document.createElement('input');
    filter.type = 'text';
    filter.placeholder = 'filter branches and tags…';
    filter.spellcheck = false;
    const list = document.createElement('div');
    list.className = 'blist';
    list.textContent = 'loading…';
    sec.append(h, filter, list);
    pop.append(sec);
    fetchRefs(r.source).then(refs => {
      const draw = () => {
        const q = filter.value.trim().toLowerCase();
        list.replaceChildren();
        const shown = refs.refs.filter(x => !q || x.name.toLowerCase().includes(q)).slice(0, 120);
        for (const x of shown) {
          const b = document.createElement('button');
          b.type = 'button';
          const cur = x.name === r.ref || (r.ref === 'HEAD' && x.name === refs.current);
          b.className = cur ? 'cur' : '';
          const n = document.createElement('span'); n.className = 'bn'; n.textContent = (cur ? '✓ ' : '') + x.name;
          const m = document.createElement('span'); m.className = 'bm';
          m.textContent = [x.kind === 'branch' ? '' : x.kind, x.name === refs.default ? 'default' : '', ago(x.date)].filter(Boolean).join(' · ');
          b.append(n, m);
          b.onclick = () => { close(); if (!cur) pick(k, x.name); };
          list.append(b);
        }
        if (!shown.length) list.textContent = q ? 'no match — Enter analyzes it as a ref' : 'no branches';
      };
      draw();
      filter.oninput = draw;
      filter.onkeydown = e => {
        if (e.key === 'Escape') close();
        if (e.key === 'Enter') { const v = filter.value.trim(); const first = list.querySelector('button'); if (first) (first as HTMLButtonElement).click(); else if (v && !v.startsWith('-') && !/\s/.test(v)) { close(); pick(k, v); } }
      };
    }, (e: Error) => { list.textContent = `branches unavailable: ${e.message}`; });
    if (k === 0) window.setTimeout(() => filter.focus(), 0);
  });
  pop.hidden = false;
  document.addEventListener('mousedown', outside, true);
}
