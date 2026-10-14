package flow

import (
	"path"
	"regexp"
	"strings"

	"github.com/justinclev/codecity/internal/deps"
	"github.com/justinclev/codecity/internal/scan"
)

// ---------------------------------------------------------------- import resolution

type resolver struct {
	r *deps.Resolver
}

func newResolver(files []File, paths []string) *resolver {
	var own []deps.Identity
	for _, f := range files {
		if deps.IsManifest(f.Path) {
			ids, _ := deps.Manifest(f.Path, f.Content)
			own = append(own, ids...)
		}
	}
	return &resolver{deps.NewResolver(paths, own)}
}

func (r *resolver) file(from, lang, spec string) (string, bool) {
	t, ok := r.r.Resolve(from, lang, spec)
	if !ok || t.Dir {
		return "", false
	}
	return t.Path, true
}

// ---------------------------------------------------------------- model

type jsFunc struct {
	name      string // display name: f, Class.m, owner.m
	short     string // the bare name
	class     *jsClass
	declTok   int
	bodyStart int // token range of the body (inclusive start, exclusive end)
	bodyEnd   int
	line, end int
	node      *Node
	route     string // inline HTTP handler "GET /x"
	params    map[string]string
	locals    map[string]string // local variable → type name
	file      *jsFile
	fetches   bool   // calls fetch / axios (a request wrapper)
	objOwner  string // obj.name = function …: "this" inside means obj
}

type jsClass struct {
	name       string
	iface      bool
	extends    string
	implements []string
	methods    map[string]*jsFunc
	fields     map[string]string // field → type name
	node       *Node
	file       *jsFile
	line, end  int
}

type jsBind struct {
	file string // resolved file ("" = external module)
	mod  string // module spec
	name string // export name, "*" (namespace) or "default"
}

type jsFile struct {
	path, lang string
	toks       []tok
	owner      []*jsFunc
	funcs      []*jsFunc
	classes    map[string]*jsClass
	top        map[string]*jsFunc // module-level functions by name
	binds      map[string]jsBind
	exports    map[string]string // exported name → local name
	reexports  map[string]jsBind
	starFrom   []string
	declTok    map[int]bool
	module     *Node
	imports    map[string]bool // files this file imports
	objFuncs   map[string][]*jsFunc
	owned      map[string]map[string]*jsFunc // obj → name → function (obj.name = function …, X.prototype.name = …)
}

var jsKeywords = map[string]bool{"if": true, "for": true, "while": true, "switch": true, "catch": true, "function": true, "return": true,
	"typeof": true, "super": true, "import": true, "with": true, "do": true, "else": true, "new": true, "await": true, "yield": true,
	"void": true, "delete": true, "in": true, "of": true, "instanceof": true, "case": true, "throw": true, "class": true, "const": true,
	"let": true, "var": true, "export": true, "default": true, "async": true, "constructor": true, "this": true, "as": true, "satisfies": true}

var jsModifiers = map[string]bool{"public": true, "private": true, "protected": true, "static": true, "readonly": true, "async": true,
	"abstract": true, "override": true, "declare": true, "get": true, "set": true, "accessor": true}

// common method names of built-in objects: never resolved by name alone
var jsBuiltinNames = map[string]bool{}

func init() {
	for _, n := range strings.Fields(`add get set has delete clear push pop shift unshift map filter reduce forEach find findIndex some every
		includes indexOf join split slice splice concat sort reverse keys values entries then catch finally toString replace replaceAll
		trim test exec match append remove copy clone lerp normalize update dispose render start stop close open send write read load
		emit on off once resolve reject call apply bind next done end parse stringify assign create from of freeze log error warn info
		debug fill flat flatMap at item toFixed abs min max floor ceil round random sqrt pow sin cos atan2 hypot now getTime setTimeout
		setInterval requestAnimationFrame focus blur click submit reset contains querySelector getElementById addEventListener
		removeEventListener dispatchEvent appendChild removeChild replaceChildren setAttribute getAttribute toggle multiplyScalar
		addScaledVector subVectors applyMatrix4 setScalar setRGB setHex copyFrom subscribe unsubscribe pipe init run handle size
		length count format equals compare execute query select insert apply validate`) {
		jsBuiltinNames[n] = true
	}
}

// ---------------------------------------------------------------- pass 1: structure

type jsCtx struct {
	kind  byte // c class, i interface, f function, o object, b block
	fn    *jsFunc
	class *jsClass
	obj   string
	open  int
}

