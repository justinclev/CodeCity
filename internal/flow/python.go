package flow

import (
	"path"
	"strings"

	"github.com/justinclev/codecity/internal/scan"
)

type pyFunc struct {
	name, short string
	class       *pyClass
	line, end   int
	ind         int
	node        *Node
	locals      map[string]string // var → class name (x = Foo(...))
	decorators  [][]tok
	file        *pyFile
}

type pyClass struct {
	name      string
	bases     []string
	methods   map[string]*pyFunc
	fields    map[string]string
	node      *Node
	line, end int
	file      *pyFile
}

type pyFile struct {
	path    string
	toks    []tok
	owner   []*pyFunc
	funcs   []*pyFunc
	top     map[string]*pyFunc
	classes map[string]*pyClass
	binds   map[string]jsBind // local name → (file, name|"*") or external module
	imports map[string]bool
	module  *Node
	vars    map[string]string // module-level instances: name → class
}

var pyBuiltins = map[string]bool{}

func init() {
	for _, n := range strings.Fields(`print len range str int float bool list dict set tuple open isinstance issubclass getattr setattr hasattr
		super type sorted reversed enumerate zip map filter min max sum any all abs round repr format iter next id hash vars dir callable
		append extend insert pop remove clear update get items keys values copy join split strip lstrip rstrip replace lower upper startswith
		endswith encode decode format_map read write close readline readlines add discard sort index count find`) {
		pyBuiltins[n] = true
	}
}

