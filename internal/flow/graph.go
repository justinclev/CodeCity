// Package flow builds a flow graph of a code base: functions, methods and
// types; who calls whom; where state is written and read; and the boundaries
// where the program meets the outside world — HTTP routes it serves, CLI
// commands and flags, UI events (inputs) and processes, files, HTTP calls,
// SQL tables, browser storage, stdout (outputs).
//
// Go is analyzed with go/parser + go/types (calls between the repository's
// own packages resolve exactly; packages outside the repository are stubbed).
// JavaScript/TypeScript, Python and Rust use token-level analyzers that
// resolve calls through imports, class fields and same-file scope, and fall
// back to unique names. Every call edge says whether it was resolved exactly.
package flow

import (
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"

	"github.com/justinclev/codecity/internal/deps"
)

// Version of the graph format.
const Version = 1

// Node kinds.
const (
	KFunc     = "func"     // function / closure handler
	KMethod   = "method"   // method of a class / type (Parent = the class)
	KClass    = "class"    // struct, class, interface, trait, enum (Sub)
	KEndpoint = "endpoint" // HTTP route served (input)
	KCommand  = "command"  // CLI sub-command (input)
	KFlag     = "flag"     // CLI flag (input)
	KEvent    = "event"    // UI event / timer (input)
	KIO       = "io"       // outside world: Sub = process|file|http|db|storage|env|stdio|log|network|args|stdin
	KData     = "data"     // mutable state: struct/class field or module variable
)

// Edge kinds. Direction always follows the flow: inputs → code → outputs.
const (
	ECall    = "call"    // function calls function
	ENew     = "new"     // function creates an instance of a class
	ERef     = "ref"     // function passes another function as a value (callback)
	EImpl    = "impl"    // interface / abstract method → an implementation
	EHandles = "handles" // endpoint / command / event → handler
	EFeeds   = "feeds"   // input source or state → function that reads it
	EWrites  = "writes"  // function → state or sink it writes
	EIO      = "io"      // function → external system it talks to (process, HTTP, database)
	ERequest = "request" // function → endpoint of this code base it requests
)

// Node is one element of the graph.
type Node struct {
	ID       int    `json:"id"`
	Kind     string `json:"kind"`
	Sub      string `json:"sub,omitempty"`
	Name     string `json:"name"`
	Path     string `json:"path,omitempty"` // file
	Start    int    `json:"start,omitempty"`
	End      int    `json:"end,omitempty"`
	Module   string `json:"module,omitempty"` // directory / package
	Parent   int    `json:"parent"`           // class of a method or field, -1 = none
	Lang     string `json:"lang,omitempty"`
	Exported bool   `json:"exported,omitempty"`
	Test     bool   `json:"test,omitempty"`
	Entry    string `json:"entry,omitempty"` // "main" for program entry points
	key      string
}

// Edge is a directed relation; Lines are source lines (in From's file, or the
// registration site for inputs) where it happens.
type Edge struct {
	From  int    `json:"from"`
	To    int    `json:"to"`
	Kind  string `json:"kind"`
	Label string `json:"label,omitempty"`
	Lines []int  `json:"lines,omitempty"`
	Exact bool   `json:"exact,omitempty"` // resolved by types / imports / scope, not by name
	File  string `json:"file,omitempty"`  // where Lines are, when it is not From's file
}

// Stats summarizes the analysis (and how much of it is certain).
type Stats struct {
	Files      int            `json:"files"`
	Functions  int            `json:"functions"`
	Calls      int            `json:"calls"`
	Exact      int            `json:"exact"`
	ByName     int            `json:"byName"`
	Unresolved int            `json:"unresolved"`
	Languages  map[string]int `json:"languages"`
	Truncated  bool           `json:"truncated,omitempty"`
}

// Graph is the analysis result.
type Graph struct {
	Version int     `json:"version"`
	Nodes   []*Node `json:"nodes"`
	Edges   []*Edge `json:"edges"`
	Stats   Stats   `json:"stats"`
	// Commits: the commit each repository was analyzed at (by path prefix; "" for a single repository)
	Commits map[string]string `json:"commits,omitempty"`
	// Requests: every HTTP request whose target is a string (not sent to the viewer).
	Requests []Request `json:"-"`
}

