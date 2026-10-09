// Package analyze turns a git repo (and optionally its history) into a City.
package analyze

import (
	"context"
	"errors"
	"math"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/justinclev/codecity/internal/city"
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
	authors map[string]int
}

// Run opens the source, scans the sampled commits and lays out the city.
func Run(ctx context.Context, o Options, progress Progress) (*city.City, error) {
	if progress == nil {
		progress = func(string, int, int) {}
	}
	if o.MaxCommits < 1 {
		o.MaxCommits = 1
	}
	progress("opening repository", 0, 0)
	repo, err := gitx.Open(ctx, o.Source, o.Ref, o.MaxCommits == 1 && o.NoChurn)
	if err != nil {
		return nil, err
	}
	defer repo.Close()
	tip, label, err := repo.Resolve(ctx, o.Ref)
	if err != nil {
		return nil, err
	}
	n := 0
	if o.MaxCommits == 1 {
		n = 1
	}
	all, err := repo.Log(ctx, tip, n)
	if err != nil {
		return nil, err
	}
	if len(all) == 0 {
		return nil, errors.New("no commits")
	}
	commits := Sample(all, o.MaxCommits)

	so := scan.Options{Excludes: o.Excludes, IncludeVendored: o.IncludeVendored, IncludeGenerated: o.IncludeGenerated}
	br, err := repo.NewBlobReader(ctx)
	if err != nil {
		return nil, err
	}
	defer br.Close()

	cache := map[string]blobInfo{}
	hist := map[string]*fileHist{}
	skipped := map[string]int{}
	var order []string

	for ci, c := range commits {
		progress("scanning commits", ci, len(commits))
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		entries, err := repo.ListFiles(ctx, c.Hash)
		if err != nil {
			return nil, err
		}
		isLast := ci == len(commits)-1
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
						return nil, ctx.Err()
					}
					return nil, err
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

	var cd *churnData
	if !o.NoChurn && !repo.IsShallow(ctx) {
		idx := make(map[string]int, len(order))
		for i, p := range order {
			idx[p] = i
		}
		if cd, err = collectChurn(ctx, repo, commits, hist, idx, progress); err != nil {
			return nil, err
		}
	}
	progress("laying out", 0, 0)

	files := make([]*fileHist, 0, len(order))
	for _, p := range order {
		files = append(files, hist[p])
	}
	c := build(files, o.MinWeight)
	if cd != nil {
		c.HasChurn = true
		assignOwners(c, hist, cd.authors)
		assignCoupling(c, order, cd)
	}
	c.Stats.Skipped = skipped
	for _, k := range commits {
		c.Commits = append(c.Commits, city.Commit(k))
	}
	c.Repo = city.Repo{Name: repo.Name(), Source: o.Source, Remote: repo.Remote(ctx), Path: repo.LocalPath(ctx), Ref: label, Commit: tip,
		AnalyzedAt: time.Now().UTC().Format(time.RFC3339)}
	return c, nil
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

func build(files []*fileHist, minWeight float64) *city.City {
	if minWeight <= 0 {
		minWeight = 8
	}
	root := &dirNode{dirs: map[string]*dirNode{}}
	for _, f := range files {
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

	dirOf := map[*layout.Node]*dirNode{}
	fileOf := map[*layout.Node]*fileHist{}
	var mk func(d *dirNode, display string) *layout.Node
	mk = func(d *dirNode, display string) *layout.Node {
		n := &layout.Node{Name: display}
		dirOf[n] = d
		for _, f := range d.files {
			ln := &layout.Node{Name: path.Base(f.path), Weight: float64(f.weight) + minWeight}
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
			n.Children = append(n.Children, mk(sub, disp))
		}
		return n
	}
	ln := mk(root, "")

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
			c.Buildings = append(c.Buildings, city.Building{Path: f.path, Name: ch.Name, District: idx, Lang: f.lang,
				X: r3(ch.Inner.X), Z: r3(ch.Inner.Y), W: r3(ch.Inner.W), D: r3(ch.Inner.H), H: f.pts, Churn: f.churn})
			if f.last[1] != city.Absent { // present at the newest commit
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