func (b *builder) analyzePython(files []File, res *resolver) {
	pf := map[string]*pyFile{}
	var order []*pyFile
	byName := map[string][]*pyFunc{}
	for _, f := range files {
		if len(f.Content) > 1<<20 {
			continue
		}
		p := &pyFile{path: f.Path, toks: lexPy(f.Content), top: map[string]*pyFunc{}, classes: map[string]*pyClass{}, binds: map[string]jsBind{}, imports: map[string]bool{}, vars: map[string]string{}}
		parsePy(p, res)
		pf[f.Path] = p
		order = append(order, p)
	}
	// nodes
	for _, p := range order {
		test := scan.IsTestPath(p.path)
		for _, c := range p.classes {
			c.node = b.node("py:"+p.path+":"+c.name, Node{Kind: KClass, Sub: "class", Name: c.name, Path: p.path, Start: c.line, End: c.end, Lang: "Python",
				Exported: !strings.HasPrefix(c.name, "_"), Test: test})
		}
		for _, fn := range p.funcs {
			kind, parent := KFunc, -1
			if fn.class != nil && fn.class.node != nil {
				kind, parent = KMethod, fn.class.node.ID
			}
			fn.node = b.node("py:"+p.path+":"+fn.name+":"+itoa(fn.line), Node{Kind: kind, Name: fn.name, Path: p.path, Start: fn.line, End: fn.end,
				Parent: parent, Lang: "Python", Exported: !strings.HasPrefix(fn.short, "_"), Test: test})
			if fn.short == "main" && fn.class == nil {
				fn.node.Entry = "main"
			}
			byName[fn.short] = append(byName[fn.short], fn)
		}
	}
	classFor := func(p *pyFile, name string) *pyClass {
		if c := p.classes[name]; c != nil {
			return c
		}
		if bd, ok := p.binds[name]; ok && bd.file != "" {
			if q := pf[bd.file]; q != nil {
				return q.classes[bd.name]
			}
		}
		return nil
	}
	var method func(c *pyClass, name string, depth int) *pyFunc
	method = func(c *pyClass, name string, depth int) *pyFunc {
		if c == nil || depth > 6 {
			return nil
		}
		if m := c.methods[name]; m != nil {
			return m
		}
		for _, base := range c.bases {
			if m := method(classFor(c.file, base), name, depth+1); m != nil {
				return m
			}
		}
		return nil
	}
	moduleNode := func(p *pyFile) *Node {
		if p.module == nil {
			p.module = b.node("py:"+p.path+":‹top level›", Node{Kind: KFunc, Sub: "module", Name: path.Base(p.path) + " (top level)", Path: p.path,
				Start: 1, End: p.toks[len(p.toks)-1].line, Lang: "Python", Entry: "module", Test: scan.IsTestPath(p.path)})
		}
		return p.module
	}
	for _, p := range order {
		t := p.toks
		n := len(t)
		is := func(i int, v string) bool { return i >= 0 && i < n && t[i].k == tPunct && t[i].v == v }
		scope := func(i int) (*pyFunc, *Node) {
			if fn := p.owner[i]; fn != nil && fn.node != nil {
				return fn, fn.node
			}
			return nil, moduleNode(p)
		}
		// decorators: routes, CLI commands
		for _, fn := range p.funcs {
			for _, d := range fn.decorators {
				if len(d) < 2 || fn.node == nil {
					continue
				}
				names := []string{}
				for _, x := range d {
					if x.k == tIdent {
						names = append(names, x.v)
					} else if x.k == tPunct && x.v == "(" {
						break
					}
				}
				if len(names) == 0 {
					continue
				}
				last := names[len(names)-1]
				var lit string
				for k, x := range d {
					if x.k == tPunct && x.v == "(" && k+1 < len(d) && d[k+1].k == tString {
						lit = d[k+1].v
						break
					}
				}
				switch {
				case (last == "get" || last == "post" || last == "put" || last == "delete" || last == "patch" || last == "head" || last == "options") && strings.HasPrefix(lit, "/"):
					b.edge(b.endpoint(last, lit), fn.node, EHandles, "", fn.line, true)
				case (last == "route" || last == "api_route" || last == "websocket") && strings.HasPrefix(lit, "/"):
					methods := []string{}
					for k := 0; k+2 < len(d); k++ {
						if d[k].k == tIdent && d[k].v == "methods" {
							for j := k + 1; j < len(d) && !(d[j].k == tPunct && d[j].v == "]"); j++ {
								if d[j].k == tString {
									methods = append(methods, strings.ToUpper(d[j].v))
								}
							}
						}
					}
					if len(methods) == 0 {
						methods = []string{""}
					}
					for _, m := range methods {
						b.edge(b.endpoint(m, lit), fn.node, EHandles, "", fn.line, true)
					}
				case last == "command" || last == "group":
					name := lit
					if name == "" {
						name = strings.ReplaceAll(fn.short, "_", "-")
					}
					cmd := b.node("command:"+name, Node{Kind: KCommand, Name: name, Parent: -1})
					b.edge(cmd, fn.node, EHandles, "", fn.line, true)
				case last == "task" || last == "shared_task":
					ev := b.node("event:task "+fn.short, Node{Kind: KEvent, Sub: "task", Name: "task " + fn.short, Parent: -1})
					b.edge(ev, fn.node, EHandles, "", fn.line, true)
				}
			}
		}
		for i := 0; i < n; i++ {
			tk := t[i]
			if tk.k == tString {
				_, node := scope(i)
				b.sql(node, tk.v, tk.line)
				continue
			}
			if tk.k != tIdent {
				continue
			}
			fn, node := scope(i)
			line := tk.line
			chain := chainBefore(t, i)
			root := chain[0]
			// values: os.environ, sys.argv, sys.stdin, self.field
			if !is(i+1, "(") {
				switch {
				case root == "os" && tk.v == "environ":
					b.source(node, "env", "environment", "os.environ", line)
				case root == "sys" && tk.v == "argv":
					b.source(node, "args", "command-line arguments", "sys.argv", line)
				case root == "sys" && tk.v == "stdin":
					b.source(node, "stdin", "stdin", "", line)
				case len(chain) == 2 && root == "self" && fn != nil && fn.class != nil && fn.class.methods[tk.v] == nil:
					dn := b.node("py:field:"+p.path+":"+fn.class.name+"."+tk.v, Node{Kind: KData, Sub: "field", Name: fn.class.name + "." + tk.v,
						Path: p.path, Start: fn.class.line, End: fn.class.line, Parent: fn.class.node.ID, Lang: "Python"})
					if dn == nil {
						break
					}
					aug := i+2 < n && t[i+2].k == tPunct && t[i+2].v == "=" && t[i+1].k == tPunct && strings.Contains("+-*/|&", t[i+1].v)
					if (is(i+1, "=") || aug) && fn.short != "__init__" {
						b.edge(node, dn, EWrites, "", line, true)
					} else if !is(i+1, "=") {
						b.edge(dn, node, EFeeds, "", line, true)
					}
				}
				continue
			}
			if is(i-1, ".") && root == "self" && len(chain) == 3 && (tk.v == "append" || tk.v == "update" || tk.v == "add" || tk.v == "pop" || tk.v == "clear" || tk.v == "extend") && fn != nil && fn.class != nil {
				dn := b.node("py:field:"+p.path+":"+fn.class.name+"."+chain[1], Node{Kind: KData, Sub: "field", Name: fn.class.name + "." + chain[1],
					Path: p.path, Start: fn.class.line, End: fn.class.line, Parent: fn.class.node.ID, Lang: "Python"})
				b.edge(node, dn, EWrites, "", line, true)
			}
			arg, hasArg := firstString(t, i+1)
			name := tk.v
			// the outside world
			switch {
			case len(chain) == 1 && name == "print":
				b.sink(node, "stdio", "stdout", "print", line)
			case len(chain) == 1 && name == "open":
				mode := ""
				if sp := argSpans(t, i+1); len(sp) >= 2 && t[sp[1][0]].k == tString {
					mode = t[sp[1][0]].v
				}
				for k := i + 1; k < match(t, i+1); k++ {
					if t[k].k == tIdent && t[k].v == "mode" && k+2 < n && t[k+2].k == tString {
						mode = t[k+2].v
					}
				}
				if strings.ContainsAny(mode, "wax+") {
					b.sink(node, "file", "files (written)", strings.TrimSpace("open "+arg), line)
				} else {
					b.source(node, "file", "files (read)", strings.TrimSpace("open "+arg), line)
				}
			case name == "read_text" || name == "read_bytes":
				b.source(node, "file", "files (read)", name, line)
			case name == "write_text" || name == "write_bytes" || name == "mkdir" || name == "unlink" || name == "rmtree":
				b.sink(node, "file", "files (written)", name, line)
			case (root == "requests" || root == "httpx" || root == "aiohttp") && len(chain) == 2 && name != "Session" && name != "Client":
				if hasArg {
					b.request(node, strings.ToUpper(name), arg, line, "")
				} else {
					b.external(node, "http", "HTTP (dynamic URL)", strings.ToUpper(name), line)
				}
			case name == "urlopen":
				if hasArg {
					b.request(node, "GET", arg, line, "")
				} else {
					b.external(node, "http", "HTTP (dynamic URL)", "urlopen", line)
				}
			case root == "subprocess" && len(chain) == 2 || root == "os" && (name == "system" || name == "popen"):
				cmd := "process"
				if hasArg {
					cmd = strings.Fields(arg + " ")[0]
				} else if is(i+2, "[") && i+3 < n && t[i+3].k == tString {
					cmd = t[i+3].v
				}
				b.external(node, "process", path.Base(cmd), name, line)
			case root == "os" && (name == "getenv" || name == "putenv") || len(chain) == 3 && chain[1] == "environ" && name == "get":
				label := ""
				if hasArg {
					label = arg
				}
				if name == "putenv" {
					b.sink(node, "env", "environment (set)", label, line)
				} else {
					b.source(node, "env", "environment", label, line)
				}
			case root == "logging" || root == "logger" || root == "log" || root == "LOGGER":
				if len(chain) == 2 && name != "getLogger" && name != "basicConfig" {
					b.sink(node, "log", "log", name, line)
				}
			case name == "add_argument" && hasArg && strings.HasPrefix(arg, "-"):
				fl := b.node("flag:"+arg, Node{Kind: KFlag, Name: arg, Parent: -1})
				b.edge(fl, node, EFeeds, "", line, true)
			case name == "add_parser" && hasArg:
				cmd := b.node("command:"+arg, Node{Kind: KCommand, Name: arg, Parent: -1})
				b.edge(cmd, node, EHandles, "", line, true)
			case len(chain) >= 3 && chain[len(chain)-2] == "objects":
				verb := "SELECT"
				switch name {
				case "create", "update", "delete", "bulk_create", "bulk_update", "get_or_create", "update_or_create":
					verb = strings.ToUpper(name)
				}
				b.external(node, "db", chain[len(chain)-3], verb, line)
			case (root == "session" || root == "db" && len(chain) == 3 && chain[1] == "session") && (name == "add" || name == "delete" || name == "commit" || name == "merge" || name == "query" || name == "execute"):
				verb := "write"
				if name == "query" || name == "execute" {
					verb = "query"
				}
				model := "session"
				if name == "query" || name == "add" || name == "delete" {
					if k := i + 2; k < n && t[k].k == tIdent {
						model = t[k].v
					}
				}
				b.external(node, "db", model, verb, line)
			case len(chain) == 1 && (name == "path" || name == "re_path") && hasArg && strings.HasSuffix(p.path, "urls.py"):
				if sp := argSpans(t, i+1); len(sp) >= 2 {
					h := sp[1]
					if h[1]-1 >= h[0] && t[h[1]-1].k == tIdent {
						hc := chainBefore(t, h[1]-1)
						if tg := resolvePy(p, pf, hc, nil, classFor, method, byName); tg != nil && tg.node != nil {
							b.edge(b.endpoint("", "/"+strings.TrimPrefix(arg, "/")), tg.node, EHandles, "", line, true)
						}
					}
				}
			}
			// calls into the code base
			if root == "self" && len(chain) == 2 && fn != nil && fn.class != nil {
				if m := method(fn.class, name, 0); m != nil && m.node != nil {
					b.edge(node, m.node, ECall, "", line, true)
				}
				continue
			}
			if len(chain) == 3 && root == "self" && fn != nil && fn.class != nil {
				if ty := fn.class.fields[chain[1]]; ty != "" {
					if m := method(classFor(p, ty), name, 0); m != nil && m.node != nil {
						b.edge(node, m.node, ECall, "", line, true)
						continue
					}
				}
			}
			if len(chain) == 1 {
				if c := classFor(p, name); c != nil && c.node != nil {
					b.edge(node, c.node, ENew, "", line, true)
					if init := method(c, "__init__", 0); init != nil && init.node != nil {
						b.edge(node, init.node, ECall, "new", line, true)
					}
					continue
				}
			}
			if tg := resolvePy(p, pf, chain, fn, classFor, method, nil); tg != nil && tg.node != nil {
				b.edge(node, tg.node, ECall, "", line, true)
			} else if tg := resolvePy(p, pf, chain, fn, classFor, method, byName); tg != nil && tg.node != nil {
				b.edge(node, tg.node, ECall, "", line, false)
			}
		}
	}
}