// Request is an outgoing HTTP call with a known target.
type Request struct {
	Path   string // file the call is in
	Method string
	URL    string
	Line   int
}

// Route is an HTTP route served by a handler in Path.
type Route struct {
	Path   string
	Method string
	Route  string
}

// Routes lists the HTTP routes the graph serves and the file of the handler.
func (g *Graph) Routes() []Route {
	byID := make(map[int]*Node, len(g.Nodes))
	for _, n := range g.Nodes {
		byID[n.ID] = n
	}
	var out []Route
	seen := map[Route]bool{}
	for _, e := range g.Edges {
		from, to := byID[e.From], byID[e.To]
		if e.Kind != EHandles || from == nil || to == nil || from.Kind != KEndpoint || to.Path == "" {
			continue
		}
		route := from.Name
		if from.Sub != "" && from.Sub != "ANY" {
			route = strings.TrimSpace(strings.TrimPrefix(route, from.Sub))
		}
		r := Route{Path: to.Path, Method: from.Sub, Route: route}
		if !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	return out
}

// Match reports how specifically a request (method, url) matches a served route (higher = more
// specific; ok = false when it does not match), and the host part of the request URL.
func Match(method, route, reqMethod, url string) (score int, host string, ok bool) {
	re := routeRegexp(route)
	if re == nil {
		return 0, "", false
	}
	p, host := normURL(url)
	if method != "" && method != "ANY" && reqMethod != "" && method != reqMethod {
		return 0, host, false
	}
	if !re.MatchString(strings.ReplaceAll(p, "\x00", "x")) {
		return 0, host, false
	}
	score = len(routeParam.ReplaceAllString(route, ""))*2 + map[bool]int{true: 1}[method != "" && method == reqMethod]
	return score, host, true
}

// Repo is one repository's files (multi-repo worlds prefix paths with "name/").
type Repo struct {
	Prefix string
	Commit string
	Files  []File
}

// File is one source file to analyze.
type File struct {
	Path    string // repository-relative
	Lang    string // scan.Language
	Content []byte
}

// Options tune Build.
type Options struct {
	Prefix   string // prepended to paths and keys (multi-repo worlds: "repo/")
	MaxNodes int    // stop adding code nodes beyond this (0 = 60000)
}

type pendingReq struct {
	from   *Node
	method string
	url    string
	line   int
	file   string
}

type builder struct {
	g        *Graph
	byKey    map[string]*Node
	edges    map[edgeKey]*Edge
	requests []pendingReq
	opt      Options
	full     bool
}

type edgeKey struct {
	from, to    int
	kind, label string
}

func newBuilder(opt Options) *builder {
	if opt.MaxNodes <= 0 {
		opt.MaxNodes = 60000
	}
	return &builder{g: &Graph{Version: Version, Stats: Stats{Languages: map[string]int{}}}, byKey: map[string]*Node{}, edges: map[edgeKey]*Edge{}, opt: opt}
}

// node returns the node for key, creating it from tmpl if needed.
func (b *builder) node(key string, tmpl Node) *Node {
	key = b.opt.Prefix + key
	if n := b.byKey[key]; n != nil {
		// a declaration may arrive after a forward reference created a stub
		if n.Path == "" && tmpl.Path != "" {
			n.Path, n.Start, n.End, n.Module, n.Lang = b.p(tmpl.Path), tmpl.Start, tmpl.End, b.p(tmpl.Module), tmpl.Lang
			n.Exported, n.Test, n.Sub = tmpl.Exported, tmpl.Test, firstNonEmpty(n.Sub, tmpl.Sub)
			if tmpl.Parent >= 0 {
				n.Parent = tmpl.Parent
			}
		}
		return n
	}
	if len(b.g.Nodes) >= b.opt.MaxNodes && (tmpl.Kind == KFunc || tmpl.Kind == KMethod || tmpl.Kind == KData) {
		b.full = true
		return nil
	}
	n := tmpl
	n.ID = len(b.g.Nodes)
	n.key = key
	if tmpl.Path != "" {
		n.Path = b.p(tmpl.Path)
	}
	if tmpl.Module != "" || tmpl.Path != "" {
		n.Module = b.p(firstNonEmpty(tmpl.Module, dirOf(tmpl.Path)))
	}
	if n.Parent == 0 && tmpl.Kind != KMethod && tmpl.Kind != KData {
		n.Parent = -1
	}
	b.g.Nodes = append(b.g.Nodes, &n)
	b.byKey[key] = &n
	return &n
}

func (b *builder) lookup(key string) *Node { return b.byKey[b.opt.Prefix+key] }

func (b *builder) p(s string) string {
	if s == "" || b.opt.Prefix == "" {
		return s
	}
	return b.opt.Prefix + s
}

// edge adds (or merges into) an edge.
func (b *builder) edge(from, to *Node, kind, label string, line int, exact bool) *Edge {
	if from == nil || to == nil || (from == to && kind == ECall) {
		return nil
	}
	k := edgeKey{from.ID, to.ID, kind, label}
	e := b.edges[k]
	if e == nil {
		e = &Edge{From: from.ID, To: to.ID, Kind: kind, Label: label, Exact: exact}
		b.edges[k] = e
		b.g.Edges = append(b.g.Edges, e)
	}
	if exact {
		e.Exact = true
	}
	if line > 0 && len(e.Lines) < 24 {
		dup := false
		for _, l := range e.Lines {
			if l == line {
				dup = true
				break
			}
		}
		if !dup {
			e.Lines = append(e.Lines, line)
		}
	}
	return e
}

// ---------------------------------------------------------------- inputs and outputs

// io returns the node for an outside-world element.
func (b *builder) io(sub, name string) *Node {
	// the outside world is shared: two repositories writing the same table meet at one node
	prefix := b.opt.Prefix
	b.opt.Prefix = ""
	defer func() { b.opt.Prefix = prefix }()
	return b.node("io:"+sub+":"+name, Node{Kind: KIO, Sub: sub, Name: name})
}

// sink: code → outside (writes); source: outside → code (feeds); call: code ⇄ external system (io).
func (b *builder) sink(from *Node, sub, name, label string, line int) {
	b.edge(from, b.io(sub, name), EWrites, label, line, true)
}
func (b *builder) source(from *Node, sub, name, label string, line int) {
	b.edge(b.io(sub, name), from, EFeeds, label, line, true)
}
func (b *builder) external(from *Node, sub, name, label string, line int) {
	b.edge(from, b.io(sub, name), EIO, label, line, true)
}

func (b *builder) endpoint(method, route string) *Node {
	method = strings.ToUpper(method)
	name := route
	if method != "" && method != "ANY" {
		name = method + " " + route
	}
	return b.node("endpoint:"+name, Node{Kind: KEndpoint, Sub: method, Name: name})
}

func (b *builder) request(from *Node, method, url string, line int, file string) {
	if from == nil || url == "" {
		return
	}
	b.requests = append(b.requests, pendingReq{from, strings.ToUpper(method), url, line, file})
}

var (
	sqlStart  = regexp.MustCompile(`(?is)^\s*(select|insert|update|delete|with|create|alter|drop|replace|upsert|merge)\b`)
	sqlRead   = regexp.MustCompile(`(?i)\b(?:from|join)\s+([A-Za-z_"` + "`" + `\[][\w."` + "`" + `\]]*)`)
	sqlInsert = regexp.MustCompile(`(?i)\b(?:insert\s+(?:or\s+\w+\s+)?into|replace\s+into|merge\s+into)\s+([A-Za-z_"` + "`" + `\[][\w."` + "`" + `\]]*)`)
	sqlUpdate = regexp.MustCompile(`(?i)\bupdate\s+([A-Za-z_"` + "`" + `\[][\w."` + "`" + `\]]*)\s+set\b`)
	sqlDelete = regexp.MustCompile(`(?i)\bdelete\s+from\s+([A-Za-z_"` + "`" + `\[][\w."` + "`" + `\]]*)`)
	sqlDDL    = regexp.MustCompile(`(?i)\b(?:create|alter|drop)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?([A-Za-z_"` + "`" + `\[][\w."` + "`" + `\]]*)`)
)

// sql records the tables a SQL string reads and writes, from function from.
func (b *builder) sql(from *Node, s string, line int) bool {
	if from == nil || !sqlStart.MatchString(s) || len(s) < 12 {
		return false
	}
	clean := func(t string) string { return strings.Trim(t, "\"`[]") }
	verb := strings.ToUpper(sqlStart.FindStringSubmatch(s)[1])
	wrote := map[string]bool{}
	for _, re := range []*regexp.Regexp{sqlInsert, sqlUpdate, sqlDelete, sqlDDL} {
		for _, m := range re.FindAllStringSubmatch(s, -1) {
			t := clean(m[1])
			if t != "" && !wrote[t] {
				wrote[t] = true
				b.edge(from, b.io("db", t), EIO, verb, line, true)
			}
		}
	}
	any := len(wrote) > 0
	if verb == "DELETE" {
		return any
	}
	for _, m := range sqlRead.FindAllStringSubmatch(s, -1) {
		t := clean(m[1])
		if t == "" || wrote[t] || strings.HasPrefix(t, "(") || strings.EqualFold(t, "select") {
			continue
		}
		b.edge(from, b.io("db", t), EIO, "SELECT", line, true)
		any = true
	}
	return any
}

// ---------------------------------------------------------------- finishing

var routeParam = regexp.MustCompile(`\{[^}/]+\}|:[A-Za-z_]\w*|<[^>/]+>|\*\w*`)

// normURL turns a request target into a comparable path ("" if not a path of this service).
func normURL(u string) (path string, host string) {
	u = strings.TrimSpace(u)
	if i := strings.IndexAny(u, "?#"); i >= 0 {
		u = u[:i]
	}
	if strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://") {
		rest := u[strings.Index(u, "//")+2:]
		h, p, _ := strings.Cut(rest, "/")
		if strings.Contains(h, "${") || strings.Contains(h, "\x00") {
			h = "(dynamic host)"
		}
		return "/" + p, h
	}
	return u, ""
}

