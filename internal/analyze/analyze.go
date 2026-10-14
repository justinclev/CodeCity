// Package analyze turns a git repo (and optionally its history) into a City.
package analyze

import (
	"context"
	"errors"
	"math"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/justinclev/codecity/internal/city"
	"github.com/justinclev/codecity/internal/deps"
	"github.com/justinclev/codecity/internal/flow"
	"github.com/justinclev/codecity/internal/gitx"
	"github.com/justinclev/codecity/internal/layout"
	"github.com/justinclev/codecity/internal/scan"
)

type Options struct {
	Source           string
	Ref              string
	MaxCommits       int // 1 = just the ref's tip; N>1 = sample up to N commits from first-parent history
	Excludes         []string
	IncludeVendored  bool
	IncludeGenerated bool
	MinWeight        float64
	NoChurn          bool // skip change-frequency analysis (allows a shallow clone for MaxCommits == 1)
	Split            bool // split a monolithic repository into one city per project (manifest root)
}

// Progress reports coarse progress; total may be 0 when unknown.
type Progress func(stage string, done, total int)

type blobInfo struct {
	skip string
	m    scan.Metrics
}

type fileHist struct {
	path    string
	lang    string
	weight  int // peak LOC
	pts     []city.Point
	last    city.Point
	churn   [][4]int64
	authors   map[string]int
	docs      []city.DocFile // non-nil: this node is a grouped landmark building (library/plant/port)
	landmark  string         // Building.Landmark: "library" | "plant" | "port"
	shapeKind string         // Shape kind: doc | plant | port
}

// Run opens the source, scans the sampled commits and lays out the city.
func Run(ctx context.Context, o Options, progress Progress) (*city.City, error) {
	cities, repo, err := RunRepoN(ctx, o, progress)
	if repo != nil {
		repo.Close()
	}
	if err != nil {
		return nil, err
	}
	if len(cities) == 1 {
		return cities[0], nil
	}
	return nil, errors.New("source holds several projects; use RunAll and workspace.Build to combine them")
}

// RunAll is like Run but returns every city the source produces (a monorepo
// split yields several), un-merged, so a caller combining multiple sources can
// link them all in one workspace.
func RunAll(ctx context.Context, o Options, progress Progress) ([]*city.City, error) {
	cities, repo, err := RunRepoN(ctx, o, progress)
	if repo != nil {
		repo.Close()
	}
	return cities, err
}

