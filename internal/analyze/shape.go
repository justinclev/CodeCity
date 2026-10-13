package analyze

import (
	"regexp"
	"sort"
	"strings"

	"github.com/justinclev/codecity/internal/city"
	"github.com/justinclev/codecity/internal/flow"
	"github.com/justinclev/codecity/internal/outline"
)

// Architecture: every building's shape comes from its code, never from chance.
//
//   - tiers: the file's dominant declaration groups (a class with its members,
//     a Go type with its methods, a Rust type with its impls), each ≥15% of
//     the file, stacked largest first on a podium holding everything else;
//   - kind: the archetype (tower, slab, glass box of types, data block,
//     library of docs, lattice of tests);
//   - roles: rooftop equipment from the flow analysis (entry point, served
//     routes, database, processes, files, outgoing HTTP calls).

const (
	tierShare = 0.15 // a group needs this share of the file to become a tier
	maxTiers  = 3    // above the podium
)

var dataLangs = map[string]bool{"JSON": true, "YAML": true, "TOML": true, "XML": true, "Config": true, "Protobuf": true, "Terraform": true}
var docLangs = map[string]bool{"Markdown": true, "Text": true}

var testPath = regexp.MustCompile(`(?:_test\.go|\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|/)test_[^/]+\.py|_test\.py|_spec\.rb|Tests?\.(?:cs|java|kt))$|(?:^|/)(?:tests?|__tests__|spec)/`)

var containerKinds = map[string]bool{"class": true, "struct": true, "interface": true, "trait": true, "impl": true,
	"enum": true, "object": true, "module": true, "namespace": true, "record": true, "type": true}

var heading = regexp.MustCompile(`^#{1,2}\s+(\S.*)$`)

// shapeOf derives a file's architecture from its source.
func shapeOf(p, lang string, src []byte) *city.Shape {
	s := &city.Shape{}
	switch {
	case dataLangs[lang]:
		s.Kind = city.ShapeData
	case docLangs[lang]:
		s.Kind = city.ShapeDoc
		docTiers(s, src)
		return s
	case testPath.MatchString(p):
		s.Kind = city.ShapeTest
	}
	pieces := outline.Outline(lang, src)
	type group struct {
		name string
		loc  int
		cont bool // holds a type with members
	}
	var groups []*group
	byName := map[string]*group{}
	total := 0
	funcs, types, decls := 0, 0, 0
	add := func(key, name string, loc int, cont bool) {
		g := byName[key]
		if g == nil {
			g = &group{name: name}
			byName[key] = g
			groups = append(groups, g)
		}
		g.loc += loc
		g.cont = g.cont || cont
	}
	for k, pc := range pieces {
		switch {
		case pc.Kind == "func" || pc.Kind == "method" || pc.Kind == "test":
			funcs++
		case containerKinds[pc.Kind]:
			types++
		}
		if pc.Parent >= 0 { // members belong to their container's group (counted above)
			continue
		}
		total += pc.LOC
		if pc.Kind == "imports" || pc.Kind == "scope" || pc.Kind == "vars" {
			continue
		}
		decls++
		hasKids := false
		for _, c := range pieces[k+1:] {
			if c.Parent == k {
				hasKids = true
				break
			}
		}
		switch {
		case pc.Kind == "method" && strings.Contains(pc.Name, "."): // Go: "Recv.Method" joins its type
			t := pc.Name[:strings.Index(pc.Name, ".")]
			add("t:"+t, t, pc.LOC, true)
		case pc.Kind == "impl": // Rust: "Trait for Type" / "Type<T>" join the type
			t := implTarget(pc.Name)
			add("t:"+t, t, pc.LOC, true)
		case containerKinds[pc.Kind]:
			add("t:"+pc.Name, pc.Name, pc.LOC, hasKids || pc.Kind == "class")
		default:
			add("f:"+pc.Name, pc.Name, pc.LOC, false)
		}
	}
	s.Funcs, s.Types = funcs, types
	if total <= 0 {
		s.Tiers = []int{0}
		return s
	}
	sort.SliceStable(groups, func(a, b int) bool { return groups[a].loc > groups[b].loc })
	base := total
	var upper []*group
	for _, g := range groups {
		if len(upper) == maxTiers || float64(g.loc) < tierShare*float64(total) {
			break
		}
		upper = append(upper, g)
		base -= g.loc
	}
	s.Tiers = []int{base}
	for _, g := range upper {
		s.Tiers = append(s.Tiers, g.loc)
		s.Names = append(s.Names, g.name)
	}
	if s.Kind != "" || lang == "" {
		return s
	}
	switch {
	case funcs == 0 && types > 0:
		s.Kind = city.ShapeTypes
	case len(upper) > 0 && upper[0].cont && float64(upper[0].loc) >= 0.5*float64(total):
		s.Kind = city.ShapeTower
	case decls >= 6 && (len(groups) == 0 || float64(groups[0].loc) < 0.2*float64(total)):
		s.Kind = city.ShapeSlab // one block: no declaration stands out
		s.Tiers, s.Names = []int{total}, nil
	}
	return s
}

