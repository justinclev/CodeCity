// Package analyze turns a git repo at a ref into a City.
package analyze

import (
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
	Excludes         []string
	IncludeVendored  bool
	IncludeGenerated bool
	MinWeight        float64
}

type file struct {
	path  string
	bytes int64
	m     scan.Metrics
	lang  string
}

// Run opens the source, scans files at the ref and lays out the city.
func Run(o Options) (*city.City, error) {
	repo, err := gitx.Open(o.Source, o.Ref)
	if err != nil {
		return nil, err
	}
	defer repo.Close()
	commit, label, err := repo.Resolve(o.Ref)
	if err != nil {
		return nil, err
	}
	entries, err := repo.ListFiles(commit)
	if err != nil {
		return nil, err
	}
	so := scan.Options{Excludes: o.Excludes, IncludeVendored: o.IncludeVendored, IncludeGenerated: o.IncludeGenerated}
	skipped := map[string]int{}
	var cand []gitx.Entry
	for _, e := range entries {
		if r := scan.PathSkip(e.Path, e.Mode, e.Size, so); r != "" {
			skipped[r]++
			continue
		}
		cand = append(cand, e)
	}
	br, err := repo.NewBlobReader()
	if err != nil {
		return nil, err
	}
	var files []file
	for _, e := range cand {
		b, err := br.Read(e.Oid, scan.DefaultMaxBytes)
		if err != nil {
			br.Close()
			return nil, err
		}
		if r := scan.ContentSkip(b, so); r != "" {
			skipped[r]++
			continue
		}
		files = append(files, file{e.Path, e.Size, scan.Measure(b), scan.Language(e.Path)})
	}
	br.Close()

	c := build(files, o.MinWeight)
	c.Stats.Skipped = skipped
	c.Repo = city.Repo{Name: repo.Name(), Source: o.Source, Remote: repo.Remote(), Ref: label, Commit: commit,
		AnalyzedAt: time.Now().UTC().Format(time.RFC3339)}
	return c, nil
}

type dirNode struct {
	name  string
	path  string
	dirs  map[string]*dirNode
	files []file
}

func build(files []file, minWeight float64) *city.City {
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

	// Layout tree. Each layout.Node maps back to a dir or file via side tables.
	dirOf := map[*layout.Node]*dirNode{}
	fileOf := map[*layout.Node]file{}
	var mk func(d *dirNode, display string) *layout.Node
	mk = func(d *dirNode, display string) *layout.Node {
		n := &layout.Node{Name: display}
		dirOf[n] = d
		for _, f := range d.files {
			ln := &layout.Node{Name: path.Base(f.path), Weight: math.Max(float64(f.m.LOC), 0) + minWeight}
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
			// collapse chains of directories that hold exactly one subdirectory and no files
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

	total := ln.Total()
	side := math.Sqrt(total) * 1.25
	if side < 10 {
		side = 10
	}
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
			if f, ok := fileOf[ch]; ok {
				c.Buildings = append(c.Buildings, city.Building{Path: f.path, Name: ch.Name, District: idx, Lang: f.lang,
					X: r3(ch.Inner.X), Z: r3(ch.Inner.Y), W: r3(ch.Inner.W), D: r3(ch.Inner.H),
					LOC: f.m.LOC, Lines: f.m.Lines, Bytes: f.bytes})
				c.Stats.Files++
				c.Stats.LOC += f.m.LOC
				c.Stats.Lines += f.m.Lines
				c.Stats.Bytes += f.bytes
				ls := c.Stats.Languages[f.lang]
				ls.Files++
				ls.LOC += f.m.LOC
				c.Stats.Languages[f.lang] = ls
			} else {
				emit(ch, idx)
			}
		}
	}
	emit(ln, -1)
	c.Stats.Dirs = len(c.Districts)
	return c
}

func r3(v float64) float64 { return math.Round(v*1000) / 1000 }