func routeRegexp(route string) *regexp.Regexp {
	// Go 1.22 patterns: "GET example.com/x/{id}" — the path part only
	if i := strings.Index(route, "/"); i > 0 && !strings.HasPrefix(route, "/") {
		route = route[i:]
	}
	var sb strings.Builder
	sb.WriteString("^")
	last := 0
	for _, m := range routeParam.FindAllStringIndex(route, -1) {
		sb.WriteString(regexp.QuoteMeta(route[last:m[0]]))
		if strings.HasPrefix(route[m[0]:m[1]], "*") || strings.HasSuffix(route[m[0]:m[1]], "...}") {
			sb.WriteString(".*")
		} else {
			sb.WriteString(`[^/]+`)
		}
		last = m[1]
	}
	sb.WriteString(regexp.QuoteMeta(route[last:]))
	if strings.HasSuffix(route, "/") {
		sb.WriteString(".*") // "/static/" serves a subtree
	}
	sb.WriteString("/?$")
	re, err := regexp.Compile(sb.String())
	if err != nil {
		return nil
	}
	return re
}

// finish links requests to served endpoints, drops state nobody writes, and computes stats.
func (b *builder) finish() *Graph {
	type ep struct {
		n      *Node
		method string
		re     *regexp.Regexp
	}
	var eps []ep
	for _, n := range b.g.Nodes {
		if n.Kind != KEndpoint {
			continue
		}
		route := n.Name
		if n.Sub != "" && n.Sub != "ANY" {
			route = strings.TrimSpace(strings.TrimPrefix(route, n.Sub))
		}
		if re := routeRegexp(route); re != nil {
			eps = append(eps, ep{n, n.Sub, re})
		}
	}
	for _, r := range b.requests {
		b.g.Requests = append(b.g.Requests, Request{Path: firstNonEmpty(r.file, r.from.Path), Method: r.method, URL: r.url, Line: r.line})
		p, host := normURL(r.url)
		probe := strings.ReplaceAll(p, "\x00", "x") // template holes
		matched := false
		if host == "" || host == "localhost" || strings.HasPrefix(host, "127.0.0.1") {
			// the most specific route wins: "/" serving static files must not swallow "/api/x"
			best, bestScore := []ep(nil), -1
			for _, e := range eps {
				if (e.method == "" || e.method == "ANY" || r.method == "" || e.method == r.method) && e.re.MatchString(probe) {
					score := len(routeParam.ReplaceAllString(e.n.Name, ""))*2 + map[bool]int{true: 1}[e.method != "" && e.method == r.method]
					if score > bestScore {
						best, bestScore = []ep{e}, score
					} else if score == bestScore {
						best = append(best, e)
					}
				}
			}
			for _, e := range best {
				if ed := b.edge(r.from, e.n, ERequest, r.method, r.line, true); ed != nil && r.file != "" && r.file != r.from.Path {
					ed.File = r.file
				}
				matched = true
			}
		}
		if matched {
			continue
		}
		name := host
		if name == "" {
			name = strings.ReplaceAll(firstSegments(p, 2), "\x00", "*")
			if name == "" || name == "/" {
				continue
			}
		}
		b.external(r.from, "http", name, firstNonEmpty(r.method, "GET"), r.line)
	}

	// state nobody (outside construction) writes is configuration, not flow
	written := map[int]bool{}
	for _, e := range b.g.Edges {
		if e.Kind == EWrites {
			written[e.To] = true
		}
	}
	drop := map[int]bool{}
	for _, n := range b.g.Nodes {
		if n.Kind == KData && !written[n.ID] {
			drop[n.ID] = true
		}
	}
	if len(drop) > 0 {
		b.compact(drop)
	}

	st := &b.g.Stats
	st.Truncated = b.full
	for _, n := range b.g.Nodes {
		if n.Kind == KFunc || n.Kind == KMethod {
			st.Functions++
		}
	}
	for _, e := range b.g.Edges {
		if e.Kind == ECall {
			st.Calls++
			if e.Exact {
				st.Exact++
			} else {
				st.ByName++
			}
		}
		sort.Ints(e.Lines)
	}
	return b.g
}