// implTarget turns a Rust impl header ("Display for Point<T>", "<T> Stack<T>") into the type name.
func implTarget(h string) string {
	if i := strings.LastIndex(h, " for "); i >= 0 {
		h = h[i+5:]
	}
	h = strings.TrimSpace(h)
	if i := strings.IndexAny(h, "< "); i > 0 {
		h = h[:i]
	}
	if i := strings.LastIndex(h, "::"); i >= 0 {
		h = h[i+2:]
	}
	return h
}

// docTiers: a document's chapters (top-level headings) are its tiers.
func docTiers(s *city.Shape, src []byte) {
	type sec struct {
		name string
		loc  int
	}
	var secs []sec
	cur := sec{}
	inFence := false
	total := 0
	for _, ln := range strings.Split(string(src), "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "```") {
			inFence = !inFence
		}
		if t == "" {
			continue
		}
		total++
		if m := heading.FindStringSubmatch(ln); m != nil && !inFence {
			secs = append(secs, cur)
			cur = sec{name: strings.TrimSpace(m[1])}
		}
		cur.loc++
	}
	secs = append(secs, cur)
	s.Funcs = 0
	s.Types = 0
	if total == 0 {
		s.Tiers = []int{0}
		return
	}
	sort.SliceStable(secs, func(a, b int) bool { return secs[a].loc > secs[b].loc })
	base := total
	s.Tiers = []int{0}
	for _, x := range secs {
		if len(s.Names) == maxTiers || float64(x.loc) < tierShare*float64(total) || x.name == "" {
			continue
		}
		s.Tiers = append(s.Tiers, x.loc)
		s.Names = append(s.Names, x.name)
		base -= x.loc
	}
	s.Tiers[0] = base
}

// roleWanted: files the flow analysis reads.
func roleWanted(p, lang string) bool { return flow.Wanted(p, lang) }

// assignRoles runs the flow analysis over the newest commit's files and marks
// each building with the roles its code plays.
func assignRoles(c *city.City, files []flow.File, f *city.Facts) {
	if len(files) == 0 {
		return
	}
	g := flow.Build(files, flow.Options{})
	byPath := make(map[string]int, len(c.Buildings))
	for i, b := range c.Buildings {
		byPath[b.Path] = i
	}
	roles := map[int]map[string]bool{}
	mark := func(n *flow.Node, role string) {
		if n == nil || n.Path == "" || n.Test {
			return
		}
		i, ok := byPath[n.Path]
		if !ok {
			return
		}
		if roles[i] == nil {
			roles[i] = map[string]bool{}
		}
		roles[i][role] = true
	}
	nodes := make(map[int]*flow.Node, len(g.Nodes))
	for _, n := range g.Nodes {
		nodes[n.ID] = n
		if n.Entry == "main" {
			mark(n, city.RoleEntry)
		}
	}
	for _, e := range g.Edges {
		from, to := nodes[e.From], nodes[e.To]
		if from == nil || to == nil {
			continue
		}
		switch {
		case e.Kind == flow.EHandles && from.Kind == flow.KEndpoint: // HTTP routes (CLI commands are the entry point's)
			mark(to, city.RoleServe)
		case e.Kind == flow.ERequest:
			mark(from, city.RoleCall)
		case to.Kind == flow.KIO:
			ioRole(from, to.Sub, mark)
		case from.Kind == flow.KIO && e.Kind == flow.EFeeds:
			ioRole(to, from.Sub, mark)
		}
	}
	if f != nil {
		linkFacts(f, byPath, g)
	}
	order := []string{city.RoleEntry, city.RoleServe, city.RoleDB, city.RoleExec, city.RoleFiles, city.RoleCall}
	for i, rs := range roles {
		b := &c.Buildings[i]
		if b.Shape == nil {
			continue
		}
		for _, r := range order {
			if rs[r] {
				b.Shape.Roles = append(b.Shape.Roles, r)
			}
		}
	}
}

func ioRole(n *flow.Node, sub string, mark func(*flow.Node, string)) {
	switch sub {
	case "db", "storage":
		mark(n, city.RoleDB)
	case "process":
		mark(n, city.RoleExec)
	case "file":
		mark(n, city.RoleFiles)
	case "http", "network":
		mark(n, city.RoleCall)
	}
}