func (b *builder) parseScript(f *jsFile) {
	t := f.toks
	n := len(t)
	f.owner = make([]*jsFunc, n)
	f.declTok = map[int]bool{}
	var stack []jsCtx
	cur := func() *jsFunc {
		for k := len(stack) - 1; k >= 0; k-- {
			if stack[k].fn != nil {
				return stack[k].fn
			}
		}
		return nil
	}
	inFunc := func() bool {
		for k := len(stack) - 1; k >= 0; k-- {
			if stack[k].kind == 'f' {
				return true
			}
		}
		return false
	}
	top := func() byte {
		if len(stack) == 0 {
			return 0
		}
		return stack[len(stack)-1].kind
	}
	is := func(i int, v string) bool { return i >= 0 && i < n && t[i].k == tPunct && t[i].v == v }
	id := func(i int, v string) bool { return i >= 0 && i < n && t[i].k == tIdent && t[i].v == v }
	// pending: the next "{" opens this function's body
	var pendingFn *jsFunc
	pendingAnon := false
	var pendingClass *jsClass
	// expression-bodied arrows: token spans owned by a function
	type span struct {
		from, to int
		fn       *jsFunc
	}
	var spans []span
	routeAt := map[int]string{} // "(" index of app.get('/x', …) → "GET /x"

	newFn := func(name, short string, class *jsClass, declTok int) *jsFunc {
		fn := &jsFunc{name: name, short: short, class: class, declTok: declTok, line: t[declTok].line, params: map[string]string{}, locals: map[string]string{}, file: f}
		f.funcs = append(f.funcs, fn)
		f.declTok[declTok] = true
		return fn
	}
	// skipType advances from i over a TypeScript type annotation, stopping at one of the stop tokens at depth 0.
	skipType := func(i int, stops ...string) int {
		depth := 0
		for i < n {
			if t[i].k == tPunct {
				switch t[i].v {
				case "(", "[", "<":
					depth++
				case ")", "]", ">":
					depth--
				case "{":
					if depth == 0 && !is(i-1, ":") && !is(i-1, "|") && !is(i-1, "&") && !is(i-1, "<") && !is(i-1, ",") {
						for _, s := range stops {
							if s == "{" {
								return i
							}
						}
					}
					depth++
				case "}":
					depth--
				}
				if depth <= 0 {
					for _, s := range stops {
						if t[i].v == s && (depth == 0 || s == "{") {
							return i
						}
					}
				}
				if depth < 0 {
					return i
				}
			}
			i++
		}
		return i
	}
	params := func(fn *jsFunc, open int) int {
		closeAt := match(t, open)
		for j := open + 1; j < closeAt; j++ {
			if t[j].k == tIdent && (is(j+1, ":") || is(j+1, "?")) && (is(j-1, "(") || is(j-1, ",") || (t[j-1].k == tIdent && jsModifiers[t[j-1].v])) {
				k := j + 2
				if is(j+1, "?") {
					k = j + 3
				}
				if k < closeAt && t[k].k == tIdent {
					fn.params[t[j].v] = t[k].v
					if fn.short == "constructor" && fn.class != nil && t[j-1].k == tIdent && jsModifiers[t[j-1].v] {
						fn.class.fields[t[j].v] = t[k].v
					}
				}
			}
		}
		return closeAt
	}
	// afterParams: from the ")" of a parameter list, find "{" (body) or "=>"; returns the index of that token.
	afterParams := func(closeAt int) int {
		j := closeAt + 1
		if is(j, ":") {
			j = skipType(j+1, "{", "=>", ";", ",")
		}
		return j
	}
	exprEnd := func(i int) int { // end of an expression body starting at i
		depth := 0
		startInd := t[i].ind
		for j := i; j < n; j++ {
			if t[j].k == tPunct {
				switch t[j].v {
				case "(", "[", "{":
					depth++
				case ")", "]", "}":
					depth--
					if depth < 0 {
						return j
					}
				case ",", ";":
					if depth == 0 {
						return j
					}
				}
			}
			if depth == 0 && j > i && t[j].nl && t[j].ind <= startInd && !(t[j].k == tPunct && (t[j].v == "." || t[j].v == "?" || t[j].v == ":")) && !(t[j-1].k == tPunct && t[j-1].v != ")" && t[j-1].v != "]" && t[j-1].v != "}") {
				return j
			}
		}
		return n
	}
	objName := func(open int) string {
		j := open - 1
		if is(j, "(") || is(j, ",") {
			// argument of a call: name it after the callee
			depth := 0
			for k := j; k >= 0; k-- {
				if t[k].k == tPunct {
					if t[k].v == ")" {
						depth++
					} else if t[k].v == "(" {
						if depth == 0 {
							if k > 0 && t[k-1].k == tIdent {
								ch := chainBefore(t, k-1)
								nm := ch[len(ch)-1]
								return nm + "({…})"
							}
							return "{}"
						}
						depth--
					}
				}
			}
		}
		if is(j, "=") || is(j, ":") {
			if j > 0 && t[j-1].k == tIdent {
				return t[j-1].v
			}
		}
		if id(j, "default") {
			return "default"
		}
		return "{}"
	}

	for i := 0; i < n; i++ {
		tk := t[i]
		f.owner[i] = cur()
		if tk.k == tIdent {
			switch {
			case tk.v == "class" && !is(i-1, "."):
				c := &jsClass{methods: map[string]*jsFunc{}, fields: map[string]string{}, file: f, line: tk.line}
				j := i + 1
				if j < n && t[j].k == tIdent && t[j].v != "extends" && t[j].v != "implements" {
					c.name = t[j].v
					f.declTok[j] = true
					j++
				}
				for j < n && !is(j, "{") {
					if id(j, "extends") && j+1 < n && t[j+1].k == tIdent {
						c.extends = t[j+1].v
						for k := j + 2; k+1 < n && is(k, "."); k += 2 {
							c.extends = t[k+1].v
						}
					}
					if id(j, "implements") {
						for k := j + 1; k < n && !is(k, "{"); k++ {
							if t[k].k == tIdent && !is(k-1, ".") && !is(k-1, "<") {
								c.implements = append(c.implements, t[k].v)
							}
						}
					}
					j++
				}
				if c.name == "" {
					c.name = "default"
				}
				if inFunc() {
					c.name = "‹local›" + c.name
				}
				if f.classes[c.name] == nil {
					f.classes[c.name] = c
				}
				pendingClass = c
				continue
			case tk.v == "interface" && i+1 < n && t[i+1].k == tIdent && (i == 0 || t[i].nl || id(i-1, "export") || id(i-1, "declare")):
				c := &jsClass{name: t[i+1].v, iface: true, methods: map[string]*jsFunc{}, fields: map[string]string{}, file: f, line: tk.line}
				f.declTok[i+1] = true
				if f.classes[c.name] == nil {
					f.classes[c.name] = c
				}
				pendingClass = c
				continue
			case tk.v == "function" && !is(i-1, "."):
				j := i + 1
				if is(j, "*") {
					j++
				}
				name := ""
				if j < n && t[j].k == tIdent {
					name = t[j].v
					f.declTok[j] = true
					j++
				}
				if is(j, "<") {
					j = match(t, j) + 1
				}
				if !is(j, "(") {
					continue
				}
				anon := name == ""
				// obj.name = function [inner](…) / X.prototype.name = function (…) / exports.name = function
				if owner, mname, ok := memberAssign(t, i); ok && !inFunc() {
					fn := newFn(owner+"."+mname, mname, nil, i)
					fn.objOwner = owner
					if f.owned[owner] == nil {
						f.owned[owner] = map[string]*jsFunc{}
					}
					f.owned[owner][mname] = fn
					f.objFuncs[mname] = append(f.objFuncs[mname], fn)
					if owner == "exports" || owner == "module.exports" {
						f.top[mname] = fn
						f.exports[mname] = mname
					}
					closeAt := params(fn, j)
					if k := afterParams(closeAt); is(k, "{") {
						pendingFn = fn
					}
					for x := i; x <= closeAt && x < n; x++ {
						f.owner[x] = cur()
					}
					i = closeAt
					continue
				}
				if anon {
					// const x = function (…), key: function (…), export default function (…)
					if is(i-1, "=") || is(i-1, ":") {
						if i >= 2 && t[i-2].k == tIdent {
							name = t[i-2].v
							anon = inFunc() && is(i-1, "=")
						}
					} else if id(i-1, "default") {
						name, anon = "default", false
					} else if id(i-1, "async") && (is(i-2, "=") || is(i-2, ":")) && i >= 3 && t[i-3].k == tIdent {
						name = t[i-3].v
						anon = inFunc() && is(i-2, "=")
					}
				}
				if !anon && (inFunc() && !is(i-1, ":")) {
					// a named inner function declaration still deserves a node; inner function expressions don't
					anon = name == ""
				}
				var fn *jsFunc
				if !anon && name != "" {
					display := name
					if top() == 'o' {
						display = stack[len(stack)-1].obj + "." + name
					}
					fn = newFn(display, name, nil, i)
					if !inFunc() && top() != 'o' {
						f.top[name] = fn
					}
					if top() == 'o' {
						f.objFuncs[name] = append(f.objFuncs[name], fn)
					}
				} else {
					fn = &jsFunc{params: map[string]string{}, locals: map[string]string{}, file: f}
				}
				closeAt := params(fn, j)
				k := afterParams(closeAt)
				if is(k, "{") {
					if fn.declTok == 0 && fn.node == nil && fn.name == "" {
						pendingAnon = true
						pendingFn = fn
						if r := routeOf(routeAt, t, i); r != "" {
							fn.name, fn.route = "‹"+r+"›", r
							fn.short, fn.declTok, fn.line = fn.name, i, t[i].line
							f.funcs = append(f.funcs, fn)
							pendingAnon = false
						}
					} else {
						pendingFn = fn
					}
				}
				i = closeAt
				for x := j; x <= closeAt && x < n; x++ {
					f.owner[x] = cur()
				}
				continue
			}
			// class / interface members
			if (top() == 'c' || top() == 'i') && (is(i-1, "{") || is(i-1, ";") || is(i-1, "}") || t[i].nl) && !jsModifiers[tk.v] || (top() == 'c' || top() == 'i') && jsModifiers[tk.v] && (t[i].nl || is(i-1, "{") || is(i-1, ";") || is(i-1, "}")) {
				j := i
				for j < n && t[j].k == tIdent && jsModifiers[t[j].v] && j+1 < n && (t[j+1].k == tIdent || is(j+1, "*") || is(j+1, "[") || is(j+1, "#")) {
					j++
				}
				if is(j, "*") || is(j, "#") {
					j++
				}
				if j >= n || t[j].k != tIdent {
					continue
				}
				c := stack[len(stack)-1].class
				name := t[j].v
				k := j + 1
				if is(k, "?") || is(k, "!") {
					k++
				}
				if is(k, "<") {
					k = match(t, k) + 1
				}
				switch {
				case is(k, "("):
					fn := newFn(c.name+"."+name, name, c, j)
					if c.iface {
						fn.end = t[j].line
					}
					if c.methods[name] == nil {
						c.methods[name] = fn
					}
					closeAt := params(fn, k)
					a := afterParams(closeAt)
					for x := i; x <= closeAt && x < n; x++ {
						f.owner[x] = cur()
					}
					if is(a, "{") && !c.iface {
						pendingFn = fn
						i = a - 1
					} else {
						i = closeAt
					}
					continue
				case is(k, ":") && !c.iface || is(k, ":") && c.iface:
					// typed field: name: Type   (arrow-typed members of interfaces become methods)
					if c.iface && (is(k+1, "(") || (k+1 < n && t[k+1].k == tIdent && is(k+2, "=>"))) {
						fn := newFn(c.name+"."+name, name, c, j)
						fn.end = t[j].line
						if c.methods[name] == nil {
							c.methods[name] = fn
						}
					} else if k+1 < n && t[k+1].k == tIdent {
						c.fields[name] = typeName(t, k+1)
					}
					i = k
					continue
				case is(k, "="):
					// name = new T(…) / name = (…) => …
					v := k + 1
					if id(v, "new") && v+1 < n && t[v+1].k == tIdent {
						c.fields[name] = t[v+1].v
					}
					if fnStart, ok := arrowAt(t, v); ok {
						fn := newFn(c.name+"."+name, name, c, j)
						c.methods[name] = fn
						arrow := fnStart
						if is(v, "(") || id(v, "async") && is(v+1, "(") {
							pp := v
							if id(v, "async") {
								pp = v + 1
							}
							params(fn, pp)
						}
						if is(arrow+1, "{") {
							pendingFn = fn
							i = arrow
						} else {
							end := exprEnd(arrow + 1)
							spans = append(spans, span{arrow + 1, end, fn})
							fn.bodyStart, fn.bodyEnd, fn.end = arrow+1, end, t[min(end, n-1)].line
							i = arrow
						}
						continue
					}
				}
			}
			// object literal members: name(…) { … } / name: (…) => … / name: function
			if top() == 'o' && (is(i-1, "{") || is(i-1, ",")) {
				j := i
				for j < n && t[j].k == tIdent && (t[j].v == "async" || t[j].v == "get" || t[j].v == "set") && j+1 < n && t[j+1].k == tIdent {
					j++
				}
				if j < n && t[j].k == tIdent && is(j+1, "(") {
					obj := stack[len(stack)-1].obj
					fn := newFn(obj+"."+t[j].v, t[j].v, nil, j)
					f.objFuncs[t[j].v] = append(f.objFuncs[t[j].v], fn)
					closeAt := params(fn, j+1)
					a := afterParams(closeAt)
					if is(a, "{") {
						pendingFn = fn
						for x := i; x < a; x++ {
							f.owner[x] = cur()
						}
						i = a - 1
						continue
					}
				}
				if j < n && t[j].k == tIdent && is(j+1, ":") {
					if fnStart, ok := arrowAt(t, j+2); ok {
						obj := stack[len(stack)-1].obj
						fn := newFn(obj+"."+t[j].v, t[j].v, nil, j)
						f.objFuncs[t[j].v] = append(f.objFuncs[t[j].v], fn)
						if is(j+2, "(") {
							params(fn, j+2)
						}
						if is(fnStart+1, "{") {
							pendingFn = fn
							i = fnStart
						} else {
							end := exprEnd(fnStart + 1)
							spans = append(spans, span{fnStart + 1, end, fn})
							fn.bodyStart, fn.bodyEnd, fn.end = fnStart+1, end, t[min(end, n-1)].line
							i = fnStart
						}
						continue
					}
				}
			}
			// const name = (…) => … / const name = async x => …  (module level, or any depth for typed locals)
			if (tk.v == "const" || tk.v == "let" || tk.v == "var") && i+2 < n && t[i+1].k == tIdent {
				name := t[i+1].v
				k := i + 2
				ty := ""
				if is(k, ":") {
					ty = typeName(t, k+1)
					k = skipType(k+1, "=", ";", ",")
				}
				if is(k, "=") {
					if id(k+1, "new") && k+2 < n && t[k+2].k == tIdent {
						ty = t[k+2].v
					}
					if fnStart, ok := arrowAt(t, k+1); ok && !inFunc() {
						fn := newFn(name, name, nil, i+1)
						f.top[name] = fn
						if is(k+1, "(") || id(k+1, "async") && is(k+2, "(") {
							pp := k + 1
							if id(k+1, "async") {
								pp = k + 2
							}
							params(fn, pp)
						}
						if is(fnStart+1, "{") {
							pendingFn = fn
							i = fnStart
						} else {
							end := exprEnd(fnStart + 1)
							spans = append(spans, span{fnStart + 1, end, fn})
							fn.bodyStart, fn.bodyEnd, fn.end = fnStart+1, end, t[min(end, n-1)].line
							i = fnStart
						}
						continue
					}
				}
				if ty != "" {
					if fn := cur(); fn != nil {
						fn.locals[name] = ty
					} else {
						f.top["\x00var:"+name] = &jsFunc{short: ty}
					}
				}
				f.declTok[i+1] = true
			}
			// this.field = new T(…)
			if tk.v == "this" && is(i+1, ".") && i+4 < n && t[i+2].k == tIdent && is(i+3, "=") && id(i+4, "new") && i+5 < n && t[i+5].k == tIdent {
				if fn := cur(); fn != nil && fn.class != nil {
					if _, ok := fn.class.fields[t[i+2].v]; !ok {
						fn.class.fields[t[i+2].v] = t[i+5].v
					}
				}
			}
			// route registration app.get('/x', …): remember the call so an inline handler can be named after it
			if is(i-1, ".") && is(i+1, "(") && i+2 < n && t[i+2].k == tString && strings.HasPrefix(t[i+2].v, "/") {
				if m, ok := jsRouteMethods[t[i].v]; ok && len(argSpans(t, i+1)) >= 2 {
					routeAt[i+1] = strings.TrimSpace(m + " " + t[i+2].v)
				}
			}
			continue
		}
		if tk.k != tPunct {
			continue
		}
		switch tk.v {
		case "=>":
			// anonymous arrows inside functions: attribute to the enclosing function; route handlers get a node
			if is(i+1, "{") && pendingFn == nil {
				fn := &jsFunc{params: map[string]string{}, locals: map[string]string{}, file: f}
				if r := routeOf(routeAt, t, i); r != "" {
					fn.name, fn.short, fn.route, fn.declTok, fn.line = "‹"+r+"›", "‹"+r+"›", r, i, t[i].line
					f.funcs = append(f.funcs, fn)
				} else {
					pendingAnon = true
				}
				pendingFn = fn
			} else if !is(i+1, "{") {
				if r := routeOf(routeAt, t, i); r != "" {
					fn := &jsFunc{name: "‹" + r + "›", short: "‹" + r + "›", route: r, declTok: i, line: t[i].line, params: map[string]string{}, locals: map[string]string{}, file: f}
					f.funcs = append(f.funcs, fn)
					end := exprEnd(i + 1)
					spans = append(spans, span{i + 1, end, fn})
					fn.bodyStart, fn.bodyEnd, fn.end = i+1, end, t[min(end, n-1)].line
				}
			}
		case "{":
			ctx := jsCtx{kind: 'b', open: i}
			switch {
			case pendingClass != nil:
				ctx.kind, ctx.class = 'c', pendingClass
				if pendingClass.iface {
					ctx.kind = 'i'
				}
				pendingClass = nil
			case pendingFn != nil:
				ctx.kind = 'f'
				if !pendingAnon {
					ctx.fn = pendingFn
					pendingFn.bodyStart = i + 1
				}
				pendingFn, pendingAnon = nil, false
			case is(i-1, "=") || is(i-1, "(") || is(i-1, ",") || is(i-1, ":") || is(i-1, "[") || is(i-1, "?") || id(i-1, "return") ||
				is(i-1, "||") || is(i-1, "&&") || is(i-1, "??") || id(i-1, "default") || is(i-1, "|") || is(i-1, "&"):
				ctx.kind, ctx.obj = 'o', objName(i)
			}
			stack = append(stack, ctx)
		case "}":
			if len(stack) > 0 {
				c := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				if c.fn != nil {
					c.fn.bodyEnd, c.fn.end = i, tk.line
				}
				if c.class != nil {
					c.class.end = tk.line
				}
			}
		case ";":
			pendingFn, pendingAnon = nil, false
		}
	}
	for _, s := range spans {
		for k := s.from; k < s.to && k < n; k++ {
			if f.owner[k] == nil || f.owner[k] == s.fn || f.owner[k].bodyStart <= s.from {
				f.owner[k] = s.fn
			}
		}
	}
}

