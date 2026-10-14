package flow

import (
	"path"
	"strings"

	"github.com/justinclev/codecity/internal/scan"
)

type rsFunc struct {
	name, short string
	typ         string // impl type ("" for free functions)
	trait       string // impl Trait for Type
	line, end   int
	node        *Node
	attrs       [][]tok
	file        string
	abstract    bool
}

// analyzeRust: free functions, impl blocks (methods as Type::name), traits, structs/enums; calls by path, self and
// unique names; axum/actix routes, std::fs, Command, reqwest, env, println!/log macros, SQL strings.
func (b *builder) analyzeRust(files []File, res *resolver) {
	type rsFile struct {
		path  string
		toks  []tok
		owner []*rsFunc
		funcs []*rsFunc
		uses  map[string]bool
	}
	var order []*rsFile
	types := map[string]*Node{}
	methods := map[string]map[string]*rsFunc{} // type → name → fn
	free := map[string][]*rsFunc{}             // name → free functions
	allByName := map[string][]*rsFunc{}
	for _, f := range files {
		if len(f.Content) > 1<<20 {
			continue
		}
		rf := &rsFile{path: f.Path, toks: lexC(f.Content, true), uses: map[string]bool{}}
		t := rf.toks
		n := len(t)
		rf.owner = make([]*rsFunc, n)
		is := func(i int, v string) bool { return i >= 0 && i < n && t[i].k == tPunct && t[i].v == v }
		type frame struct {
			fn       *rsFunc
			impl     string
			trait    string
			isTrait  bool
			closeTok int
		}
		var stack []frame
		var attrs [][]tok
		test := scan.IsTestPath(f.Path)
		for i := 0; i < n; i++ {
			for len(stack) > 0 && i > stack[len(stack)-1].closeTok {
				stack = stack[:len(stack)-1]
			}
			var cur *rsFunc
			impl, trait, inTrait := "", "", false
			for k := len(stack) - 1; k >= 0; k-- {
				if stack[k].fn != nil && cur == nil {
					cur = stack[k].fn
				}
				if (stack[k].impl != "" || stack[k].isTrait) && impl == "" {
					impl, trait, inTrait = stack[k].impl, stack[k].trait, stack[k].isTrait
				}
			}
			rf.owner[i] = cur
			tk := t[i]
			switch {
			case is(i, "#") && is(i+1, "["):
				c := match(t, i+1)
				attrs = append(attrs, t[i+2:c])
				i = c
			case tk.k == tIdent && tk.v == "use":
				for j := i + 1; j < n && !is(j, ";"); j++ {
					if t[j].k == tIdent {
						rf.uses[t[j].v] = true
					}
				}
			case tk.k == tIdent && (tk.v == "struct" || tk.v == "enum" || tk.v == "trait") && i+1 < n && t[i+1].k == tIdent && cur == nil:
				name := t[i+1].v
				end := i + 2
				for end < n && !is(end, "{") && !is(end, ";") && !is(end, "(") {
					end++
				}
				last := t[min(end, n-1)].line
				if is(end, "{") || is(end, "(") {
					last = t[match(t, end)].line
				}
				sub := tk.v
				if sub == "trait" {
					sub = "interface"
				}
				types[name] = b.node("rs:"+name, Node{Kind: KClass, Sub: sub, Name: name, Path: f.Path, Start: tk.line, End: last, Lang: "Rust", Test: test})
				if tk.v == "trait" && is(end, "{") {
					stack = append(stack, frame{impl: name, isTrait: true, closeTok: match(t, end)})
					i = end
				}
				attrs = nil
			case tk.k == tIdent && tk.v == "impl" && cur == nil:
				// impl<T> Trait for Type<T> { … } / impl Type { … }
				j := i + 1
				if is(j, "<") {
					j = match(t, j) + 1
				}
				var names []string
				forAt := -1
				for j < n && !is(j, "{") {
					if t[j].k == tIdent && !is(j-1, "<") && !is(j-1, "::") && !is(j+1, "::") {
						if t[j].v == "for" {
							forAt = len(names)
						} else if t[j].v != "dyn" && t[j].v != "where" && t[j].v != "mut" {
							names = append(names, t[j].v)
						}
					}
					if is(j, "<") {
						j = match(t, j)
					}
					j++
				}
				if len(names) == 0 || j >= n {
					continue
				}
				fr := frame{impl: names[0], closeTok: match(t, j)}
				if forAt > 0 && forAt < len(names) {
					fr.trait, fr.impl = names[0], names[forAt]
				}
				stack = append(stack, fr)
				i = j
				attrs = nil
			case tk.k == tIdent && tk.v == "fn" && i+1 < n && t[i+1].k == tIdent:
				name := t[i+1].v
				j := i + 2
				if is(j, "<") {
					j = match(t, j) + 1
				}
				if !is(j, "(") {
					continue
				}
				j = match(t, j) + 1
				for j < n && !is(j, "{") && !is(j, ";") {
					if is(j, "<") {
						j = match(t, j)
					}
					j++
				}
				if cur != nil {
					// nested fn: part of its parent
					if is(j, "{") {
						stack = append(stack, frame{fn: cur, closeTok: match(t, j)})
						i = j
					}
					continue
				}
				fn := &rsFunc{name: name, short: name, typ: impl, trait: trait, line: tk.line, attrs: attrs, file: f.Path}
				attrs = nil
				if impl != "" {
					fn.name = impl + "::" + name
				}
				if is(j, ";") {
					fn.abstract, fn.end = true, tk.line
					if !inTrait {
						continue
					}
				} else {
					c := match(t, j)
					fn.end = t[c].line
					stack = append(stack, frame{fn: fn, closeTok: c})
					i = j
				}
				rf.funcs = append(rf.funcs, fn)
			}
		}
		order = append(order, rf)
	}
	// nodes
	for _, rf := range order {
		test := scan.IsTestPath(rf.path)
		for _, fn := range rf.funcs {
			kind, parent, sub := KFunc, -1, ""
			if fn.typ != "" {
				kind = KMethod
				if c := types[fn.typ]; c != nil {
					parent = c.ID
				}
			}
			if fn.abstract {
				sub = "abstract"
			}
			for _, a := range fn.attrs {
				if len(a) > 0 && a[0].v == "test" {
					test = true
				}
			}
			fn.node = b.node("rs:"+rf.path+":"+fn.name+":"+itoa(fn.line), Node{Kind: kind, Sub: sub, Name: fn.name, Path: rf.path, Start: fn.line, End: fn.end,
				Parent: parent, Lang: "Rust", Test: test})
			if fn.node == nil {
				continue
			}
			if fn.typ == "" && fn.short == "main" {
				fn.node.Entry = "main"
			}
			if fn.typ != "" {
				if methods[fn.typ] == nil {
					methods[fn.typ] = map[string]*rsFunc{}
				}
				if old := methods[fn.typ][fn.short]; old == nil || old.abstract {
					methods[fn.typ][fn.short] = fn
				}
			} else {
				free[fn.short] = append(free[fn.short], fn)
			}
			allByName[fn.short] = append(allByName[fn.short], fn)
			// actix / rocket route attributes: #[get("/x")]
			for _, a := range fn.attrs {
				if len(a) >= 3 && a[0].k == tIdent && a[1].v == "(" && a[2].k == tString {
					if m, ok := jsRouteMethods[a[0].v]; ok || a[0].v == "route" {
						b.edge(b.endpoint(m, a[2].v), fn.node, EHandles, "", fn.line, true)
					}
				}
			}
		}
	}
	// trait methods → implementations
	for typ, ms := range methods {
		for _, m := range ms {
			if m.trait == "" {
				continue
			}
			if tm := methods[m.trait][m.short]; tm != nil && tm.node != nil && m.node != nil {
				b.edge(tm.node, m.node, EImpl, "", 0, true)
			}
		}
		_ = typ
	}
	unique := func(list []*rsFunc) *rsFunc {
		if len(list) == 1 {
			return list[0]
		}
		return nil
	}
	moduleNodes := map[string]*Node{}
	localTypes := map[*rsFunc]map[string]string{}
	for _, rf := range order {
		t := rf.toks
		n := len(t)
		is := func(i int, v string) bool { return i >= 0 && i < n && t[i].k == tPunct && t[i].v == v }
		for i := 0; i < n; i++ {
			tk := t[i]
			fn := rf.owner[i]
			var node *Node
			if fn != nil {
				node = fn.node
			}
			if node == nil {
				if moduleNodes[rf.path] == nil {
					moduleNodes[rf.path] = b.node("rs:"+rf.path+":‹top level›", Node{Kind: KFunc, Sub: "module", Name: path.Base(rf.path) + " (statics)",
						Path: rf.path, Start: 1, End: t[n-1].line, Lang: "Rust"})
				}
				node = moduleNodes[rf.path]
			}
			if tk.k == tString {
				b.sql(node, tk.v, tk.line)
				continue
			}
			if tk.k != tIdent {
				continue
			}
			line := tk.line
			// let [mut] x = Type::new(…) / let x: Type = …
			if tk.v == "let" && fn != nil {
				j := i + 1
				if j < n && t[j].v == "mut" {
					j++
				}
				if j+2 < n && t[j].k == tIdent {
					ty := ""
					if is(j+1, ":") && t[j+2].k == tIdent {
						ty = t[j+2].v
					} else if is(j+1, "=") {
						for k := j + 2; k+2 < n && !is(k, ";") && k < j+12; k++ {
							if t[k].k == tIdent && is(k+1, "::") && methods[t[k].v] != nil {
								ty = t[k].v
							}
						}
					}
					if ty != "" {
						if localTypes[fn] == nil {
							localTypes[fn] = map[string]string{}
						}
						localTypes[fn][t[j].v] = ty
					}
				}
			}
			// macros
			if is(i+1, "!") && (is(i+2, "(") || is(i+2, "[") || is(i+2, "{")) {
				switch tk.v {
				case "println", "print":
					b.sink(node, "stdio", "stdout", tk.v+"!", line)
				case "eprintln", "eprint":
					b.sink(node, "stdio", "stderr", tk.v+"!", line)
				case "info", "warn", "error", "debug", "trace":
					b.sink(node, "log", "log", tk.v+"!", line)
				}
				continue
			}
			call := is(i+1, "(") || is(i+1, "::") && is(i+2, "<") // turbofish
			if !call {
				// self.field = …
				if is(i-1, ".") && i >= 2 && t[i-2].v == "self" && fn != nil && fn.typ != "" && !is(i+1, "(") {
					dn := b.node("rs:field:"+fn.typ+"."+tk.v, Node{Kind: KData, Sub: "field", Name: fn.typ + "." + tk.v, Path: rf.path, Start: fn.line, End: fn.line,
						Parent: idOf(types[fn.typ]), Lang: "Rust"})
					if dn == nil {
						continue
					}
					if is(i+1, "=") || (i+2 < n && is(i+2, "=") && is(i+1, "+")) || (is(i+1, ".") && i+3 < n && (t[i+2].v == "push" || t[i+2].v == "insert" || t[i+2].v == "remove" || t[i+2].v == "clear")) {
						if fn.short != "new" {
							b.edge(node, dn, EWrites, "", line, true)
						}
					} else {
						b.edge(dn, node, EFeeds, "", line, true)
					}
				}
				continue
			}
			chain := chainBefore(t, i)
			name := tk.v
			arg, hasArg := firstString(t, i+1)
			joined := strings.Join(chain, "::")
			switch {
			case strings.HasSuffix(joined, "fs::read_to_string") || strings.HasSuffix(joined, "fs::read") || strings.HasSuffix(joined, "File::open") || strings.HasSuffix(joined, "fs::read_dir"):
				b.source(node, "file", "files (read)", strings.TrimSpace(name+" "+arg), line)
			case strings.HasSuffix(joined, "fs::write") || strings.HasSuffix(joined, "File::create") || strings.HasSuffix(joined, "fs::create_dir_all") ||
				strings.HasSuffix(joined, "fs::remove_file") || strings.HasSuffix(joined, "fs::remove_dir_all") || strings.HasSuffix(joined, "fs::rename"):
				b.sink(node, "file", "files (written)", strings.TrimSpace(name+" "+arg), line)
			case strings.HasSuffix(joined, "Command::new"):
				cmd := "process"
				if hasArg {
					cmd = path.Base(arg)
				}
				b.external(node, "process", cmd, "Command::new", line)
			case strings.HasSuffix(joined, "env::var") || strings.HasSuffix(joined, "env::var_os"):
				b.source(node, "env", "environment", arg, line)
			case strings.HasSuffix(joined, "env::args"):
				b.source(node, "args", "command-line arguments", "env::args", line)
			case strings.HasSuffix(joined, "stdin"):
				b.source(node, "stdin", "stdin", "", line)
			case chain[0] == "reqwest" || (rf.uses["reqwest"] && len(chain) == 2 && (chain[0] == "client" || chain[0] == "http")) && (name == "get" || name == "post" || name == "put" || name == "delete" || name == "patch"):
				if hasArg {
					b.request(node, strings.ToUpper(name), arg, line, "")
				} else {
					b.external(node, "http", "HTTP (dynamic URL)", strings.ToUpper(name), line)
				}
			case name == "route" && hasArg && strings.HasPrefix(arg, "/"):
				// axum: .route("/x", get(handler).post(other))
				spans := argSpans(t, i+1)
				if len(spans) >= 2 {
					for k := spans[1][0]; k+3 < spans[1][1]; k++ {
						if t[k].k == tIdent && is(k+1, "(") && t[k+2].k == tIdent {
							if m, ok := jsRouteMethods[t[k].v]; ok {
								c := match(t, k+1)
								h := chainBefore(t, c-1)
								target := unique(free[h[len(h)-1]])
								if len(h) >= 2 {
									if ms := methods[h[len(h)-2]]; ms != nil && ms[h[len(h)-1]] != nil {
										target = ms[h[len(h)-1]]
									}
								}
								if target != nil && target.node != nil {
									b.edge(b.endpoint(m, arg), target.node, EHandles, "", line, true)
								}
							}
						}
					}
				}
			}
			// calls into the code base
			var target *rsFunc
			exact := true
			switch {
			case len(chain) >= 2 && (chain[len(chain)-2] == "self" && !is(i-1, "::")) && fn != nil && fn.typ != "":
				target = methods[fn.typ][name]
			case len(chain) >= 2 && chain[len(chain)-2] == "Self" && fn != nil && fn.typ != "":
				target = methods[fn.typ][name]
			case len(chain) >= 2 && is(i-1, "::") && methods[chain[len(chain)-2]] != nil:
				target = methods[chain[len(chain)-2]][name]
			case len(chain) == 1 || is(i-1, "::"):
				target = unique(free[name])
				if target == nil {
					for _, x := range free[name] {
						if x.file == rf.path {
							target = x
						}
					}
				}
			case len(chain) == 2 && fn != nil && localTypes[fn][chain[0]] != "":
				target = methods[localTypes[fn][chain[0]]][name]
			default:
				// x.method(): by unique name
				if l := allByName[name]; len(l) == 1 && len(name) > 3 && !jsBuiltinNames[name] && l[0].typ != "" {
					target, exact = l[0], false
				}
			}
			if target != nil && target.node != nil && target.node != node {
				b.edge(node, target.node, ECall, "", line, exact)
			} else if len(chain) == 2 && is(i-1, "::") && types[chain[0]] != nil && (name == "new" || name == "default") {
				b.edge(node, types[chain[0]], ENew, "", line, true)
			}
		}
	}
}

func idOf(n *Node) int {
	if n == nil {
		return -1
	}
	return n.ID
}