// resolvePy resolves a call chain; with byName set it falls back to a unique name in this file or files it imports.
func resolvePy(p *pyFile, pf map[string]*pyFile, chain []string, fn *pyFunc, classFor func(*pyFile, string) *pyClass,
	method func(*pyClass, string, int) *pyFunc, byName map[string][]*pyFunc) *pyFunc {
	name := chain[len(chain)-1]
	if byName != nil {
		if pyBuiltins[name] || len(name) < 3 || strings.HasPrefix(name, "__") {
			return nil
		}
		var cand *pyFunc
		for _, x := range byName[name] {
			if x.file != p && !p.imports[x.file.path] {
				continue
			}
			if cand != nil {
				return nil
			}
			cand = x
		}
		return cand
	}
	switch len(chain) {
	case 1:
		if f := p.top[name]; f != nil {
			return f
		}
		if bd, ok := p.binds[name]; ok && bd.file != "" {
			if q := pf[bd.file]; q != nil {
				return q.top[bd.name]
			}
		}
	case 2:
		base := chain[0]
		if bd, ok := p.binds[base]; ok && bd.file != "" && bd.name == "*" {
			if q := pf[bd.file]; q != nil {
				return q.top[name]
			}
		}
		if fn != nil {
			if ty := fn.locals[base]; ty != "" {
				return method(classFor(p, ty), name, 0)
			}
		}
		if ty := p.vars[base]; ty != "" {
			return method(classFor(p, ty), name, 0)
		}
		if c := classFor(p, base); c != nil {
			return method(c, name, 0)
		}
	}
	return nil
}