var jsRouteMethods = map[string]string{"get": "GET", "post": "POST", "put": "PUT", "delete": "DELETE", "patch": "PATCH", "all": "", "options": "OPTIONS", "head": "HEAD"}

// routeOf: is the function starting at i the last argument of a route registration?
func routeOf(routeAt map[int]string, t []tok, i int) string {
	if len(routeAt) == 0 {
		return ""
	}
	depth := 0
	for k := i - 1; k >= 0 && i-k < 400; k-- {
		if t[k].k != tPunct {
			continue
		}
		switch t[k].v {
		case ")", "]", "}":
			depth++
		case "[", "{":
			depth--
		case "(":
			if depth == 0 {
				if r, ok := routeAt[k]; ok {
					spans := argSpans(t, k)
					if last := spans[len(spans)-1]; i >= last[0] {
						return r
					}
				}
				return ""
			}
			depth--
		}
		if depth < 0 {
			return ""
		}
	}
	return ""
}

// arrowAt: does an arrow function start at token i ("(…) =>", "x =>", "async (…) =>")? Returns the "=>" index.
func arrowAt(t []tok, i int) (int, bool) {
	n := len(t)
	if i < n && t[i].k == tIdent && t[i].v == "async" {
		i++
	}
	if i < n && t[i].k == tIdent && i+1 < n && t[i+1].k == tPunct && t[i+1].v == "=>" {
		return i + 1, true
	}
	if i < n && t[i].k == tPunct && t[i].v == "<" { // generic arrow <T>(…) =>
		i = match(t, i) + 1
	}
	if i < n && t[i].k == tPunct && t[i].v == "(" {
		c := match(t, i)
		j := c + 1
		if j < n && t[j].k == tPunct && t[j].v == ":" {
			// return type
			depth := 0
			for j++; j < n; j++ {
				if t[j].k != tPunct {
					continue
				}
				if t[j].v == "=>" && depth == 0 {
					break
				}
				switch t[j].v {
				case "(", "[", "<", "{":
					depth++
				case ")", "]", ">", "}":
					depth--
				case ";", ",":
					if depth == 0 {
						return 0, false
					}
				}
			}
		}
		if j < n && t[j].k == tPunct && t[j].v == "=>" {
			return j, true
		}
	}
	return 0, false
}