// compact removes nodes (and their edges) and renumbers.
func (b *builder) compact(drop map[int]bool) {
	remap := make([]int, len(b.g.Nodes))
	var nodes []*Node
	for i, n := range b.g.Nodes {
		if drop[i] {
			remap[i] = -1
			delete(b.byKey, n.key)
			continue
		}
		remap[i] = len(nodes)
		nodes = append(nodes, n)
	}
	for _, n := range nodes {
		n.ID = remap[n.ID]
		if n.Parent >= 0 {
			n.Parent = remap[n.Parent]
		}
	}
	var edges []*Edge
	b.edges = map[edgeKey]*Edge{}
	for _, e := range b.g.Edges {
		if remap[e.From] < 0 || remap[e.To] < 0 {
			continue
		}
		e.From, e.To = remap[e.From], remap[e.To]
		edges = append(edges, e)
		b.edges[edgeKey{e.From, e.To, e.Kind, e.Label}] = e
	}
	b.g.Nodes, b.g.Edges = nodes, edges
}

// ---------------------------------------------------------------- helpers

func dirOf(p string) string {
	d := path.Dir(p)
	if d == "." {
		return ""
	}
	return d
}

func firstNonEmpty(s ...string) string {
	for _, x := range s {
		if x != "" {
			return x
		}
	}
	return ""
}

