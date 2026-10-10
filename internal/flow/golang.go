package flow

import (
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------- modules and packages

type goModule struct{ dir, path string }

var goModLine = regexp.MustCompile(`(?m)^\s*module\s+("?)([^\s"]+)("?)`)

func goModules(files []File) []goModule {
	var mods []goModule
	for _, f := range files {
		if path.Base(f.Path) != "go.mod" {
			continue
		}
		if m := goModLine.FindSubmatch(f.Content); m != nil {
			mods = append(mods, goModule{dirOf(f.Path), string(m[2])})
		}
	}
	// longest directory first so nested modules win
	sort.Slice(mods, func(i, j int) bool { return len(mods[i].dir) > len(mods[j].dir) })
	return mods
}

func importPathOf(dir string, mods []goModule) string {
	for _, m := range mods {
		if m.dir == "" || dir == m.dir || strings.HasPrefix(dir, m.dir+"/") {
			rel := strings.TrimPrefix(strings.TrimPrefix(dir, m.dir), "/")
			if rel == "" {
				return m.path
			}
			return m.path + "/" + rel
		}
	}
	if dir == "" {
		return "main"
	}
	return dir
}

type goPkg struct {
	path    string // import path (+"_test" for external test packages)
	dir     string
	files   []*ast.File
	names   []string // file paths, parallel to files
	types   *types.Package
	info    *types.Info
	state   int // 0 new, 1 checking, 2 done
	isXTest bool
}

type goImporter struct {
	fset  *token.FileSet
	pkgs  map[string]*goPkg
	fakes map[string]*types.Package
}

func (im *goImporter) Import(p string) (*types.Package, error) { return im.ImportFrom(p, "", 0) }

func (im *goImporter) ImportFrom(p, _ string, _ types.ImportMode) (*types.Package, error) {
	if p == "unsafe" {
		return types.Unsafe, nil
	}
	if pk := im.pkgs[p]; pk != nil && !pk.isXTest {
		if pk.state == 1 { // import cycle (invalid code): stub it
			return im.fake(p), nil
		}
		im.check(pk)
		return pk.types, nil
	}
	return im.fake(p), nil
}

// fake is an empty, complete package: uses of it are type errors, which the checker tolerates.
func (im *goImporter) fake(p string) *types.Package {
	if f := im.fakes[p]; f != nil {
		return f
	}
	f := types.NewPackage(p, guessPkgName(p))
	f.MarkComplete()
	im.fakes[p] = f
	return f
}

func guessPkgName(p string) string {
	parts := strings.Split(p, "/")
	name := parts[len(parts)-1]
	if len(parts) > 1 && regexp.MustCompile(`^v\d+$`).MatchString(name) {
		name = parts[len(parts)-2]
	}
	name = strings.TrimPrefix(strings.TrimSuffix(strings.TrimSuffix(name, ".go"), "-go"), "go-")
	if i := strings.Index(name, "."); i > 0 {
		name = name[:i]
	}
	return strings.ReplaceAll(name, "-", "_")
}

func (im *goImporter) check(pk *goPkg) {
	if pk.state != 0 {
		return
	}
	pk.state = 1
	pk.info = &types.Info{
		Types:      map[ast.Expr]types.TypeAndValue{},
		Defs:       map[*ast.Ident]types.Object{},
		Uses:       map[*ast.Ident]types.Object{},
		Selections: map[*ast.SelectorExpr]*types.Selection{},
	}
	conf := types.Config{Importer: im, Error: func(error) {}, FakeImportC: true}
	pk.types, _ = conf.Check(pk.path, im.fset, pk.files, pk.info)
	pk.state = 2
}

// ---------------------------------------------------------------- analysis

type goAnalyzer struct {
	b       *builder
	im      *goImporter
	fset    *token.FileSet
	inMod   map[string]bool // import paths of this repository's packages
	fieldTy map[string]string
	named   []*types.TypeName // this repository's concrete named types (for interface dispatch)
	implOf  map[*types.Func][]*Node
}

func (b *builder) analyzeGo(files []File, mods []goModule) {
	fset := token.NewFileSet()
	im := &goImporter{fset: fset, pkgs: map[string]*goPkg{}, fakes: map[string]*types.Package{}}
	byKey := map[string]*goPkg{}
	for _, f := range files {
		if strings.Contains("/"+f.Path, "/vendor/") || strings.Contains("/"+f.Path, "/testdata/") || len(f.Content) > 1<<20 {
			continue
		}
		af, _ := parser.ParseFile(fset, f.Path, f.Content, parser.SkipObjectResolution)
		if af == nil || af.Name == nil {
			continue
		}
		dir := dirOf(f.Path)
		ip := importPathOf(dir, mods)
		xtest := strings.HasSuffix(af.Name.Name, "_test") && strings.HasSuffix(f.Path, "_test.go")
		key := ip
		if xtest {
			key = ip + "_test"
		}
		pk := byKey[key]
		if pk == nil {
			pk = &goPkg{path: key, dir: dir, isXTest: xtest}
			byKey[key] = pk
			im.pkgs[key] = pk
		}
		pk.files = append(pk.files, af)
		pk.names = append(pk.names, f.Path)
	}
	a := &goAnalyzer{b: b, im: im, fset: fset, inMod: map[string]bool{}, fieldTy: map[string]string{}, implOf: map[*types.Func][]*Node{}}
	keys := make([]string, 0, len(byKey))
	for k := range byKey {
		keys = append(keys, k)
		a.inMod[k] = true
	}
	sort.Strings(keys)
	for _, k := range keys {
		im.check(byKey[k])
	}
	for _, k := range keys {
		a.declare(byKey[k])
	}
	for _, k := range keys {
		a.bodies(byKey[k])
	}
}

func (a *goAnalyzer) line(p token.Pos) int { return a.fset.Position(p).Line }

func (a *goAnalyzer) local(o types.Object) bool {
	return o != nil && o.Pkg() != nil && a.inMod[o.Pkg().Path()]
}

// qualify names package-level functions the Go way (store.Open), except in package main.
func qualify(p *types.Package, name string) string {
	if p == nil || p.Name() == "main" || strings.HasSuffix(p.Name(), "_test") {
		return name
	}
	return p.Name() + "." + name
}

func recvName(sig *types.Signature) string {
	if sig == nil || sig.Recv() == nil {
		return ""
	}
	t := sig.Recv().Type()
	if p, ok := t.(*types.Pointer); ok {
		t = p.Elem()
	}
	switch x := t.(type) {
	case *types.Named:
		return x.Obj().Name()
	case *types.Interface:
		return "interface"
	}
	return ""
}

func (a *goAnalyzer) funcKey(f *types.Func) string {
	sig, _ := f.Type().(*types.Signature)
	pkg := ""
	if f.Pkg() != nil {
		pkg = f.Pkg().Path()
	}
	if r := recvName(sig); r != "" {
		return "go:" + pkg + "." + r + "." + f.Name()
	}
	return "go:" + pkg + "." + f.Name()
}

// funcNode returns the node of a function of this repository (a stub if its declaration was not seen).
func (a *goAnalyzer) funcNode(f *types.Func) *Node {
	f = f.Origin()
	if n := a.b.lookup(a.funcKey(f)); n != nil {
		return n
	}
	sig, _ := f.Type().(*types.Signature)
	r := recvName(sig)
	name, kind, parent := qualify(f.Pkg(), f.Name()), KFunc, -1
	if r != "" {
		name, kind = r+"."+f.Name(), KMethod
		if c := a.b.lookup("go:" + f.Pkg().Path() + "." + r); c != nil {
			parent = c.ID
		}
	}
	return a.b.node(a.funcKey(f), Node{Kind: kind, Name: name, Parent: parent, Lang: "Go", Exported: f.Exported()})
}

// declare creates nodes for the package's types and functions.
func (a *goAnalyzer) declare(pk *goPkg) {
	for i, f := range pk.files {
		file := pk.names[i]
		test := strings.HasSuffix(file, "_test.go")
		for _, d := range f.Decls {
			switch d := d.(type) {
			case *ast.GenDecl:
				if d.Tok != token.TYPE {
					continue
				}
				for _, sp := range d.Specs {
					ts := sp.(*ast.TypeSpec)
					obj, _ := pk.info.Defs[ts.Name].(*types.TypeName)
					if obj == nil {
						continue
					}
					sub := "type"
					switch st := ts.Type.(type) {
					case *ast.StructType:
						sub = "struct"
						for _, fl := range st.Fields.List {
							for _, nm := range fl.Names {
								a.fieldTy[pk.path+"."+ts.Name.Name+"."+nm.Name] = exprText(fl.Type)
							}
						}
					case *ast.InterfaceType:
						sub = "interface"
					}
					start, end := a.line(d.Pos()), a.line(d.End())
					if len(d.Specs) > 1 {
						start, end = a.line(ts.Pos()), a.line(ts.End())
					}
					a.b.node("go:"+pk.path+"."+ts.Name.Name, Node{Kind: KClass, Sub: sub, Name: ts.Name.Name, Path: file, Start: start, End: end,
						Module: pk.dir, Lang: "Go", Exported: ts.Name.IsExported(), Test: test})
					if _, isIface := obj.Type().Underlying().(*types.Interface); !isIface && !obj.IsAlias() {
						a.named = append(a.named, obj)
					}
				}
			case *ast.FuncDecl:
				obj, _ := pk.info.Defs[d.Name].(*types.Func)
				if obj == nil {
					continue
				}
				sig, _ := obj.Type().(*types.Signature)
				r := recvName(sig)
				name, kind, parent := qualify(obj.Pkg(), d.Name.Name), KFunc, -1
				if r != "" {
					name, kind = r+"."+d.Name.Name, KMethod
					if c := a.b.lookup("go:" + pk.path + "." + r); c != nil {
						parent = c.ID
					}
				}
				n := a.b.node(a.funcKey(obj), Node{Kind: kind, Name: name, Path: file, Start: a.line(d.Pos()), End: a.line(d.End()),
					Module: pk.dir, Parent: parent, Lang: "Go", Exported: d.Name.IsExported(), Test: test})
				if n != nil && r == "" && d.Name.Name == "main" && f.Name.Name == "main" {
					n.Entry = "main"
				}
			}
		}
	}
}

// goScope is the function a piece of code belongs to, for attribution.
type goScope struct {
	body ast.Node     // the function body (locals are declared inside it)
	lit  *ast.FuncLit // set for a closure scope: variables captured from outside it are long-lived
	recv types.Object // the method's receiver (writes through it are state updates)
	n    *Node
	file string
	main bool
	pkg  *goPkg
	af   *ast.File
	// local variables holding a flag.FlagSet
	flagSets map[string]bool
	// local variables holding a function literal (handlers registered by name)
	locals map[types.Object]*Node
}

func (a *goAnalyzer) bodies(pk *goPkg) {
	for i, f := range pk.files {
		file := pk.names[i]
		for _, d := range f.Decls {
			switch d := d.(type) {
			case *ast.FuncDecl:
				obj, _ := pk.info.Defs[d.Name].(*types.Func)
				if obj == nil || d.Body == nil {
					continue
				}
				n := a.b.lookup(a.funcKey(obj))
				if n == nil {
					continue
				}
				var recv types.Object
				if d.Recv != nil && len(d.Recv.List) > 0 && len(d.Recv.List[0].Names) > 0 {
					recv = pk.info.Defs[d.Recv.List[0].Names[0]]
				}
				a.walk(d.Body, &goScope{body: d.Body, recv: recv, n: n, file: file, main: n.Entry == "main", pkg: pk, af: f, flagSets: map[string]bool{}})
			case *ast.GenDecl:
				// package-level initializers run before main: attribute to a synthetic init scope only for I/O
				if d.Tok != token.VAR {
					continue
				}
				for _, sp := range d.Specs {
					vs := sp.(*ast.ValueSpec)
					for _, v := range vs.Values {
						if hasCall(v) {
							n := a.b.node("go:"+pk.path+".init", Node{Kind: KFunc, Sub: "init", Name: "init (package vars)", Path: file,
								Start: a.line(d.Pos()), End: a.line(d.End()), Module: pk.dir, Lang: "Go"})
							a.walk(v, &goScope{n: n, file: file, pkg: pk, af: f, flagSets: map[string]bool{}})
						}
					}
				}
			}
		}
	}
}

func hasCall(e ast.Node) bool {
	found := false
	ast.Inspect(e, func(x ast.Node) bool {
		if _, ok := x.(*ast.CallExpr); ok {
			found = true
		}
		return !found
	})
	return found
}

var goRouteMethods = map[string]string{
	"HandleFunc": "", "Handle": "", "GET": "GET", "POST": "POST", "PUT": "PUT", "DELETE": "DELETE", "PATCH": "PATCH",
	"HEAD": "HEAD", "OPTIONS": "OPTIONS", "Get": "GET", "Post": "POST", "Put": "PUT", "Delete": "DELETE", "Patch": "PATCH",
	"Head": "HEAD", "Options": "OPTIONS", "Any": "", "Route": "",
}

var goFlagDefs = map[string]bool{"String": true, "Bool": true, "Int": true, "Int64": true, "Uint": true, "Uint64": true, "Float64": true,
	"Duration": true, "Var": true, "StringVar": true, "BoolVar": true, "IntVar": true, "Int64Var": true, "UintVar": true, "Float64Var": true,
	"DurationVar": true, "Func": true, "TextVar": true, "StringP": true, "BoolP": true, "IntP": true, "StringSlice": true}

// walk attributes everything in body to scope sc.
func (a *goAnalyzer) walk(body ast.Node, sc *goScope) {
	info := sc.pkg.info
	closures := map[*ast.FuncLit]*Node{}
	lhs := map[ast.Expr]bool{}
	if sc.locals == nil {
		sc.locals = map[types.Object]*Node{}
		a.localHandlers(body, sc, closures)
	}
	ast.Inspect(body, func(x ast.Node) bool {
		switch x := x.(type) {
		case *ast.FuncLit:
			if n := closures[x]; n != nil {
				a.walk(x.Body, &goScope{body: sc.body, lit: x, recv: sc.recv, n: n, file: sc.file, pkg: sc.pkg, af: sc.af, flagSets: sc.flagSets, locals: sc.locals})
				return false
			}
		case *ast.AssignStmt:
			for _, l := range x.Lhs {
				a.write(l, sc, lhs)
			}
			// fs := flag.NewFlagSet(...)
			for i, r := range x.Rhs {
				if c, ok := r.(*ast.CallExpr); ok && i < len(x.Lhs) {
					if p, fn := a.pkgFunc(c.Fun, sc); (p == "flag" && fn == "NewFlagSet") || strings.HasSuffix(exprText(c.Fun), "Flags") || strings.HasSuffix(exprText(c.Fun), "PersistentFlags") {
						if id, ok := x.Lhs[i].(*ast.Ident); ok {
							sc.flagSets[id.Name] = true
						}
					}
				}
			}
		case *ast.IncDecStmt:
			a.write(x.X, sc, lhs)
		case *ast.CallExpr:
			a.call(x, sc, closures)
		case *ast.CompositeLit:
			a.composite(x, sc, closures)
		case *ast.SelectorExpr:
			if lhs[x] {
				return true
			}
			if sel := info.Selections[x]; sel != nil && sel.Kind() == types.FieldVal {
				if n := a.field(sel); n != nil {
					a.b.edge(n, sc.n, EFeeds, "", a.line(x.Pos()), true)
				}
			}
			// os.Args / os.Stdin read as values
			if p, name := a.pkgFunc(x, sc); p == "os" {
				switch name {
				case "Args":
					a.b.source(sc.n, "args", "command-line arguments", "os.Args", a.line(x.Pos()))
				case "Stdin":
					a.b.source(sc.n, "stdin", "stdin", "", a.line(x.Pos()))
				}
			}
		case *ast.Ident:
			if lhs[x] {
				return true
			}
			if v, ok := info.Uses[x].(*types.Var); ok && a.pkgVar(v) {
				a.b.edge(a.varNode(v), sc.n, EFeeds, "", a.line(x.Pos()), true)
			}
		case *ast.SwitchStmt:
			a.commands(x, sc)
		case *ast.BasicLit:
			if x.Kind == token.STRING {
				if s, err := strconv.Unquote(x.Value); err == nil {
					a.b.sql(sc.n, s, a.line(x.Pos()))
				}
			}
		}
		return true
	})
}

// localHandlers gives a node to function literals held in local variables that are registered as route handlers
// (serveCity := func(w, r) {…}; mux.HandleFunc("GET /city.json", serveCity)).
func (a *goAnalyzer) localHandlers(body ast.Node, sc *goScope, closures map[*ast.FuncLit]*Node) {
	info := sc.pkg.info
	lits := map[types.Object]*ast.FuncLit{}
	names := map[types.Object]string{}
	ast.Inspect(body, func(x ast.Node) bool {
		if as, ok := x.(*ast.AssignStmt); ok && len(as.Lhs) == len(as.Rhs) {
			for i, r := range as.Rhs {
				lit, ok := r.(*ast.FuncLit)
				id, ok2 := as.Lhs[i].(*ast.Ident)
				if ok && ok2 {
					obj := info.Defs[id]
					if obj == nil {
						obj = info.Uses[id]
					}
					if obj != nil {
						lits[obj], names[obj] = lit, id.Name
					}
				}
			}
		}
		return true
	})
	if len(lits) == 0 {
		return
	}
	ast.Inspect(body, func(x ast.Node) bool {
		c, ok := x.(*ast.CallExpr)
		if !ok || len(c.Args) < 2 {
			return true
		}
		sel, ok := unparen(c.Fun).(*ast.SelectorExpr)
		if !ok {
			return true
		}
		if _, isRoute := goRouteMethods[sel.Sel.Name]; !isRoute {
			return true
		}
		id, ok := unparen(c.Args[len(c.Args)-1]).(*ast.Ident)
		if !ok {
			return true
		}
		obj := info.Uses[id]
		lit := lits[obj]
		if lit == nil || sc.locals[obj] != nil {
			return true
		}
		n := a.b.node("go:closure:"+sc.file+":"+strconv.Itoa(a.line(lit.Pos())), Node{Kind: KFunc, Sub: "closure", Name: sc.n.Name + " ‹" + names[obj] + "›",
			Path: sc.file, Start: a.line(lit.Pos()), End: a.line(lit.End()), Module: dirOf(sc.file), Lang: "Go", Test: sc.n.Test})
		closures[lit] = n
		sc.locals[obj] = n
		return true
	})
}

// write records a state write by an assignment target.
func (a *goAnalyzer) write(e ast.Expr, sc *goScope, lhs map[ast.Expr]bool) {
	info := sc.pkg.info
	for {
		switch x := e.(type) {
		case *ast.ParenExpr:
			e = x.X
			continue
		case *ast.StarExpr:
			e = x.X
			continue
		case *ast.IndexExpr: // s.m[k] = v mutates s.m
			e = x.X
			continue
		case *ast.SelectorExpr:
			lhs[x] = true
			// state = fields of the receiver (or reached from a package variable); filling in values
			// passed in or created here (responses, DTOs) is data shaping, not a state update
			if !a.stateRoot(x, sc) {
				return
			}
			if sel := info.Selections[x]; sel != nil && sel.Kind() == types.FieldVal {
				if n := a.field(sel); n != nil {
					a.b.edge(sc.n, n, EWrites, "", a.line(x.Pos()), true)
				}
			}
		case *ast.Ident:
			lhs[x] = true
			obj := info.Uses[x]
			if obj == nil {
				obj = info.Defs[x]
			}
			if v, ok := obj.(*types.Var); ok && a.pkgVar(v) {
				a.b.edge(sc.n, a.varNode(v), EWrites, "", a.line(x.Pos()), true)
			}
		}
		return
	}
}

// stateRoot: does the selector chain start at the method's receiver or a package variable?
func (a *goAnalyzer) stateRoot(e ast.Expr, sc *goScope) bool {
	for {
		switch x := e.(type) {
		case *ast.SelectorExpr:
			e = x.X
			continue
		case *ast.IndexExpr:
			e = x.X
			continue
		case *ast.StarExpr:
			e = x.X
			continue
		case *ast.ParenExpr:
			e = x.X
			continue
		case *ast.Ident:
			obj := sc.pkg.info.Uses[x]
			if obj == nil {
				obj = sc.pkg.info.Defs[x]
			}
			v, ok := obj.(*types.Var)
			if !ok {
				return false
			}
			captured := sc.lit != nil && (v.Pos() < sc.lit.Pos() || v.Pos() >= sc.lit.End())
			return sc.recv != nil && v == sc.recv || a.pkgVar(v) || captured
		}
		return false
	}
}

func (a *goAnalyzer) pkgVar(v *types.Var) bool {
	return a.local(v) && !v.IsField() && v.Parent() != nil && v.Parent() == v.Pkg().Scope()
}

func (a *goAnalyzer) varNode(v *types.Var) *Node {
	pos := a.fset.Position(v.Pos())
	return a.b.node("go:var:"+v.Pkg().Path()+"."+v.Name(), Node{Kind: KData, Sub: "var", Name: v.Pkg().Name() + "." + v.Name(),
		Path: pos.Filename, Start: pos.Line, End: pos.Line, Parent: -1, Lang: "Go"})
}

// field returns the state node of a struct field of this repository (nil for locks and foreign types).
func (a *goAnalyzer) field(sel *types.Selection) *Node {
	v, _ := sel.Obj().(*types.Var)
	if v == nil || !a.local(v) {
		return nil
	}
	t := sel.Recv()
	if p, ok := t.(*types.Pointer); ok {
		t = p.Elem()
	}
	named, _ := t.(*types.Named)
	if named == nil || !a.local(named.Obj()) {
		return nil
	}
	// the field may be promoted from an embedded struct: name it after its declaring struct when we can
	owner := named.Obj().Name()
	ty := a.fieldTy[named.Obj().Pkg().Path()+"."+owner+"."+v.Name()]
	if strings.HasPrefix(ty, "sync.") || strings.HasPrefix(ty, "*sync.") || strings.HasPrefix(ty, "atomic.") || strings.HasPrefix(ty, "context.") {
		return nil
	}
	parent := -1
	if c := a.b.lookup("go:" + named.Obj().Pkg().Path() + "." + owner); c != nil {
		parent = c.ID
	}
	pos := a.fset.Position(v.Pos())
	return a.b.node("go:field:"+named.Obj().Pkg().Path()+"."+owner+"."+v.Name(), Node{Kind: KData, Sub: "field", Name: owner + "." + v.Name(),
		Path: pos.Filename, Start: pos.Line, End: pos.Line, Parent: parent, Lang: "Go"})
}

// pkgFunc resolves pkg.Name selectors on imported packages (by type info, or the file's imports).
func (a *goAnalyzer) pkgFunc(e ast.Expr, sc *goScope) (pkgPath, name string) {
	sel, ok := e.(*ast.SelectorExpr)
	if !ok {
		return "", ""
	}
	id, ok := sel.X.(*ast.Ident)
	if !ok {
		return "", ""
	}
	if pn, ok := sc.pkg.info.Uses[id].(*types.PkgName); ok {
		return pn.Imported().Path(), sel.Sel.Name
	}
	if sc.pkg.info.Uses[id] != nil {
		return "", "" // a variable, not a package
	}
	for _, im := range sc.af.Imports {
		p, _ := strconv.Unquote(im.Path.Value)
		n := guessPkgName(p)
		if im.Name != nil {
			n = im.Name.Name
		}
		if n == id.Name {
			return p, sel.Sel.Name
		}
	}
	return "", ""
}

func unparen(e ast.Expr) ast.Expr {
	for {
		switch x := e.(type) {
		case *ast.ParenExpr:
			e = x.X
		case *ast.IndexExpr:
			e = x.X
		case *ast.IndexListExpr:
			e = x.X
		default:
			return e
		}
	}
}

// callee resolves a call target to a function of this repository.
func (a *goAnalyzer) callee(fun ast.Expr, sc *goScope) (*types.Func, bool) {
	info := sc.pkg.info
	switch f := unparen(fun).(type) {
	case *ast.Ident:
		if fn, ok := info.Uses[f].(*types.Func); ok && a.local(fn) {
			return fn, false
		}
	case *ast.SelectorExpr:
		if sel := info.Selections[f]; sel != nil {
			if fn, ok := sel.Obj().(*types.Func); ok && a.local(fn) {
				_, iface := sel.Recv().Underlying().(*types.Interface)
				return fn, iface
			}
			return nil, false
		}
		if fn, ok := info.Uses[f.Sel].(*types.Func); ok && a.local(fn) {
			return fn, false
		}
	}
	return nil, false
}

// impls lists implementations of interface method m among this repository's types.
func (a *goAnalyzer) impls(m *types.Func) []*Node {
	if r, ok := a.implOf[m]; ok {
		return r
	}
	var out []*Node
	sig, _ := m.Type().(*types.Signature)
	if sig != nil && sig.Recv() != nil {
		if iface, ok := sig.Recv().Type().Underlying().(*types.Interface); ok {
			for _, tn := range a.named {
				t := tn.Type()
				if !types.Implements(t, iface) && !types.Implements(types.NewPointer(t), iface) {
					continue
				}
				ms := types.NewMethodSet(types.NewPointer(t))
				if s := ms.Lookup(m.Pkg(), m.Name()); s != nil {
					if fn, ok := s.Obj().(*types.Func); ok && a.local(fn) {
						out = append(out, a.funcNode(fn))
					}
				}
				if len(out) >= 8 {
					break
				}
			}
		}
	}
	a.implOf[m] = out
	return out
}

func (a *goAnalyzer) callEdge(sc *goScope, fn *types.Func, iface bool, line int, label string) {
	to := a.funcNode(fn)
	a.b.edge(sc.n, to, ECall, label, line, true)
	if iface && to != nil {
		for _, impl := range a.impls(fn) {
			a.b.edge(to, impl, EImpl, "", 0, false)
		}
	}
}

func strArg(e ast.Expr) (string, bool) {
	if bl, ok := e.(*ast.BasicLit); ok && bl.Kind == token.STRING {
		s, err := strconv.Unquote(bl.Value)
		return s, err == nil
	}
	return "", false
}

// handlerNode returns the node for a handler expression: a function, a method value, or a closure (registered for walking).
func (a *goAnalyzer) handlerNode(e ast.Expr, sc *goScope, closures map[*ast.FuncLit]*Node, label string) *Node {
	e = unparen(e)
	// http.HandlerFunc(f) and similar conversions / wrappers with one argument
	if c, ok := e.(*ast.CallExpr); ok && len(c.Args) == 1 {
		if _, isFn := a.callee(c.Fun, sc); !isFn {
			return a.handlerNode(c.Args[0], sc, closures, label)
		}
	}
	switch h := e.(type) {
	case *ast.FuncLit:
		n := a.b.node("go:closure:"+sc.file+":"+strconv.Itoa(a.line(h.Pos())), Node{Kind: KFunc, Sub: "closure",
			Name: strings.TrimSuffix(sc.n.Name, " ‹closure›") + " ‹" + label + "›", Path: sc.file, Start: a.line(h.Pos()), End: a.line(h.End()),
			Module: dirOf(sc.file), Lang: "Go", Test: sc.n.Test})
		closures[h] = n
		return n
	case *ast.Ident, *ast.SelectorExpr:
		var obj types.Object
		if id, ok := h.(*ast.Ident); ok {
			obj = sc.pkg.info.Uses[id]
			if n := sc.locals[obj]; n != nil {
				return n
			}
		} else if sel := sc.pkg.info.Selections[h.(*ast.SelectorExpr)]; sel != nil {
			obj = sel.Obj()
		} else {
			obj = sc.pkg.info.Uses[h.(*ast.SelectorExpr).Sel]
		}
		if fn, ok := obj.(*types.Func); ok && a.local(fn) {
			return a.funcNode(fn)
		}
	}
	return nil
}

// io rules for standard library calls: package → function → (kind, sub, name).
type goIO struct{ dir, sub, name string }

var goStd = map[string]map[string]goIO{
	"os": {
		"ReadFile": {"in", "file", "files (read)"}, "ReadDir": {"in", "file", "files (read)"}, "Open": {"in", "file", "files (read)"},
		"WriteFile": {"out", "file", "files (written)"}, "Create": {"out", "file", "files (written)"}, "OpenFile": {"out", "file", "files (written)"},
		"Remove": {"out", "file", "files (written)"}, "RemoveAll": {"out", "file", "files (written)"}, "Rename": {"out", "file", "files (written)"},
		"Mkdir": {"out", "file", "files (written)"}, "MkdirAll": {"out", "file", "files (written)"}, "MkdirTemp": {"out", "file", "files (written)"},
		"CreateTemp": {"out", "file", "files (written)"}, "Getenv": {"in", "env", "environment"}, "LookupEnv": {"in", "env", "environment"},
		"Environ": {"in", "env", "environment"}, "Setenv": {"out", "env", "environment (set)"}, "Exit": {"out", "process", "exit code"},
	},
	"io/ioutil": {"ReadFile": {"in", "file", "files (read)"}, "WriteFile": {"out", "file", "files (written)"}, "ReadDir": {"in", "file", "files (read)"}, "TempDir": {"out", "file", "files (written)"}},
	"os/exec":   {"Command": {"io", "process", ""}, "CommandContext": {"io", "process", ""}, "LookPath": {"in", "process", "PATH lookup"}},
	"net/http": {"Get": {"io", "http", ""}, "Post": {"io", "http", ""}, "Head": {"io", "http", ""}, "PostForm": {"io", "http", ""},
		"NewRequest": {"io", "http", ""}, "NewRequestWithContext": {"io", "http", ""}},
	"net":          {"Dial": {"io", "network", "network"}, "DialTimeout": {"io", "network", "network"}, "Listen": {"in", "network", "network listener"}},
	"database/sql": {"Open": {"io", "db", "database"}},
	"fmt":          {"Print": {"out", "stdio", "stdout"}, "Printf": {"out", "stdio", "stdout"}, "Println": {"out", "stdio", "stdout"}},
	"log": {"Print": {"out", "log", "log"}, "Printf": {"out", "log", "log"}, "Println": {"out", "log", "log"}, "Fatal": {"out", "log", "log"},
		"Fatalf": {"out", "log", "log"}, "Fatalln": {"out", "log", "log"}, "Panic": {"out", "log", "log"}, "Panicf": {"out", "log", "log"}},
	"log/slog": {"Info": {"out", "log", "log"}, "Warn": {"out", "log", "log"}, "Error": {"out", "log", "log"}, "Debug": {"out", "log", "log"}},
}

func (a *goAnalyzer) call(c *ast.CallExpr, sc *goScope, closures map[*ast.FuncLit]*Node) {
	line := a.line(c.Pos())
	fun := unparen(c.Fun)
	// HTTP routes: mux.HandleFunc("GET /x", h), r.GET("/x", h), …
	if sel, ok := fun.(*ast.SelectorExpr); ok && len(c.Args) >= 2 {
		if method, isRoute := goRouteMethods[sel.Sel.Name]; isRoute {
			if pat, ok := strArg(c.Args[0]); ok && (strings.HasPrefix(pat, "/") || strings.Contains(pat, " /")) {
				m := method
				route := pat
				if mm, rest, found := strings.Cut(pat, " "); found && m == "" && strings.ToUpper(mm) == mm {
					m, route = mm, strings.TrimSpace(rest)
				}
				ep := a.b.endpoint(m, route)
				if h := a.handlerNode(c.Args[len(c.Args)-1], sc, closures, pat); h != nil {
					if e := a.b.edge(ep, h, EHandles, "", line, true); e != nil {
						e.File = a.b.p(sc.file)
					}
				}
				return
			}
		}
	}
	// calls into this repository
	if fn, iface := a.callee(fun, sc); fn != nil {
		a.callEdge(sc, fn, iface, line, "")
	}
	// functions passed as values: callbacks
	for _, arg := range c.Args {
		arg = unparen(arg)
		var obj types.Object
		switch x := arg.(type) {
		case *ast.Ident:
			obj = sc.pkg.info.Uses[x]
		case *ast.SelectorExpr:
			if sel := sc.pkg.info.Selections[x]; sel != nil && sel.Kind() == types.MethodVal {
				obj = sel.Obj()
			} else if sel == nil {
				obj = sc.pkg.info.Uses[x.Sel]
			}
		}
		if fn, ok := obj.(*types.Func); ok && a.local(fn) {
			a.b.edge(sc.n, a.funcNode(fn), ERef, "callback", line, true)
		}
	}
	// the outside world
	p, name := a.pkgFunc(fun, sc)
	if rules := goStd[p]; rules != nil {
		if r, ok := rules[name]; ok {
			a.stdIO(c, sc, p, name, r, line)
		}
	}
	if p == "fmt" && strings.HasPrefix(name, "Fprint") && len(c.Args) > 0 {
		if q, n := a.pkgFunc(c.Args[0], sc); q == "os" && (n == "Stdout" || n == "Stderr") {
			a.b.sink(sc.n, "stdio", strings.ToLower(n), name, line)
		}
	}
	// flags
	if sel, ok := fun.(*ast.SelectorExpr); ok && goFlagDefs[sel.Sel.Name] && len(c.Args) >= 2 {
		recv := exprText(sel.X)
		isFlag := p == "flag" || sc.flagSets[recv] || strings.HasSuffix(recv, "Flags()") || strings.HasSuffix(recv, "PersistentFlags()")
		ai := 0 // fs.String("name", …); fs.StringVar(&v, "name", …)
		if strings.HasSuffix(sel.Sel.Name, "Var") {
			ai = 1
		}
		if isFlag && ai < len(c.Args) {
			if fl, ok := strArg(c.Args[ai]); ok && fl != "" {
				n := a.b.node("flag:--"+fl, Node{Kind: KFlag, Name: "--" + fl, Parent: -1})
				a.b.edge(n, sc.n, EFeeds, "", line, true)
			}
		}
	}
}

func (a *goAnalyzer) stdIO(c *ast.CallExpr, sc *goScope, p, name string, r goIO, line int) {
	switch r.sub {
	case "process":
		if r.dir == "io" {
			cmd := "exec"
			ai := 0
			if name == "CommandContext" {
				ai = 1
			}
			if ai < len(c.Args) {
				if s, ok := strArg(c.Args[ai]); ok {
					cmd = path.Base(s)
				}
			}
			a.b.external(sc.n, "process", cmd, "exec", line)
			return
		}
	case "http":
		method, url := "GET", ""
		args := c.Args
		switch name {
		case "Post", "PostForm":
			method = "POST"
		case "Head":
			method = "HEAD"
		case "NewRequest", "NewRequestWithContext":
			if name == "NewRequestWithContext" && len(args) > 0 {
				args = args[1:]
			}
			if len(args) > 0 {
				if m, ok := strArg(args[0]); ok {
					method = m
				} else if q, n := a.pkgFunc(args[0], sc); q == "net/http" && strings.HasPrefix(n, "Method") {
					method = strings.ToUpper(strings.TrimPrefix(n, "Method"))
				}
				args = args[1:]
			}
		}
		if len(args) > 0 {
			url, _ = strArg(args[0])
		}
		if url != "" {
			a.b.request(sc.n, method, url, line, "")
		} else {
			a.b.external(sc.n, "http", "HTTP (dynamic URL)", method, line)
		}
		return
	case "db":
		driver := "database"
		if len(c.Args) > 0 {
			if s, ok := strArg(c.Args[0]); ok {
				driver = s
			}
		}
		a.b.external(sc.n, "db", driver, "open", line)
		return
	}
	label := name
	if len(c.Args) > 0 {
		if s, ok := strArg(c.Args[0]); ok && len(s) < 60 && !strings.ContainsAny(s, "\n%") {
			label = name + " " + s
		}
	}
	switch r.dir {
	case "in":
		a.b.source(sc.n, r.sub, r.name, label, line)
	case "out":
		a.b.sink(sc.n, r.sub, r.name, label, line)
	default:
		a.b.external(sc.n, r.sub, r.name, label, line)
	}
}

// composite: &T{…} creates an instance; cobra-style &Command{Use: "x", Run: f} declares a command.
func (a *goAnalyzer) composite(cl *ast.CompositeLit, sc *goScope, closures map[*ast.FuncLit]*Node) {
	tv, ok := sc.pkg.info.Types[cl]
	line := a.line(cl.Pos())
	if ok {
		t := tv.Type
		if p, isPtr := t.(*types.Pointer); isPtr {
			t = p.Elem()
		}
		if named, isNamed := t.(*types.Named); isNamed && a.local(named.Obj()) {
			if c := a.b.lookup("go:" + named.Obj().Pkg().Path() + "." + named.Obj().Name()); c != nil {
				if _, isStruct := named.Underlying().(*types.Struct); isStruct {
					a.b.edge(sc.n, c, ENew, "", line, true)
				}
			}
		}
	}
	var use string
	var run ast.Expr
	for _, el := range cl.Elts {
		kv, ok := el.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		k, _ := kv.Key.(*ast.Ident)
		if k == nil {
			continue
		}
		switch k.Name {
		case "Use":
			use, _ = strArg(kv.Value)
		case "Run", "RunE", "Action":
			run = kv.Value
		}
	}
	if use != "" && run != nil {
		name := strings.Fields(use)[0]
		cmd := a.b.node("command:"+name, Node{Kind: KCommand, Name: name, Parent: -1})
		if h := a.handlerNode(run, sc, closures, "command "+name); h != nil {
			if e := a.b.edge(cmd, h, EHandles, "", line, true); e != nil {
				e.File = a.b.p(sc.file)
			}
		}
	}
}

// commands: switch os.Args[1] { case "serve": … } in main (or on args) declares CLI commands.
func (a *goAnalyzer) commands(sw *ast.SwitchStmt, sc *goScope) {
	if sw.Tag == nil {
		return
	}
	tag := exprText(sw.Tag)
	if !sc.main && !strings.Contains(tag, "Args") && !strings.Contains(tag, "Arg(") {
		return
	}
	for _, st := range sw.Body.List {
		cc, ok := st.(*ast.CaseClause)
		if !ok {
			continue
		}
		var names []string
		for _, e := range cc.List {
			if s, ok := strArg(e); ok && s != "" && !strings.HasPrefix(s, "-") {
				names = append(names, s)
			}
		}
		if len(names) == 0 {
			continue
		}
		var targets []*Node
		for _, stmt := range cc.Body {
			ast.Inspect(stmt, func(x ast.Node) bool {
				if c, ok := x.(*ast.CallExpr); ok {
					if fn, _ := a.callee(c.Fun, sc); fn != nil {
						targets = append(targets, a.funcNode(fn))
					}
				}
				return true
			})
		}
		if len(targets) == 0 {
			targets = []*Node{sc.n}
		}
		line := a.line(cc.Pos())
		for _, nm := range names {
			cmd := a.b.node("command:"+nm, Node{Kind: KCommand, Name: nm, Parent: -1})
			for _, t := range targets {
				if e := a.b.edge(cmd, t, EHandles, "", line, true); e != nil {
					e.File = a.b.p(sc.file)
				}
			}
		}
	}
}

// exprText renders a (short) expression as source text.
func exprText(e ast.Expr) string {
	switch x := e.(type) {
	case *ast.Ident:
		return x.Name
	case *ast.SelectorExpr:
		return exprText(x.X) + "." + x.Sel.Name
	case *ast.StarExpr:
		return "*" + exprText(x.X)
	case *ast.CallExpr:
		return exprText(x.Fun) + "()"
	case *ast.IndexExpr:
		return exprText(x.X) + "[" + exprText(x.Index) + "]"
	case *ast.ArrayType:
		return "[]" + exprText(x.Elt)
	case *ast.MapType:
		return "map[" + exprText(x.Key) + "]" + exprText(x.Value)
	case *ast.BasicLit:
		return x.Value
	case *ast.ParenExpr:
		return exprText(x.X)
	}
	return ""
}