// typeName reads a type reference starting at i: Foo, Foo<Bar>, ns.Foo, Foo | null → "Foo".
func typeName(t []tok, i int) string {
	for i < len(t) && t[i].k == tIdent && (t[i].v == "null" || t[i].v == "undefined" || t[i].v == "readonly") {
		i += 2
	}
	if i >= len(t) || t[i].k != tIdent {
		return ""
	}
	name := t[i].v
	for i+2 < len(t) && t[i+1].k == tPunct && t[i+1].v == "." && t[i+2].k == tIdent {
		name = t[i+2].v
		i += 2
	}
	return name
}

// ---------------------------------------------------------------- pass 2: imports and exports

var cjsRequire = regexp.MustCompile(`^require$`)

func (b *builder) parseModules(f *jsFile, res *resolver) {
	t := f.toks
	n := len(t)
	is := func(i int, v string) bool { return i >= 0 && i < n && t[i].k == tPunct && t[i].v == v }
	id := func(i int, v string) bool { return i >= 0 && i < n && t[i].k == tIdent && t[i].v == v }
	bind := func(spec string) jsBind {
		if p, ok := res.file(f.path, f.lang, spec); ok {
			f.imports[p] = true
			return jsBind{file: p, mod: spec}
		}
		return jsBind{mod: spec}
	}
	for i := 0; i < n; i++ {
		if t[i].k != tIdent {
			continue
		}
		switch {
		case t[i].v == "import" && (t[i].nl || i == 0) && !is(i+1, "(") && !is(i+1, "."):
			// collect up to the module string
			j := i + 1
			end := j
			for end < n && t[end].k != tString {
				end++
			}
			if end >= n {
				continue
			}
			bd := bind(t[end].v)
			if id(j, "type") && !is(j+1, ",") && !id(j+1, "from") {
				j++
			}
			for j < end {
				switch {
				case t[j].k == tIdent && t[j].v != "from" && !is(j-1, "{") && !is(j-1, ",") || t[j].k == tIdent && is(j-1, ",") && !inBraces(t, i, j):
					if t[j].v != "type" && t[j].v != "from" {
						x := bd
						x.name = "default"
						f.binds[t[j].v] = x
					}
					j++
				case is(j, "*") && id(j+1, "as") && j+2 < n:
					x := bd
					x.name = "*"
					f.binds[t[j+2].v] = x
					j += 3
				case is(j, "{"):
					c := match(t, j)
					for k := j + 1; k < c; k++ {
						if t[k].k != tIdent || t[k].v == "type" && t[k+1].k == tIdent {
							continue
						}
						if is(k-1, "{") || is(k-1, ",") || id(k-1, "type") {
							local := t[k].v
							if id(k+1, "as") && k+2 < c {
								local = t[k+2].v
							}
							x := bd
							x.name = t[k].v
							f.binds[local] = x
						}
					}
					j = c + 1
				default:
					j++
				}
			}
			i = end
		case (t[i].v == "const" || t[i].v == "let" || t[i].v == "var") && i+4 < n:
			// const x = require('m') / const { a, b: c } = require('m')
			j := i + 1
			if t[j].k == tIdent && is(j+1, "=") && id(j+2, "require") && is(j+3, "(") && t[j+4].k == tString {
				x := bind(t[j+4].v)
				x.name = "*"
				f.binds[t[j].v] = x
			} else if is(j, "{") {
				c := match(t, j)
				if is(c+1, "=") && id(c+2, "require") && is(c+3, "(") && c+4 < n && t[c+4].k == tString {
					bd := bind(t[c+4].v)
					for k := j + 1; k < c; k++ {
						if t[k].k == tIdent && (is(k-1, "{") || is(k-1, ",")) {
							local := t[k].v
							if is(k+1, ":") && k+2 < c && t[k+2].k == tIdent {
								local = t[k+2].v
							}
							x := bd
							x.name = t[k].v
							f.binds[local] = x
						}
					}
				}
			}
		case t[i].v == "module" && is(i+1, ".") && id(i+2, "exports") && is(i+3, "=") && i+4 < n && t[i+4].k == tIdent && (t[i].nl || i == 0):
			if t[i+4].v != "function" && t[i+4].v != "class" && t[i+4].v != "require" {
				f.exports["default"] = t[i+4].v
			}
		case t[i].v == "export":
			j := i + 1
			if id(j, "default") {
				k := j + 1
				for k < n && t[k].k == tIdent && (t[k].v == "async" || t[k].v == "abstract") {
					k++
				}
				if id(k, "function") || id(k, "class") {
					if k+1 < n && t[k+1].k == tIdent {
						f.exports["default"] = t[k+1].v
					} else {
						f.exports["default"] = "default"
					}
				} else if k < n && t[k].k == tIdent {
					f.exports["default"] = t[k].v
				}
				continue
			}
			for j < n && t[j].k == tIdent && (t[j].v == "declare" || t[j].v == "async" || t[j].v == "abstract" || t[j].v == "const" && id(j+1, "enum")) {
				j++
			}
			if j+1 < n && t[j].k == tIdent && (t[j].v == "function" || t[j].v == "class" || t[j].v == "const" || t[j].v == "let" ||
				t[j].v == "var" || t[j].v == "interface" || t[j].v == "type" || t[j].v == "enum") {
				k := j + 1
				if is(k, "*") {
					k++
				}
				if k < n && t[k].k == tIdent {
					f.exports[t[k].v] = t[k].v
				}
				continue
			}
			if is(j, "*") {
				k := j + 1
				for k < n && t[k].k != tString && !is(k, ";") {
					k++
				}
				if k < n && t[k].k == tString {
					if p, ok := res.file(f.path, f.lang, t[k].v); ok {
						f.starFrom = append(f.starFrom, p)
					}
				}
				continue
			}
			if is(j, "{") {
				c := match(t, j)
				from := ""
				if id(c+1, "from") && c+2 < n && t[c+2].k == tString {
					from = t[c+2].v
				}
				for k := j + 1; k < c; k++ {
					if t[k].k != tIdent || !(is(k-1, "{") || is(k-1, ",") || id(k-1, "type")) || t[k].v == "type" && t[k+1].k == tIdent {
						continue
					}
					local, exported := t[k].v, t[k].v
					if id(k+1, "as") && k+2 < c {
						exported = t[k+2].v
					}
					if from != "" {
						x := bind(from)
						x.name = local
						f.reexports[exported] = x
					} else {
						f.exports[exported] = local
					}
				}
			}
		}
	}
}

func inBraces(t []tok, from, j int) bool {
	depth := 0
	for k := from; k < j; k++ {
		if t[k].k == tPunct {
			if t[k].v == "{" {
				depth++
			} else if t[k].v == "}" {
				depth--
			}
		}
	}
	return depth > 0
}

// ---------------------------------------------------------------- pass 3: calls and the outside world