// RunRepo is Run but hands back the open repository (for reading files later);
// the caller must Close it. On error the repository is already closed.
// RunRepoN is Run but hands back the open repository (for reading files later)
// and may return more than one city: when Options.Split is set and the
// repository holds several projects (directories with a build manifest), each
// project becomes its own city and the leftover files become a "root" city, so
// the projects link up as highways exactly like separate repositories. The
// caller must Close the returned repository; on error it is already closed.
func RunRepoN(ctx context.Context, o Options, progress Progress) (cities []*city.City, repo *gitx.Repo, err error) {
	if progress == nil {
		progress = func(string, int, int) {}
	}
	if o.MaxCommits < 1 {
		o.MaxCommits = 1
	}
	progress("opening repository", 0, 0)
	repo, err = gitx.Open(ctx, o.Source, o.Ref, o.MaxCommits == 1 && o.NoChurn)
	if err != nil {
		return nil, nil, err
	}
	opened := repo // named results are overwritten by `return nil, nil, err`
	defer func() {
		if err != nil {
			opened.Close()
			repo = nil
		}
	}()
	tip, label, err := repo.Resolve(ctx, o.Ref)
	if err != nil {
		return nil, nil, err
	}
	n := 0
	if o.MaxCommits == 1 {
		n = 1
	}
	all, err := repo.Log(ctx, tip, n)
	if err != nil {
		return nil, nil, err
	}
	if len(all) == 0 {
		return nil, nil, errors.New("no commits")
	}
	commits := Sample(all, o.MaxCommits)

	so := scan.Options{Excludes: o.Excludes, IncludeVendored: o.IncludeVendored, IncludeGenerated: o.IncludeGenerated}
	br, err := repo.NewBlobReader(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer br.Close()

	cache := map[string]blobInfo{}
	var tipOid map[string]string // path → blob at the newest commit
	hist := map[string]*fileHist{}
	skipped := map[string]int{}
	var order []string

	for ci, c := range commits {
		progress("scanning commits", ci, len(commits))
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		entries, err := repo.ListFiles(ctx, c.Hash)
		if err != nil {
			return nil, nil, err
		}
		isLast := ci == len(commits)-1
		if isLast {
			tipOid = map[string]string{}
		}
		seen := map[string]bool{}
		for _, e := range entries {
			if r := scan.PathSkip(e.Path, e.Mode, e.Size, so); r != "" {
				if isLast {
					skipped[r]++
				}
				continue
			}
			bi, ok := cache[e.Oid]
			if !ok {
				b, err := br.Read(e.Oid, scan.DefaultMaxBytes)
				if err != nil {
					if ctx.Err() != nil {
						return nil, nil, ctx.Err()
					}
					return nil, nil, err
				}
				bi.skip = scan.ContentSkip(b, so)
				if bi.skip == "" {
					bi.m = scan.Measure(b)
				}
				cache[e.Oid] = bi
			}
			if bi.skip != "" {
				if isLast {
					skipped[bi.skip]++
				}
				continue
			}
			seen[e.Path] = true
			if isLast {
				tipOid[e.Path] = e.Oid
			}
			pt := city.Point{ci, bi.m.LOC, bi.m.Lines, int(e.Size), bi.m.Complexity}
			h := hist[e.Path]
			if h == nil {
				h = &fileHist{path: e.Path, lang: scan.Language(e.Path), last: city.Point{-1, city.Absent, 0, 0, 0}}
				hist[e.Path] = h
				order = append(order, e.Path)
			}
			record(h, pt)
		}
		// files that vanished at this commit
		for _, p := range order {
			if h := hist[p]; !seen[p] && h.last[1] != city.Absent {
				record(h, city.Point{ci, city.Absent, 0, 0, 0})
			}
		}
	}

	idxGlobal := make(map[string]int, len(order))
	for i, p := range order {
		idxGlobal[p] = i
	}
	var cd *churnData
	if !o.NoChurn && !repo.IsShallow(ctx) {
		if cd, err = collectChurn(ctx, repo, commits, hist, idxGlobal, progress); err != nil {
			return nil, nil, err
		}
	}
	progress("laying out", 0, 0)

	// decide the projects: the whole repo, unless splitting finds several
	projs := []project{{dir: "", name: repo.Name()}}
	if o.Split {
		tipPaths := make([]string, 0, len(tipOid))
		for p := range tipOid {
			tipPaths = append(tipPaths, p)
		}
		projs = detectProjects(tipPaths, repo.Name())
	}
	groups := groupPaths(order, projs)
	used := projs[:0:0]
	for _, pr := range projs {
		if len(groups[pr.dir]) > 0 {
			used = append(used, pr)
		}
	}
	if len(used) <= 1 { // not a monorepo (or splitting off): one city over everything
		c, err := assembleCity(ctx, br, o, "", repo.Name(), order, hist, tipOid, cd, idxGlobal, commits, repo.Remote(ctx), repo.LocalPath(ctx), tip, label, skipped)
		if err != nil {
			return nil, nil, err
		}
		return []*city.City{c}, repo, nil
	}
	for _, pr := range used {
		sk := map[string]int(nil)
		if pr.dir == "" {
			sk = skipped // the repo-wide skip tally belongs to the root bucket, counted once
		}
		c, err := assembleCity(ctx, br, o, pr.dir, pr.name, groups[pr.dir], hist, tipOid, cd, idxGlobal, commits, repo.Remote(ctx), repo.LocalPath(ctx), tip, label, sk)
		if err != nil {
			return nil, nil, err
		}
		c.Repo.Base = pr.dir
		cities = append(cities, c)
	}
	return cities, repo, nil
}

// assembleCity lays out one city from a subset of the repository's files
// (members, repo-relative paths). When subdir != "" the paths are rebased to
// the project root so the city stands on its own and churn/flow/facts are
// scoped to the project — the basis for linking monorepo projects like repos.
func assembleCity(ctx context.Context, br *gitx.BlobReader, o Options, subdir, name string, members []string,
	hist map[string]*fileHist, tipOid map[string]string, cd *churnData, idxGlobal map[string]int,
	commits []gitx.Commit, remote, localPath, tip, label string, skipped map[string]int) (*city.City, error) {
	strip := func(p string) string {
		if subdir == "" {
			return p
		}
		return strings.TrimPrefix(p, subdir+"/")
	}
	inGroup := make(map[string]bool, len(members))
	for _, p := range members {
		inGroup[p] = true
	}
	// rebased file history + tip blobs for this project
	rhist := make(map[string]*fileHist, len(members))
	rtip := make(map[string]string, len(members))
	files := make([]*fileHist, 0, len(members))
	for _, p := range membersInScanOrder(members, idxGlobal) {
		h := hist[p]
		nh := *h
		nh.path = strip(p)
		rhist[nh.path] = &nh
		files = append(files, &nh)
		if oid, ok := tipOid[p]; ok {
			rtip[nh.path] = oid
		}
	}
	pre, err := readFlow(ctx, br, files, rtip)
	if err != nil {
		return nil, err
	}
	extDeps := externalDeps(br, rtip, files)
	c := build(files, o.MinWeight, pre.bias, extDeps)
	if c.Facts, err = collectFacts(ctx, br, c, rtip, remote, pre.g); err != nil {
		return nil, err
	}
	if cd != nil {
		c.HasChurn = true
		// contributors scoped to this project's files (so people-links mean something)
		c.Facts.Authors = map[string]int{}
		for _, h := range rhist {
			for a, k := range h.authors {
				c.Facts.Authors[a] += k
			}
		}
		assignOwners(c, rhist, cd.authors)
		// coupling re-indexed onto this project's local file order
		localOrder := make([]string, 0, len(files))
		g2l := make(map[int]int, len(files))
		for _, f := range files {
			g2l[idxGlobal[joinSub(subdir, f.path)]] = len(localOrder)
			localOrder = append(localOrder, f.path)
		}
		scd := &churnData{authors: cd.authors, pairs: map[[2]int]int{}, revs: map[int]int{}}
		for gi, li := range g2l {
			scd.revs[li] = cd.revs[gi]
		}
		for pr, k := range cd.pairs {
			a, oka := g2l[pr[0]]
			b, okb := g2l[pr[1]]
			if oka && okb {
				if a > b {
					a, b = b, a
				}
				scd.pairs[[2]int{a, b}] = k
			}
		}
		assignCoupling(c, localOrder, scd)
	}
	if skipped == nil {
		skipped = map[string]int{}
	}
	c.Stats.Skipped = skipped
	for _, k := range commits {
		c.Commits = append(c.Commits, city.Commit{Hash: k.Hash, Date: k.Date, Author: k.Author, Subject: k.Subject})
	}
	c.Repo = city.Repo{Name: name, Source: o.Source, Remote: remote, Path: localPath, Base: subdir, Ref: label, Commit: tip,
		AnalyzedAt: time.Now().UTC().Format(time.RFC3339)}
	_ = inGroup
	return c, nil
}

// order returns the members sorted by their global scan order, for stable layout.
func membersInScanOrder(members []string, idxGlobal map[string]int) []string {
	out := append([]string(nil), members...)
	sort.Slice(out, func(i, j int) bool { return idxGlobal[out[i]] < idxGlobal[out[j]] })
	return out
}

// joinSub re-prefixes a project-relative path with its subdir (inverse of strip).
func joinSub(subdir, rel string) string {
	if subdir == "" {
		return rel
	}
	return subdir + "/" + rel
}

// externalDeps reads the project's manifests at the newest commit and returns its
// declared third-party dependencies (one DocFile per dependency: Name + ecosystem
// in Lang), deduped and sorted. These populate the grouped "power plant" building.
func externalDeps(br *gitx.BlobReader, tipOid map[string]string, files []*fileHist) []city.DocFile {
	seen := map[string]bool{}
	var out []city.DocFile
	for _, f := range files {
		if !deps.IsManifest(f.path) {
			continue
		}
		oid, ok := tipOid[f.path]
		if !ok {
			continue
		}
		content, err := br.Read(oid, scan.DefaultMaxBytes)
		if err != nil {
			continue
		}
		_, ds := deps.Manifest(f.path, content)
		for _, d := range ds {
			if d.Kind == deps.Git || d.Name == "" {
				continue
			}
			key := d.Kind + ":" + d.Name
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, city.DocFile{Name: d.Name, Lang: d.Kind})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Lang != out[j].Lang {
			return out[i].Lang < out[j].Lang
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// collectFacts reads manifests and import statements at the newest commit,
// and resolves imports between files of this repository (Building.Imp/ImpD).
func collectFacts(ctx context.Context, br *gitx.BlobReader, c *city.City, tipOid map[string]string, remote string, g *flow.Graph) (*city.Facts, error) {
	f := &city.Facts{Remote: deps.NormalizeURL(remote), Imports: map[int][]string{}}
	var paths []string
	local := map[int][]string{}
	var netFiles []netFile
	netBytes := 0
	for i, b := range c.Buildings {
		oid, ok := tipOid[b.Path]
		if !ok {
			continue
		}
		paths = append(paths, b.Path)
		manifest := deps.IsManifest(b.Path)
		code := importLangs[b.Lang]
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		content, err := br.Read(oid, scan.DefaultMaxBytes)
		if err != nil {
			return nil, err
		}
		c.Buildings[i].Shape = shapeOf(b.Path, b.Lang, content)
		if wantNet(b.Path) && len(content) <= 400<<10 && netBytes+len(content) <= maxRoleBytes {
			netFiles = append(netFiles, netFile{b.Path, content})
			netBytes += len(content)
		}
		if !manifest && !code {
			continue
		}
		if manifest {
			ids, ds := deps.Manifest(b.Path, content)
			f.Identities = append(f.Identities, ids...)
			f.Deps = append(f.Deps, ds...)
		}
		if code {
			if specs := deps.Imports(b.Lang, content); len(specs) > 0 {
				sort.Strings(specs)
				f.Imports[i] = specs
			}
			if specs := deps.LocalImports(b.Lang, content); len(specs) > 0 {
				local[i] = specs
			}
		}
	}
	f.Identities = append(f.Identities, deps.PythonModules(paths)...)
	if f.Remote != "" {
		f.Identities = append(f.Identities, deps.Identity{Kind: deps.Git, Name: f.Remote})
	}

	assignRolesFrom(c, g, f)
	networkFacts(c, f, netFiles)

	// resolve imports inside this repository
	res := deps.NewResolver(paths, f.Identities)
	byPath := make(map[string]int, len(c.Buildings))
	for i, b := range c.Buildings {
		byPath[b.Path] = i
	}
	dirDistrict := map[string]int{}
	for i, d := range c.Districts {
		dirDistrict[d.Path] = i
	}
	for i, specs := range local {
		b := &c.Buildings[i]
		seenB, seenD := map[int]bool{}, map[int]bool{}
		for _, spec := range specs {
			t, ok := res.Resolve(b.Path, b.Lang, spec)
			if !ok {
				continue
			}
			if !t.Dir {
				if j, ok := byPath[t.Path]; ok && j != i && !seenB[j] {
					seenB[j] = true
					b.Imp = append(b.Imp, j)
				}
				continue
			}
			d := districtOf(c, dirDistrict, t.Path)
			if d >= 0 && d != b.District && !seenD[d] {
				seenD[d] = true
				b.ImpD = append(b.ImpD, d)
			}
		}
		sort.Ints(b.Imp)
		sort.Ints(b.ImpD)
	}
	return f, nil
}

// Limits for the flow analysis behind rooftop roles (same order as the server's flow view).
const (
	maxRoleFiles = 25000
	maxRoleBytes = 96 << 20
)

var importLangs = map[string]bool{"Go": true, "JavaScript": true, "TypeScript": true, "Python": true, "Rust": true, "Vue": true, "Svelte": true}

// districtOf finds the district for a directory: exact match, else the
// collapsed chain that contains it, else the deepest ancestor (-1 if none).
func districtOf(c *city.City, byPath map[string]int, dir string) int {
	if d, ok := byPath[dir]; ok {
		return d
	}
	best, bestLen := -1, -1
	for i, d := range c.Districts {
		if d.Path == "" {
			continue
		}
		if strings.HasPrefix(d.Path, dir+"/") && (bestLen < 0 || len(d.Path) < bestLen) { // collapsed "a/b/c" for "a/b"
			best, bestLen = i, len(d.Path)
		}
	}
	if best >= 0 {
		return best
	}
	for p := dir; p != "." && p != "" && p != "/"; p = path.Dir(p) {
		if d, ok := byPath[p]; ok {
			return d
		}
	}
	return -1
}

// record appends pt to h if it differs from the previous state.
func record(h *fileHist, pt city.Point) {
	if h.last[1] == pt[1] && h.last[2] == pt[2] && h.last[3] == pt[3] && h.last[4] == pt[4] {
		return
	}
	h.pts = append(h.pts, pt)
	h.last = pt
	if pt[1] > h.weight {
		h.weight = pt[1]
	}
}

// Sample picks at most max commits evenly (always keeping the first and last).
func Sample(all []gitx.Commit, max int) []gitx.Commit {
	if max < 1 {
		max = 1
	}
	if len(all) <= max {
		return all
	}
	if max == 1 {
		return all[len(all)-1:]
	}
	out := make([]gitx.Commit, 0, max)
	last := -1
	for i := 0; i < max; i++ {
		idx := int(math.Round(float64(i) * float64(len(all)-1) / float64(max-1)))
		if idx != last {
			out = append(out, all[idx])
			last = idx
		}
	}
	return out
}

type dirNode struct {
	name  string
	path  string
	dirs  map[string]*dirNode
	files []*fileHist
}

// bias (optional) pulls entrance files toward the north edge of their district and exit files toward the south.
// i18nExt are localization resource formats that stand on their own, by extension.
var i18nExt = map[string]bool{".po": true, ".mo": true, ".pot": true, ".resx": true, ".ftl": true, ".arb": true, ".xliff": true, ".xlf": true}

var i18nDir = regexp.MustCompile(`(?:^|/)(?:locales?|i18n|translations?|lang|resources)(?:/|$)`)
var localeName = regexp.MustCompile(`(?:^|[._-])(?:[a-z]{2})(?:[._-][A-Z]{2})?\.(?:properties|json|ya?ml)$`)

// i18nFile reports whether a path is a localization resource by each ecosystem's
// convention: a dedicated format anywhere (.po/.mo/.resx/.ftl/.arb/.xliff), or a
// properties/json/yaml locale file under a locale/i18n/translations folder.
func i18nFile(p string) bool {
	ext := strings.ToLower(path.Ext(p))
	if i18nExt[ext] {
		return true
	}
	if i18nDir.MatchString(p) && (ext == ".json" || ext == ".yaml" || ext == ".yml" || ext == ".properties") {
		return true
	}
	return localeName.MatchString(path.Base(p)) // messages_en.properties, en.json, de-DE.yaml
}

// docsDir reports whether a directory subtree is prose-only (Markdown/Text) with
// at least one file; such a folder is shown as a single "library" building.
func docsDir(d *dirNode) bool {
	any := false
	var walk func(*dirNode) bool
	walk = func(n *dirNode) bool {
		for _, f := range n.files {
			if !docLangs[f.lang] {
				return false
			}
			any = true
		}
		for _, sub := range n.dirs {
			if !walk(sub) {
				return false
			}
		}
		return true
	}
	return walk(d) && any
}

// collectDocFiles returns every file in a subtree, sorted by path.
func collectDocFiles(d *dirNode) []*fileHist {
	var out []*fileHist
	var walk func(*dirNode)
	walk = func(n *dirNode) {
		out = append(out, n.files...)
		keys := make([]string, 0, len(n.dirs))
		for k := range n.dirs {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			walk(n.dirs[k])
		}
	}
	walk(d)
	sort.Slice(out, func(i, j int) bool { return out[i].path < out[j].path })
	return out
}

// locAt returns the LOC/lines/bytes of a file at commit ci and whether it was
// present then (its change points are sparse: the last point at or before ci wins).
func locAt(f *fileHist, ci int) (loc, lines, bytes int, present bool) {
	cur := city.Point{-1, city.Absent, 0, 0, 0}
	for _, p := range f.pts {
		if p[0] > ci {
			break
		}
		cur = p
	}
	if cur[1] == city.Absent {
		return 0, 0, 0, false
	}
	return cur[1], cur[2], cur[3], true
}

// docFolder builds a collapsed docs folder (a library landmark) rooted at dir.
func docFolder(dir string, docs []*fileHist, nCommits int) *fileHist {
	h := landmarkFolder(dir, "Markdown", city.ShapeDoc, docs, nil, 0)
	for i := range h.docs { // documents are named relative to their folder
		h.docs[i].Name = strings.TrimPrefix(h.docs[i].Path, dir+"/")
	}
	return h
}

// landmarkFolder builds a grouped landmark building's synthetic history and item
// list. With files (docs / localization) its size sums theirs over time and each
// file is an openable item; with items (dependencies) it is present at a fixed
// size and the items are not openable.
func landmarkFolder(dirPath, lang, shapeKind string, files []*fileHist, items []city.DocFile, weight int) *fileHist {
	h := &fileHist{path: dirPath, lang: lang, last: city.Point{-1, city.Absent, 0, 0, 0},
		shapeKind: shapeKind, landmark: landmarkName(shapeKind)}
	if len(files) > 0 {
		nCommits := 0
		for _, f := range files {
			for _, p := range f.pts {
				if p[0]+1 > nCommits {
					nCommits = p[0] + 1
				}
			}
		}
		for ci := 0; ci < nCommits; ci++ {
			loc, lines, bytes, present := 0, 0, 0, false
			for _, f := range files {
				if l, ln, by, ok := locAt(f, ci); ok {
					loc += l
					lines += ln
					bytes += by
					present = true
				}
			}
			if present {
				record(h, city.Point{ci, loc, lines, bytes, 0})
			} else {
				record(h, city.Point{ci, city.Absent, 0, 0, 0})
			}
		}
		for _, f := range files {
			h.docs = append(h.docs, city.DocFile{Name: path.Base(f.path), Path: f.path, Lang: f.lang})
		}
	} else { // dependencies: fixed presence, listed but not openable
		if weight < 8 {
			weight = 8
		}
		record(h, city.Point{0, weight, 0, 0, 0})
		h.docs = items
	}
	return h
}

// landmarkName maps a Shape kind to the Building.Landmark discriminator.
func landmarkName(shapeKind string) string {
	switch shapeKind {
	case city.ShapePlant:
		return "plant"
	case city.ShapePort:
		return "port"
	default:
		return "library"
	}
}

func build(files []*fileHist, minWeight float64, bias map[string]float64, extDeps []city.DocFile) *city.City {
	if minWeight <= 0 {
		minWeight = 8
	}
	root := &dirNode{dirs: map[string]*dirNode{}}
	var i18n []*fileHist
	for _, f := range files {
		if i18nFile(f.path) {
			i18n = append(i18n, f)
			continue
		}
		parts := strings.Split(f.path, "/")
		d := root
		for i := 0; i < len(parts)-1; i++ {
			nd := d.dirs[parts[i]]
			if nd == nil {
				nd = &dirNode{name: parts[i], path: strings.Join(parts[:i+1], "/"), dirs: map[string]*dirNode{}}
				d.dirs[parts[i]] = nd
			}
			d = nd
		}
		d.files = append(d.files, f)
	}

	nCommits := 0
	for _, f := range files {
		for _, p := range f.pts {
			if p[0]+1 > nCommits {
				nCommits = p[0] + 1
			}
		}
	}

	dirOf := map[*layout.Node]*dirNode{}
	fileOf := map[*layout.Node]*fileHist{}
	var mk func(d *dirNode, display string) *layout.Node
	mk = func(d *dirNode, display string) *layout.Node {
		n := &layout.Node{Name: display}
		dirOf[n] = d
		for _, f := range d.files {
			ln := &layout.Node{Name: path.Base(f.path), Weight: float64(f.weight) + minWeight}
			if b, ok := bias[f.path]; ok {
				ln.Bias, ln.Signal = b, true
			}
			fileOf[ln] = f
			n.Children = append(n.Children, ln)
		}
		names := make([]string, 0, len(d.dirs))
		for k := range d.dirs {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, k := range names {
			sub, disp := d.dirs[k], k
			for len(sub.files) == 0 && len(sub.dirs) == 1 {
				for _, only := range sub.dirs {
					sub = only
				}
				disp += "/" + sub.name
			}
			if docsDir(sub) { // a prose-only folder becomes one library building
				docs := collectDocFiles(sub)
				fh := docFolder(sub.path, docs, nCommits)
				ln := &layout.Node{Name: disp, Weight: float64(fh.weight) + minWeight}
				fileOf[ln] = fh
				n.Children = append(n.Children, ln)
				continue
			}
			n.Children = append(n.Children, mk(sub, disp))
		}
		return n
	}
	ln := mk(root, "")

	// grouped landmarks: one "airport/dock" for all localization resources, one
	// "power plant" for all external dependencies, each listing its items.
	if len(i18n) > 0 {
		fh := landmarkFolder("(localization)", "i18n", city.ShapePort, i18n, nil, 0)
		lnode := &layout.Node{Name: "localization", Weight: float64(fh.weight) + minWeight*2}
		fileOf[lnode] = fh
		ln.Children = append(ln.Children, lnode)
	}
	if len(extDeps) > 0 {
		w := 8 + len(extDeps)*2
		if w > 240 {
			w = 240
		}
		fh := landmarkFolder("(dependencies)", "deps", city.ShapePlant, nil, extDeps, w)
		lnode := &layout.Node{Name: "dependencies", Weight: float64(w) + minWeight*2}
		fileOf[lnode] = fh
		ln.Children = append(ln.Children, lnode)
	}

	side := math.Max(10, math.Sqrt(ln.Total())*1.25)
	layout.Layout(ln, side, side, layout.DefaultOptions)

	c := &city.City{Version: city.Version, Bounds: city.Bounds{W: r3(side), D: r3(side)}}
	c.Stats = city.Stats{Languages: map[string]city.LangStat{}}
	var emit func(n *layout.Node, parent int)
	emit = func(n *layout.Node, parent int) {
		idx := len(c.Districts)
		d := dirOf[n]
		c.Districts = append(c.Districts, city.District{Path: d.path, Name: n.Name, Depth: n.Depth, Parent: parent,
			X: r3(n.Rect.X), Z: r3(n.Rect.Y), W: r3(n.Rect.W), D: r3(n.Rect.H)})
		for _, ch := range n.Children {
			f, ok := fileOf[ch]
			if !ok {
				emit(ch, idx)
				continue
			}
			nb := city.Building{Path: f.path, Name: ch.Name, District: idx, Lang: f.lang,
				X: r3(ch.Inner.X), Z: r3(ch.Inner.Y), W: r3(ch.Inner.W), D: r3(ch.Inner.H), H: f.pts, Churn: f.churn}
			if f.landmark != "" { // a grouped landmark: force its archetype and carry its item list
				nb.Docs = f.docs
				nb.Landmark = f.landmark
				nb.Shape = &city.Shape{Kind: f.shapeKind, Tiers: []int{f.weight}}
			}
			c.Buildings = append(c.Buildings, nb)
			if f.landmark == "" && f.last[1] != city.Absent { // present source file at the newest commit
				c.Stats.Files++
				c.Stats.LOC += f.last[1]
				c.Stats.Lines += f.last[2]
				c.Stats.Bytes += int64(f.last[3])
				ls := c.Stats.Languages[f.lang]
				ls.Files++
				ls.LOC += f.last[1]
				c.Stats.Languages[f.lang] = ls
			}
		}
	}
	emit(ln, -1)
	c.Stats.Dirs = len(c.Districts)
	return c
}

func r3(v float64) float64 { return math.Round(v*1000) / 1000 }