func firstSegments(p string, n int) string {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	if len(parts) > n {
		parts = parts[:n]
	}
	return "/" + strings.Join(parts, "/")
}

func isTestPath(p string) bool {
	b := path.Base(p)
	return strings.HasSuffix(b, "_test.go") || strings.Contains(b, ".test.") || strings.Contains(b, ".spec.") ||
		strings.HasPrefix(b, "test_") || strings.HasSuffix(b, "_test.py") || strings.Contains("/"+p, "/__tests__/") ||
		strings.Contains("/"+p, "/tests/") || strings.Contains("/"+p, "/test/")
}

// Build analyzes one repository's files and returns the graph.
func Build(files []File, opt Options) *Graph {
	return BuildAll([]Repo{{Prefix: opt.Prefix, Files: files}}, opt)
}

// BuildAll analyzes several repositories into one graph, so requests in one can reach routes served by another.
func BuildAll(repos []Repo, opt Options) *Graph {
	b := newBuilder(opt)
	b.g.Commits = map[string]string{}
	for _, r := range repos {
		b.opt.Prefix = r.Prefix
		if r.Commit != "" {
			b.g.Commits[r.Prefix] = r.Commit
		}
		b.analyze(r.Files)
	}
	b.opt.Prefix = ""
	return b.finish()
}