type jsWorld struct {
	b        *builder
	files    map[string]*jsFile
	byName   map[string][]*jsFunc // bare name → functions and methods (for name fallback)
	classes  map[string][]*jsClass
	wrappers map[*jsFunc]bool
}

func (b *builder) analyzeScript(files []File, res *resolver) {
	w := &jsWorld{b: b, files: map[string]*jsFile{}, byName: map[string][]*jsFunc{}, classes: map[string][]*jsClass{}, wrappers: map[*jsFunc]bool{}}
	var order []*jsFile
	for _, f := range files {
		if len(f.Content) > 1<<20 || strings.HasSuffix(f.Path, ".min.js") || strings.HasSuffix(f.Path, ".d.ts") {
			continue
		}
		jf := &jsFile{path: f.Path, lang: f.Lang, toks: lexC(f.Content, false), classes: map[string]*jsClass{}, top: map[string]*jsFunc{},
			binds: map[string]jsBind{}, exports: map[string]string{}, reexports: map[string]jsBind{}, imports: map[string]bool{}, objFuncs: map[string][]*jsFunc{},
			owned: map[string]map[string]*jsFunc{}}
		b.parseScript(jf)
		b.parseModules(jf, res)
		w.files[f.Path] = jf
		order = append(order, jf)
	}
	// nodes
	for _, f := range order {
		test := scan.IsTestPath(f.path)
		for _, c := range f.classes {
			sub := "class"
			if c.iface {
				sub = "interface"
			}
			c.node = b.node("js:"+f.path+":"+c.name, Node{Kind: KClass, Sub: sub, Name: c.name, Path: f.path, Start: c.line, End: max(c.end, c.line),
				Lang: f.lang, Exported: f.exports[c.name] != "" || f.exports["default"] == c.name, Test: test})
			w.classes[c.name] = append(w.classes[c.name], c)
		}
		for _, fn := range f.funcs {
			if fn.name == "" {
				continue
			}
			kind, parent, sub := KFunc, -1, ""
			if fn.class != nil && fn.class.node != nil {
				kind, parent = KMethod, fn.class.node.ID
				if fn.class.iface {
					sub = "abstract"
				}
			} else if strings.Contains(fn.name, ".") {
				kind = KMethod
			}
			if fn.route != "" {
				sub = "closure"
			}
			end := max(fn.end, fn.line)
			fn.node = b.node("js:"+f.path+":"+fn.name+":"+itoa(fn.line), Node{Kind: kind, Sub: sub, Name: fn.name, Path: f.path, Start: fn.line, End: end,
				Parent: parent, Lang: f.lang, Exported: f.exports[fn.short] != "" || f.exports["default"] == fn.short, Test: test})
			if fn.short != "" && !strings.HasPrefix(fn.short, "‹") {
				w.byName[fn.short] = append(w.byName[fn.short], fn)
			}
		}
	}
	// request wrappers: functions that call fetch / axios with a parameter
	for _, f := range order {
		for i, tk := range f.toks {
			if tk.k == tIdent && (tk.v == "fetch" || tk.v == "axios") && i+1 < len(f.toks) && f.toks[i+1].k == tPunct && f.toks[i+1].v == "(" {
				if fn := f.owner[i]; fn != nil && fn.node != nil {
					fn.fetches = true
				}
			}
		}
	}
	for _, f := range order {
		w.scan(f)
	}
	// interface methods → implementations (classes that implement the interface; object literals in importing files, by name)
	for _, f := range order {
		for _, c := range f.classes {
			for _, ifName := range c.implements {
				if ic := w.classFor(f, ifName); ic != nil && ic.iface {
					for name, m := range ic.methods {
						if impl := w.method(c, name, 0); impl != nil && m.node != nil {
							b.edge(m.node, impl.node, EImpl, "", 0, true)
						}
					}
				}
			}
		}
	}
	for _, f := range order {
		for _, c := range f.classes {
			if !c.iface {
				continue
			}
			for name, m := range c.methods {
				for _, of := range order {
					if !of.imports[f.path] && of != f {
						continue
					}
					for _, impl := range of.objFuncs[name] {
						if impl.node != nil && m.node != nil {
							b.edge(m.node, impl.node, EImpl, "", 0, false)
						}
					}
				}
			}
		}
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var d []byte
	neg := i < 0
	if neg {
		i = -i
	}
	for i > 0 {
		d = append([]byte{byte('0' + i%10)}, d...)
		i /= 10
	}
	if neg {
		d = append([]byte{'-'}, d...)
	}
	return string(d)
}

// export finds what file f exports under name (following re-exports).
func (w *jsWorld) export(f *jsFile, name string, depth int) (*jsFunc, *jsClass) {
	if f == nil || depth > 6 {
		return nil, nil
	}
	if local, ok := f.exports[name]; ok {
		if fn := f.top[local]; fn != nil {
			return fn, nil
		}
		if c := f.classes[local]; c != nil {
			return nil, c
		}
		if bd, ok := f.binds[local]; ok && bd.file != "" { // import { x } … export { x }
			return w.export(w.files[bd.file], bd.name, depth+1)
		}
	}
	if bd, ok := f.reexports[name]; ok && bd.file != "" {
		return w.export(w.files[bd.file], bd.name, depth+1)
	}
	// module.exports = app; app.handle = function …  →  require('./x').handle
	if def, ok := f.exports["default"]; ok && f.owned[def] != nil {
		if m := f.owned[def][name]; m != nil {
			return m, nil
		}
	}
	for _, p := range f.starFrom {
		if fn, c := w.export(w.files[p], name, depth+1); fn != nil || c != nil {
			return fn, c
		}
	}
	return nil, nil
}

// classFor resolves a class / interface name as seen from file f.
func (w *jsWorld) classFor(f *jsFile, name string) *jsClass {
	if name == "" {
		return nil
	}
	if c := f.classes[name]; c != nil {
		return c
	}
	if bd, ok := f.binds[name]; ok && bd.file != "" {
		if _, c := w.export(w.files[bd.file], bd.name, 0); c != nil {
			return c
		}
		if bd.name == "default" {
			if _, c := w.export(w.files[bd.file], "default", 0); c != nil {
				return c
			}
		}
	}
	return nil
}

// method finds a method on a class or its ancestors.
func (w *jsWorld) method(c *jsClass, name string, depth int) *jsFunc {
	if c == nil || depth > 8 {
		return nil
	}
	if m := c.methods[name]; m != nil {
		return m
	}
	return w.method(w.classFor(c.file, c.extends), name, depth+1)
}

// typeOf: the declared type of an identifier inside fn (params, locals, module-level typed vars).
func (w *jsWorld) typeOf(f *jsFile, fn *jsFunc, name string) *jsClass {
	if fn != nil {
		if ty := fn.params[name]; ty != "" {
			return w.classFor(f, ty)
		}
		if ty := fn.locals[name]; ty != "" {
			return w.classFor(f, ty)
		}
	}
	if v := f.top["\x00var:"+name]; v != nil {
		return w.classFor(f, v.short)
	}
	return nil
}

func (w *jsWorld) moduleNode(f *jsFile) *Node {
	if f.module == nil {
		f.module = w.b.node("js:"+f.path+":‹top level›", Node{Kind: KFunc, Sub: "module", Name: path.Base(f.path) + " (top level)", Path: f.path,
			Start: 1, End: f.toks[len(f.toks)-1].line, Lang: f.lang, Entry: "module", Test: scan.IsTestPath(f.path)})
	}
	return f.module
}

func (w *jsWorld) scope(f *jsFile, i int) (*jsFunc, *Node) {
	fn := f.owner[i]
	if fn != nil && fn.node != nil {
		return fn, fn.node
	}
	if fn != nil { // anonymous function: look outwards
		return fn, w.moduleNode(f)
	}
	return nil, w.moduleNode(f)
}

// resolve: a call chain at token i in file f → target function (exact) or by name.
func (w *jsWorld) resolve(f *jsFile, fn *jsFunc, chain []string) (target *jsFunc, cls *jsClass, exact bool) {
	name := chain[len(chain)-1]
	switch len(chain) {
	case 1:
		if t := f.top[name]; t != nil {
			return t, nil, true
		}
		if c := f.classes[name]; c != nil && !c.iface {
			return nil, c, true
		}
		if bd, ok := f.binds[name]; ok && bd.file != "" {
			t, c := w.export(w.files[bd.file], bd.name, 0)
			if bd.name == "default" && t == nil && c == nil {
				t, c = w.export(w.files[bd.file], "default", 0)
			}
			return t, c, t != nil || c != nil
		}
	default:
		base := chain[len(chain)-2]
		if len(chain) == 2 && base == "this" && fn != nil && fn.class != nil {
			if m := w.method(fn.class, name, 0); m != nil {
				return m, nil, true
			}
		}
		if len(chain) == 2 && base == "this" && fn != nil && fn.objOwner != "" {
			if m := f.owned[fn.objOwner][name]; m != nil {
				return m, nil, true
			}
		}
		if owner := strings.Join(chain[:len(chain)-1], "."); f.owned[owner] != nil {
			if m := f.owned[owner][name]; m != nil {
				return m, nil, true
			}
		}
		// this.field.m()
		if len(chain) == 3 && chain[0] == "this" && fn != nil && fn.class != nil {
			if ty := fn.class.fields[base]; ty != "" {
				if c := w.classFor(f, ty); c != nil {
					if m := w.method(c, name, 0); m != nil {
						return m, nil, true
					}
				}
			}
		}
		if len(chain) == 2 {
			// namespace import: ns.f()
			if bd, ok := f.binds[base]; ok && bd.file != "" && bd.name == "*" {
				t, c := w.export(w.files[bd.file], name, 0)
				return t, c, t != nil || c != nil
			}
			// typed variable / parameter, or a class (static)
			if c := w.typeOf(f, fn, base); c != nil {
				if m := w.method(c, name, 0); m != nil {
					return m, nil, true
				}
			}
			if c := w.classFor(f, base); c != nil {
				if m := w.method(c, name, 0); m != nil {
					return m, nil, true
				}
			}
		}
	}
	// by name: unique, not a common built-in name, and in this file or one it imports
	if jsBuiltinNames[name] || len(name) < 3 || jsKeywords[name] {
		return nil, nil, false
	}
	var cand *jsFunc
	for _, x := range w.byName[name] {
		if x.file != f && !f.imports[x.file.path] {
			continue
		}
		if cand != nil {
			return nil, nil, false // ambiguous
		}
		cand = x
	}
	return cand, nil, false
}

var urlLike = regexp.MustCompile(`^(?:https?://[^\s]+|/[\w\-.~%{}:\x00]+(?:/[\w\-.~%{}:\x00]*)*)$`)

func (w *jsWorld) scan(f *jsFile) {
	t := f.toks
	n := len(t)
	b := w.b
	is := func(i int, v string) bool { return i >= 0 && i < n && t[i].k == tPunct && t[i].v == v }
	id := func(i int, v string) bool { return i >= 0 && i < n && t[i].k == tIdent && t[i].v == v }

	// route handlers declared inline
	for _, fn := range f.funcs {
		if fn.route != "" && fn.node != nil {
			m, p, _ := strings.Cut(fn.route, " ")
			if p == "" {
				m, p = "", fn.route
			}
			b.edge(b.endpoint(m, p), fn.node, EHandles, "", fn.line, true)
		}
	}
	// Next.js routes: pages/api/** (default export) and app/**/route.ts (GET, POST, …)
	if ep, ok := nextRoute(f.path); ok {
		if strings.Contains("/"+f.path, "/pages/api/") {
			if fn, _ := w.export(f, "default", 0); fn != nil && fn.node != nil {
				b.edge(b.endpoint("", ep), fn.node, EHandles, "", fn.line, true)
			}
		} else {
			for _, m := range []string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"} {
				if fn, _ := w.export(f, m, 0); fn != nil && fn.node != nil {
					b.edge(b.endpoint(m, ep), fn.node, EHandles, "", fn.line, true)
				}
			}
		}
	}

	callsIn := func(from, to int) []*Node {
		var out []*Node
		for k := from; k < to && k < n; k++ {
			if t[k].k == tIdent && (is(k+1, "(") || is(k+1, "<") && genericOK(t, k+1)) && !jsKeywords[t[k].v] && !f.declTok[k] {
				fn, _ := w.scope(f, k)
				if tg, c, _ := w.resolve(f, fn, chainBefore(t, k)); tg != nil && tg.node != nil {
					out = append(out, tg.node)
				} else if c != nil && c.node != nil {
					out = append(out, c.node)
				}
			}
		}
		return out
	}

	for i := 0; i < n; i++ {
		tk := t[i]
		if tk.k == tString {
			if !(i > 0 && t[i-1].k == tIdent && (t[i-1].v == "from" || t[i-1].v == "import" || t[i-1].v == "require")) {
				_, node := w.scope(f, i)
				b.sql(node, strings.ReplaceAll(tk.v, "\x00", "?"), tk.line)
			}
			continue
		}
		if tk.k != tIdent || f.declTok[i] {
			continue
		}
		fn, node := w.scope(f, i)
		line := tk.line
		// new X(…)
		if tk.v == "new" && i+1 < n && t[i+1].k == tIdent {
			j := i + 1
			for j+2 < n && is(j+1, ".") && t[j+2].k == tIdent {
				j += 2
			}
			cname := t[j].v
			switch cname {
			case "WebSocket", "EventSource":
				if is(j+1, "(") {
					if s, ok := firstString(t, j+1); ok {
						b.external(node, "network", hostOf(s), cname, line)
					} else {
						b.external(node, "network", cname, cname, line)
					}
				}
			case "Worker", "SharedWorker":
				b.external(node, "process", "web worker", "new "+cname, line)
			}
			if c := w.classFor(f, cname); c != nil && c.node != nil {
				b.edge(node, c.node, ENew, "", line, true)
				if ctor := c.methods["constructor"]; ctor != nil && ctor.node != nil {
					b.edge(node, ctor.node, ECall, "new", line, true)
				}
			}
			i = j
			continue
		}
		// process.env.X, process.argv, document.cookie
		if tk.v == "process" && is(i+1, ".") && i+2 < n {
			switch t[i+2].v {
			case "env":
				label := ""
				if is(i+3, ".") && i+4 < n {
					label = t[i+4].v
				}
				b.source(node, "env", "environment", label, line)
			case "argv":
				b.source(node, "args", "command-line arguments", "process.argv", line)
			case "stdin":
				b.source(node, "stdin", "stdin", "", line)
			}
		}
		if tk.v == "cookie" && is(i-1, ".") && id(i-2, "document") {
			if is(i+1, "=") {
				b.sink(node, "storage", "cookies", "document.cookie", line)
			} else {
				b.source(node, "storage", "cookies", "document.cookie", line)
			}
		}
		// el.onclick = …
		if strings.HasPrefix(tk.v, "on") && len(tk.v) > 3 && tk.v[2] >= 'a' && tk.v[2] <= 'z' && is(i-1, ".") && is(i+1, "=") {
			ev := w.event(tk.v[2:], eventTarget(t, i-1), fn, f)
			end := i + 2
			for end < n && !is(end, ";") && !(t[end].nl && end > i+2 && t[end].ind <= tk.ind) {
				if is(end, "{") || is(end, "(") {
					end = match(t, end)
				}
				end++
			}
			targets := callsIn(i+2, end)
			if len(targets) == 0 {
				targets = []*Node{node}
			}
			for _, x := range targets {
				w.handles(ev, x, f, line)
			}
			continue
		}
		p := i + 1 // the call's "(" (after generic arguments: f<T>(…))
		if is(p, "<") {
			if c, ok := genericCall(t, p); ok {
				p = c
			}
		}
		if !is(p, "(") || jsKeywords[tk.v] && tk.v != "import" {
			continue
		}
		chain := chainBefore(t, i)
		name := tk.v
		base := ""
		if len(chain) >= 2 {
			base = chain[len(chain)-2]
		}
		root := chain[0]
		// browser storage
		if (root == "localStorage" || root == "sessionStorage" || base == "localStorage" || base == "sessionStorage") && len(chain) >= 2 {
			key := ""
			if s, ok := firstString(t, p); ok {
				key = strings.ReplaceAll(s, "\x00", "*")
			}
			store := base
			if store != "localStorage" && store != "sessionStorage" {
				store = root
			}
			switch name {
			case "getItem", "key":
				b.source(node, "storage", store, strings.TrimSpace("getItem "+key), line)
			case "setItem", "removeItem", "clear":
				b.sink(node, "storage", store, strings.TrimSpace(name+" "+key), line)
			}
			continue
		}
		// console
		if root == "console" && len(chain) == 2 {
			b.sink(node, "log", "console", name, line)
			continue
		}
		// events and timers
		if name == "addEventListener" && len(chain) >= 2 {
			if typ, ok := firstString(t, p); ok {
				ev := w.event(typ, eventTarget(t, i-1), fn, f)
				spans := argSpans(t, p)
				var targets []*Node
				if len(spans) >= 2 {
					targets = callsIn(spans[1][0], spans[1][1])
					if len(targets) == 0 && spans[1][1]-spans[1][0] == 1 && t[spans[1][0]].k == tIdent {
						if tg, _, _ := w.resolve(f, fn, []string{t[spans[1][0]].v}); tg != nil && tg.node != nil {
							targets = append(targets, tg.node)
						}
					}
				}
				if len(targets) == 0 {
					targets = []*Node{node}
				}
				for _, x := range targets {
					w.handles(ev, x, f, line)
				}
			}
			continue
		}
		if (name == "requestAnimationFrame" || name == "setInterval") && len(chain) <= 2 {
			label := "animation frame"
			if name == "setInterval" {
				label = "interval timer"
			}
			ev := b.node("event:"+label, Node{Kind: KEvent, Sub: "timer", Name: label, Parent: -1})
			spans := argSpans(t, p)
			if len(spans) > 0 {
				targets := callsIn(spans[0][0], spans[0][1])
				if len(targets) == 0 && spans[0][1]-spans[0][0] == 1 && t[spans[0][0]].k == tIdent {
					if tg, _, _ := w.resolve(f, fn, []string{t[spans[0][0]].v}); tg != nil && tg.node != nil {
						targets = append(targets, tg.node)
					}
				}
				if len(targets) == 0 {
					targets = []*Node{node}
				}
				for _, x := range targets {
					w.handles(ev, x, f, line)
				}
			}
			continue
		}
		// HTTP requests: fetch(url), axios.get(url), wrappers around fetch
		target, cls, exact := w.resolve(f, fn, chain)
		isFetch := (len(chain) == 1 && (name == "fetch" || name == "axios")) || (root == "axios" && len(chain) == 2) ||
			(target != nil && target.fetches && target != fn)
		if isFetch {
			if u, ok := firstString(t, p); ok && urlLike.MatchString(strings.SplitN(u, "?", 2)[0]) {
				method := ""
				if root == "axios" && len(chain) == 2 {
					method = strings.ToUpper(name)
				}
				spans := argSpans(t, p)
				if len(spans) >= 2 {
					for k := spans[1][0]; k+2 < spans[1][1]; k++ {
						if id(k, "method") && is(k+1, ":") && t[k+2].k == tString {
							method = strings.ToUpper(t[k+2].v)
						}
					}
				}
				b.request(node, method, u, line, "")
			} else if target == nil {
				b.external(node, "http", "HTTP (dynamic URL)", "fetch", line)
			}
		}
		// Node.js modules
		if bd, ok := f.binds[root]; ok && bd.file == "" && len(chain) >= 2 {
			w.nodeIO(node, bd.mod, name, t, i, line)
		}
		if bd, ok := f.binds[name]; ok && bd.file == "" && len(chain) == 1 {
			w.nodeIO(node, bd.mod, bd.name, t, i, line)
		}
		// Prisma: prisma.user.findMany()
		if len(chain) == 3 && (root == "prisma" || root == "db") {
			op := name
			verb := "SELECT"
			if strings.HasPrefix(op, "create") || strings.HasPrefix(op, "update") || strings.HasPrefix(op, "upsert") || strings.HasPrefix(op, "delete") {
				verb = strings.ToUpper(strings.TrimSuffix(strings.TrimSuffix(op, "Many"), "Unique"))
			}
			if strings.HasPrefix(op, "find") || strings.HasPrefix(op, "count") || strings.HasPrefix(op, "aggregate") || verb != "SELECT" {
				b.external(node, "db", chain[1], verb, line)
			}
		}
		// .collection('users') (MongoDB)
		if name == "collection" && len(chain) >= 2 {
			if s, ok := firstString(t, p); ok {
				b.external(node, "db", s, "collection", line)
			}
		}
		// express-style routes registered with a handler reference
		if m, ok := jsRouteMethods[name]; ok && len(chain) == 2 {
			if s, ok := firstString(t, p); ok && strings.HasPrefix(s, "/") {
				spans := argSpans(t, p)
				if len(spans) >= 2 {
					last := spans[len(spans)-1]
					if last[1]-last[0] <= 3 && t[last[1]-1].k == tIdent {
						ch := chainBefore(t, last[1]-1)
						if h, _, _ := w.resolve(f, fn, ch); h != nil && h.node != nil {
							b.edge(b.endpoint(m, s), h.node, EHandles, "", line, true)
						}
					}
				}
			}
		}
		// calls into the code base
		if target != nil && target.node != nil && target.node != node {
			label := ""
			if len(chain) >= 2 && chain[0] == "this" && chain[1] != name {
				label = ""
			}
			b.edge(node, target.node, ECall, label, line, exact)
		} else if cls != nil && cls.node != nil {
			b.edge(node, cls.node, ECall, "", line, exact)
		}
		// callbacks: functions passed by name
		for _, sp := range argSpans(t, p) {
			if sp[1]-sp[0] == 1 && t[sp[0]].k == tIdent {
				if cb := f.top[t[sp[0]].v]; cb != nil && cb.node != nil && cb.node != node {
					b.edge(node, cb.node, ERef, "callback", line, true)
				}
			} else if sp[1]-sp[0] == 3 && id(sp[0], "this") && is(sp[0]+1, ".") && fn != nil && fn.class != nil {
				if cb := w.method(fn.class, t[sp[0]+2].v, 0); cb != nil && cb.node != nil && cb.node != node {
					b.edge(node, cb.node, ERef, "callback", line, true)
				}
			}
		}
	}
	// state writes / reads on class fields: this.x = …
	for i := 0; i+2 < n; i++ {
		if !id(i, "this") || !is(i+1, ".") || t[i+2].k != tIdent || is(i+3, "(") {
			continue
		}
		fn, node := w.scope(f, i)
		if fn == nil || fn.class == nil || fn.class.node == nil {
			continue
		}
		field := t[i+2].v
		if fn.class.methods[field] != nil {
			continue
		}
		dn := b.node("js:field:"+f.path+":"+fn.class.name+"."+field, Node{Kind: KData, Sub: "field", Name: fn.class.name + "." + field,
			Path: f.path, Start: fn.class.line, End: fn.class.line, Parent: fn.class.node.ID, Lang: f.lang})
		if dn == nil {
			continue
		}
		write := is(i+3, "=") || (i+4 < n && is(i+4, "=") && (is(i+3, "+") || is(i+3, "-") || is(i+3, "*") || is(i+3, "|") || is(i+3, "&") || is(i+3, "?"))) ||
			is(i+3, "+") && is(i+4, "+") || is(i+3, "-") && is(i+4, "-") || is(i+3, "[") && is(match(t, i+3)+1, "=") ||
			(is(i+3, ".") && i+5 < n && (t[i+4].v == "push" || t[i+4].v == "set" || t[i+4].v == "delete" || t[i+4].v == "clear" || t[i+4].v == "splice" || t[i+4].v == "add") && is(i+5, "("))
		if write {
			if fn.short != "constructor" {
				b.edge(node, dn, EWrites, "", t[i].line, true)
			}
		} else {
			b.edge(dn, node, EFeeds, "", t[i].line, true)
		}
	}
	// module-level state: let x … ; x = …
	lets := map[string]int{}
	depth := 0
	for i := 0; i+1 < n; i++ {
		if is(i, "{") {
			depth++
		} else if is(i, "}") {
			depth--
		}
		if depth == 0 && id(i, "let") && t[i+1].k == tIdent {
			lets[t[i+1].v] = t[i+1].line
		}
	}
	if len(lets) > 0 {
		for i := 0; i+1 < n; i++ {
			if t[i].k != tIdent || is(i-1, ".") {
				continue
			}
			ln, ok := lets[t[i].v]
			if !ok || f.declTok[i] || id(i-1, "let") {
				continue
			}
			fn, node := w.scope(f, i)
			if fn != nil && (fn.params[t[i].v] != "" || fn.locals[t[i].v] != "") {
				continue
			}
			dn := b.node("js:var:"+f.path+":"+t[i].v, Node{Kind: KData, Sub: "var", Name: t[i].v, Path: f.path, Start: ln, End: ln, Parent: -1, Lang: f.lang})
			if dn == nil {
				continue
			}
			if (is(i+1, "=") && !is(i+2, "=")) || is(i+1, "+") && is(i+2, "+") || is(i+1, "-") && is(i+2, "-") || (is(i+2, "=") && (is(i+1, "+") || is(i+1, "-") || is(i+1, "|") || is(i+1, "&") || is(i+1, "?"))) {
				b.edge(node, dn, EWrites, "", t[i].line, true)
			} else {
				b.edge(dn, node, EFeeds, "", t[i].line, true)
			}
		}
	}
}