// parsePy finds classes, functions (module level and methods), decorators and imports.
func parsePy(p *pyFile, res *resolver) {
	t := p.toks
	n := len(t)
	p.owner = make([]*pyFunc, n)
	type blk struct {
		ind   int
		fn    *pyFunc
		class *pyClass
	}
	var stack []blk
	var decos [][]tok
	is := func(i int, v string) bool { return i >= 0 && i < n && t[i].k == tPunct && t[i].v == v }
	endOf := func(i, ind int) (int, int) { // first token index after the block opened at i, and its last line
		j := i + 1
		for j < n && !(t[j].nl && t[j].ind <= ind) {
			j++
		}
		last := t[j-1].line
		return j, last
	}
	for i := 0; i < n; i++ {
		tk := t[i]
		if tk.nl {
			for len(stack) > 0 && tk.ind <= stack[len(stack)-1].ind {
				stack = stack[:len(stack)-1]
			}
		}
		var cur *pyFunc
		var curClass *pyClass
		for k := len(stack) - 1; k >= 0; k-- {
			if stack[k].fn != nil && cur == nil {
				cur = stack[k].fn
			}
			if stack[k].class != nil && curClass == nil && cur == nil {
				curClass = stack[k].class
			}
		}
		p.owner[i] = cur
		if !tk.nl {
			continue
		}
		switch {
		case tk.k == tPunct && tk.v == "@":
			j := i + 1
			for j < n && !t[j].nl {
				j++
			}
			decos = append(decos, t[i+1:j])
		case tk.k == tIdent && (tk.v == "def" || tk.v == "async" && i+1 < n && t[i+1].v == "def"):
			j := i + 1
			if tk.v == "async" {
				j++
			}
			if j >= n || t[j].k != tIdent {
				continue
			}
			name := t[j].v
			_, last := endOf(i, tk.ind)
			if cur != nil {
				// nested function: part of its enclosing function
				stack = append(stack, blk{ind: tk.ind, fn: cur})
				decos = nil
				continue
			}
			fn := &pyFunc{name: name, short: name, line: tk.line, end: last, ind: tk.ind, locals: map[string]string{}, decorators: decos, file: p}
			decos = nil
			if curClass != nil {
				fn.class = curClass
				fn.name = curClass.name + "." + name
				if curClass.methods[name] == nil {
					curClass.methods[name] = fn
				}
			} else if p.top[name] == nil {
				p.top[name] = fn
			}
			p.funcs = append(p.funcs, fn)
			stack = append(stack, blk{ind: tk.ind, fn: fn})
		case tk.k == tIdent && tk.v == "class" && i+1 < n && t[i+1].k == tIdent:
			_, last := endOf(i, tk.ind)
			c := &pyClass{name: t[i+1].v, methods: map[string]*pyFunc{}, fields: map[string]string{}, line: tk.line, end: last, file: p}
			if is(i+2, "(") {
				for k := i + 3; k < match(t, i+2); k++ {
					if t[k].k == tIdent && (is(k-1, "(") || is(k-1, ",") || is(k-1, ".")) && !is(k+1, "=") && !is(k+1, ".") {
						c.bases = append(c.bases, t[k].v)
					}
				}
			}
			decos = nil
			if cur == nil && p.classes[c.name] == nil {
				p.classes[c.name] = c
			}
			stack = append(stack, blk{ind: tk.ind, class: c})
		case tk.k == tIdent && tk.v == "import" && cur == nil:
			// import a.b.c [as d], e
			j := i + 1
			for j < n && !t[j].nl {
				start := j
				var parts []string
				for j < n && !t[j].nl && t[j].k == tIdent && t[j].v != "as" {
					parts = append(parts, t[j].v)
					j++
					if is(j, ".") {
						j++
					}
				}
				local := ""
				if len(parts) > 0 {
					local = parts[0]
				}
				if j < n && t[j].k == tIdent && t[j].v == "as" && j+1 < n {
					local = t[j+1].v
					j += 2
					if f, ok := res.file(p.path, "Python", strings.Join(parts, ".")); ok {
						p.binds[local] = jsBind{file: f, mod: strings.Join(parts, "."), name: "*"}
						p.imports[f] = true
					}
				} else if len(parts) > 0 {
					if f, ok := res.file(p.path, "Python", strings.Join(parts, ".")); ok && len(parts) == 1 {
						p.binds[local] = jsBind{file: f, mod: parts[0], name: "*"}
						p.imports[f] = true
					} else {
						p.binds[local] = jsBind{mod: parts[0], name: "*"}
					}
				}
				if j == start {
					j++
				}
				if is(j, ",") {
					j++
				}
			}
		case tk.k == tIdent && tk.v == "from" && cur == nil:
			// from .mod import a as b, c
			j := i + 1
			var spec strings.Builder
			for j < n && !(t[j].k == tIdent && t[j].v == "import") {
				spec.WriteString(t[j].v)
				j++
			}
			mod := spec.String()
			modFile, okMod := res.file(p.path, "Python", mod)
			if okMod {
				p.imports[modFile] = true
			}
			for j++; j < n && (!t[j].nl || is(j-1, ",") || is(j-1, "(")); j++ {
				if t[j].k != tIdent || t[j].v == "as" || is(j-1, ".") {
					continue
				}
				if j > 0 && t[j-1].k == tIdent && t[j-1].v == "as" {
					continue
				}
				name, local := t[j].v, t[j].v
				if j+2 < n && t[j+1].k == tIdent && t[j+1].v == "as" {
					local = t[j+2].v
				}
				sep := "."
				if strings.HasSuffix(mod, ".") {
					sep = ""
				}
				if sub, ok := res.file(p.path, "Python", mod+sep+name); ok { // a submodule
					p.binds[local] = jsBind{file: sub, mod: mod + sep + name, name: "*"}
					p.imports[sub] = true
				} else if okMod {
					p.binds[local] = jsBind{file: modFile, mod: mod, name: name}
				} else {
					p.binds[local] = jsBind{mod: mod, name: name}
				}
				if is(j+1, ")") {
					break
				}
			}
		}
		// module-level x = Type(...)
		if tk.nl && tk.k == tIdent && cur == nil && curClass == nil && is(i+1, "=") && i+3 < n && t[i+2].k == tIdent && is(i+3, "(") {
			p.vars[tk.v] = t[i+2].v
		}
		// self.x = Type(...) / x = Type(...) types
		if tk.nl && tk.k == tIdent && cur != nil {
			if tk.v == "self" && is(i+1, ".") && i+4 < n && t[i+2].k == tIdent && is(i+3, "=") && t[i+4].k == tIdent && is(i+5, "(") && cur.class != nil {
				if _, ok := cur.class.fields[t[i+2].v]; !ok {
					cur.class.fields[t[i+2].v] = t[i+4].v
				}
			} else if is(i+1, "=") && i+2 < n && t[i+2].k == tIdent && is(i+3, "(") {
				cur.locals[tk.v] = t[i+2].v
			}
		}
	}
}