func (b *builder) analyze(files []File) {
	var goFiles, jsFiles, pyFiles, rsFiles []File
	paths := make([]string, 0, len(files))
	for _, f := range files {
		paths = append(paths, f.Path)
	}
	for _, f := range files {
		switch {
		case strings.HasSuffix(f.Path, ".go"):
			goFiles = append(goFiles, f)
		case f.Lang == "TypeScript" || f.Lang == "JavaScript":
			jsFiles = append(jsFiles, f)
		case f.Lang == "Python":
			pyFiles = append(pyFiles, f)
		case f.Lang == "Rust":
			rsFiles = append(rsFiles, f)
		default:
			continue
		}
		b.g.Stats.Files++
		b.g.Stats.Languages[f.Lang]++
	}
	mods := goModules(files)
	if len(goFiles) > 0 {
		b.analyzeGo(goFiles, mods)
	}
	res := newResolver(files, paths)
	if len(jsFiles) > 0 {
		b.analyzeScript(jsFiles, res)
	}
	if len(pyFiles) > 0 {
		b.analyzePython(pyFiles, res)
	}
	if len(rsFiles) > 0 {
		b.analyzeRust(rsFiles, res)
	}
}

// Wanted reports whether a file takes part in the flow analysis.
func Wanted(p, lang string) bool {
	switch lang {
	case "Go":
		return strings.HasSuffix(p, ".go") || path.Base(p) == "go.mod"
	case "TypeScript", "JavaScript", "Python", "Rust":
		return true
	case "HTML":
		return strings.HasSuffix(p, ".component.html") // Angular templates (event bindings)
	}
	return deps.IsManifest(p)
}

// Summary renders a short text report of a graph (for the CLI).
func Summary(g *Graph) string {
	var sb strings.Builder
	st := g.Stats
	fmt.Fprintf(&sb, "%d files, %d functions, %d calls (%d exact, %d by name)\n", st.Files, st.Functions, st.Calls, st.Exact, st.ByName)
	by := map[string][]*Node{}
	for _, n := range g.Nodes {
		by[n.Kind] = append(by[n.Kind], n)
	}
	deg := map[int]int{}
	for _, e := range g.Edges {
		deg[e.From]++
		deg[e.To]++
	}
	for _, k := range []string{KEndpoint, KCommand, KFlag, KEvent, KIO, KData} {
		if len(by[k]) == 0 {
			continue
		}
		ns := by[k]
		sort.Slice(ns, func(i, j int) bool {
			return deg[ns[i].ID] > deg[ns[j].ID] || deg[ns[i].ID] == deg[ns[j].ID] && ns[i].Name < ns[j].Name
		})
		fmt.Fprintf(&sb, "\n%s (%d)\n", k, len(ns))
		for i, n := range ns {
			if i >= 25 {
				fmt.Fprintf(&sb, "  … %d more\n", len(ns)-i)
				break
			}
			sub := ""
			if n.Sub != "" {
				sub = " [" + n.Sub + "]"
			}
			fmt.Fprintf(&sb, "  %-44s%s  %d edges\n", n.Name, sub, deg[n.ID])
		}
	}
	for _, n := range g.Nodes {
		if n.Entry != "" {
			fmt.Fprintf(&sb, "\nentry: %s (%s) %s:%d", n.Name, n.Entry, n.Path, n.Start)
		}
	}
	sb.WriteString("\n")
	return sb.String()
}