var genericTargets = map[string]bool{"b": true, "e": true, "el": true, "elem": true, "element": true, "btn": true, "button": true, "input": true,
	"node": true, "item": true, "row": true, "x": true, "it": true, "o": true, "a": true, "li": true, "div": true, "span": true, "target": true,
	"sel": true, "select": true, "option": true, "label": true, "field": true, "child": true, "entry": true, "this": true, "self": true, "c": true, "t": true}

// event returns the node for a UI event; listeners on throwaway variables are named after where they are set up.
func (w *jsWorld) event(typ, target string, fn *jsFunc, f *jsFile) *Node {
	if genericTargets[target] || len(target) <= 2 {
		where := path.Base(f.path)
		if fn != nil && fn.node != nil {
			where = fn.node.Name
		}
		target = "in " + where
	}
	name := typ + " " + target
	return w.b.node("event:"+name, Node{Kind: KEvent, Sub: "dom", Name: name, Parent: -1})
}

func (w *jsWorld) handles(ev, to *Node, f *jsFile, line int) {
	if e := w.b.edge(ev, to, EHandles, "", line, true); e != nil {
		e.File = w.b.p(f.path)
	}
}

// eventTarget names the object an event listener is attached to: "#id", "window", "canvas", ….
func eventTarget(t []tok, dot int) string {
	ch := chainBefore(t, dot-1)
	if len(ch) >= 2 && ch[len(ch)-1] == "()" || dot >= 1 && t[dot-1].k == tPunct && t[dot-1].v == ")" {
		// document.getElementById('x').addEventListener / $('x')
		open := -1
		depth := 0
		for k := dot - 1; k >= 0; k-- {
			if t[k].k != tPunct {
				continue
			}
			if t[k].v == ")" {
				depth++
			} else if t[k].v == "(" {
				depth--
				if depth == 0 {
					open = k
					break
				}
			}
		}
		if open > 0 && open+1 < len(t) && t[open+1].k == tString {
			fnName := t[open-1].v
			s := t[open+1].v
			switch fnName {
			case "getElementById", "$":
				if !strings.HasPrefix(s, "#") && fnName == "getElementById" {
					s = "#" + s
				}
			}
			return s
		}
	}
	if dot >= 1 && t[dot-1].k == tIdent {
		return t[dot-1].v
	}
	return "element"
}

func hostOf(u string) string {
	_, h := normURL(u)
	if h != "" {
		return h
	}
	return firstSegments(strings.SplitN(u, "?", 2)[0], 2)
}

// nodeIO maps calls into Node.js / common npm modules to the outside world.
func (w *jsWorld) nodeIO(node *Node, mod, name string, t []tok, i, line int) {
	b := w.b
	mod = strings.TrimPrefix(mod, "node:")
	arg, _ := firstString(t, i+1)
	switch {
	case mod == "fs" || mod == "fs/promises" || mod == "fs-extra":
		switch {
		case strings.HasPrefix(name, "read") || strings.HasPrefix(name, "exists") || strings.HasPrefix(name, "stat") || name == "createReadStream" || name == "watch":
			b.source(node, "file", "files (read)", strings.TrimSpace(name+" "+arg), line)
		case strings.HasPrefix(name, "write") || strings.HasPrefix(name, "append") || strings.HasPrefix(name, "mkdir") || strings.HasPrefix(name, "rm") ||
			strings.HasPrefix(name, "unlink") || strings.HasPrefix(name, "rename") || strings.HasPrefix(name, "copy") || name == "createWriteStream" || name == "outputFile":
			b.sink(node, "file", "files (written)", strings.TrimSpace(name+" "+arg), line)
		}
	case mod == "child_process" || mod == "execa":
		cmd := "process"
		if arg != "" {
			cmd = strings.Fields(arg + " ")[0]
		}
		b.external(node, "process", path.Base(cmd), name, line)
	case mod == "axios" || mod == "node-fetch" || mod == "got" || mod == "superagent" || mod == "undici":
		if arg != "" {
			b.request(node, strings.ToUpper(name), arg, line, "")
		}
	case mod == "pg" || mod == "mysql" || mod == "mysql2" || mod == "sqlite3" || mod == "better-sqlite3" || mod == "mongodb" || mod == "mongoose" ||
		mod == "redis" || mod == "ioredis" || mod == "@prisma/client" || mod == "knex" || mod == "sequelize" || mod == "typeorm":
		b.external(node, "db", mod, name, line)
	}
}

// nextRoute derives an API route from a Next.js file path.
func nextRoute(p string) (string, bool) {
	q := "/" + p
	if i := strings.Index(q, "/pages/api/"); i >= 0 {
		r := q[i+len("/pages"):]
		r = strings.TrimSuffix(r[:len(r)-len(path.Ext(r))], "/index")
		return nextParams(r), true
	}
	if i := strings.Index(q, "/app/"); i >= 0 && strings.HasPrefix(path.Base(p), "route.") {
		r := path.Dir(q[i+len("/app"):])
		var parts []string
		for _, s := range strings.Split(r, "/") {
			if strings.HasPrefix(s, "(") && strings.HasSuffix(s, ")") {
				continue // route groups
			}
			parts = append(parts, s)
		}
		return nextParams(strings.Join(parts, "/")), true
	}
	return "", false
}

var nextParam = regexp.MustCompile(`\[(?:\.\.\.)?(\w+)\]`)

func nextParams(r string) string {
	if r == "" {
		return "/"
	}
	return nextParam.ReplaceAllString(r, "{$1}")
}

// genericCall: "<" at i opens type arguments of a call (f<T>(…))? Returns the index of the "(".
func genericCall(t []tok, i int) (int, bool) {
	depth := 0
	for j := i; j < len(t) && j-i < 40; j++ {
		x := t[j]
		if x.k == tPunct {
			switch x.v {
			case "<":
				depth++
			case ">":
				depth--
				if depth == 0 {
					if j+1 < len(t) && t[j+1].k == tPunct && t[j+1].v == "(" {
						return j + 1, true
					}
					return 0, false
				}
			case ".", ",", "[", "]", "|", "&", "{", "}", ":", "?", "(", ")", "=>":
			default:
				return 0, false
			}
		}
	}
	return 0, false
}

func genericOK(t []tok, i int) bool { _, ok := genericCall(t, i); return ok }

// memberAssign: is the "function" keyword at i the value of "a.b = function" / "a.prototype.b = function" /
// "module.exports.b = function"? Returns the owner object and the member name.
func memberAssign(t []tok, i int) (owner, name string, ok bool) {
	j := i - 1
	if j >= 0 && t[j].k == tIdent && t[j].v == "async" {
		j--
	}
	if j < 3 || t[j].k != tPunct || t[j].v != "=" || t[j-1].k != tIdent || t[j-2].k != tPunct || t[j-2].v != "." {
		return "", "", false
	}
	name = t[j-1].v
	ch := chainBefore(t, j-1)
	if len(ch) < 2 {
		return "", "", false
	}
	parts := ch[:len(ch)-1]
	if len(parts) >= 2 && parts[len(parts)-1] == "prototype" {
		parts = parts[:len(parts)-1]
	}
	for _, p := range parts {
		if p == "()" || p == "[]" || p == "\"\"" {
			return "", "", false
		}
	}
	owner = strings.Join(parts, ".")
	if owner == "this" || owner == "" {
		return "", "", false
	}
	return owner, name, true
}
