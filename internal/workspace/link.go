// Package workspace combines several analyzed repositories into one world:
// it links them by evidence (declared dependencies, imports, shared people),
// arranges the cities on a shared ground and merges them into a single City.
package workspace

import (
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/justinclev/codecity/internal/city"
	"github.com/justinclev/codecity/internal/deps"
)

// maxFileLinks caps the per-file import pairs kept for one link.
const maxFileLinks = 400

// link computes the evidence that repo a depends on repo b (nil if none).
func link(a, b *city.City, ai, bi int) *city.Link {
	if a.Facts == nil || b.Facts == nil {
		return nil
	}
	l := &city.Link{From: ai, To: bi, Kind: "dependency"}
	seen := map[string]bool{}
	note := func(s string) {
		if !seen[s] && len(l.Evidence) < 24 {
			seen[s] = true
			l.Evidence = append(l.Evidence, s)
		}
	}
	for _, id := range b.Facts.Identities {
		for _, d := range a.Facts.Deps {
			if depMatches(d, id) {
				note(fmt.Sprintf("%s declares %s", d.File, describe(d)))
			}
		}
	}
	// file-level imports → the directory of b that provides the import
	files := map[int]int{}
	for bld, specs := range a.Facts.Imports {
		for _, spec := range specs {
			for _, id := range b.Facts.Identities {
				if dir, ok := importTarget(spec, id); ok {
					if _, dup := files[bld]; !dup {
						files[bld] = districtFor(b, dir)
					}
				}
			}
		}
	}
	keys := make([]int, 0, len(files))
	for k := range files {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	for _, k := range keys {
		if len(l.Files) >= maxFileLinks {
			break
		}
		l.Files = append(l.Files, [2]int{k, files[k]})
	}
	if len(files) > 0 {
		note(fmt.Sprintf("%d %s import it", len(files), plural(len(files), "file", "files")))
	}
	if len(l.Evidence) == 0 {
		return nil
	}
	return l
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

func describe(d deps.Dep) string {
	switch d.Kind {
	case deps.Git:
		return "git URL " + d.Name
	case deps.Go:
		return "Go module " + d.Name
	case deps.NPM:
		return "npm package " + d.Name
	case deps.Cargo:
		return "crate " + d.Name
	case deps.Python:
		return "Python package " + d.Name
	}
	return d.Kind + " " + d.Name
}

func depMatches(d deps.Dep, id deps.Identity) bool {
	switch id.Kind {
	case deps.Go:
		return d.Kind == deps.Go && (d.Name == id.Name || strings.HasPrefix(d.Name, id.Name+"/"))
	case deps.NPM, deps.Cargo, deps.Python:
		return d.Kind == id.Kind && d.Name == id.Name
	case deps.Git:
		switch d.Kind {
		case deps.Git:
			return d.Name == id.Name
		case deps.Go: // a Go module path that is the repo's URL
			return deps.NormalizeURL("https://"+d.Name) == id.Name
		}
	}
	return false
}

// importTarget reports whether an import spec resolves into identity id, and the directory it points at.
func importTarget(spec string, id deps.Identity) (string, bool) {
	kind, name, ok := strings.Cut(spec, ":")
	if !ok {
		return "", false
	}
	switch id.Kind {
	case deps.Go:
		if kind == deps.Go && (name == id.Name || strings.HasPrefix(name, id.Name+"/")) {
			return path.Join(id.Dir, strings.TrimPrefix(strings.TrimPrefix(name, id.Name), "/")), true
		}
	case deps.NPM, deps.Cargo, deps.Python:
		if kind == id.Kind && name == id.Name {
			return id.Dir, true
		}
	case deps.Git:
		if kind == deps.Go && deps.NormalizeURL("https://"+name) == id.Name {
			parts := strings.SplitN(name, "/", 4)
			if len(parts) == 4 {
				return parts[3], true
			}
			return "", true
		}
	}
	return "", false
}

// districtFor returns the deepest district of c containing dir (0 = root).
func districtFor(c *city.City, dir string) int {
	dir = strings.Trim(path.Clean("/"+dir), "/")
	best, bestLen := 0, -1
	for i, d := range c.Districts {
		if d.Path == "" {
			continue
		}
		if (dir == d.Path || strings.HasPrefix(dir, d.Path+"/")) && len(d.Path) > bestLen {
			best, bestLen = i, len(d.Path)
		}
	}
	if bestLen < 0 { // a collapsed chain may start below dir ("a" when the district is "a/b/c")
		for i, d := range c.Districts {
			if d.Path != "" && dir != "" && strings.HasPrefix(d.Path, dir+"/") && (bestLen < 0 || len(d.Path) < bestLen) {
				best, bestLen = i, len(d.Path)
			}
		}
	}
	return best
}

// peopleLink returns shared contributors between a and b (nil if none). Bots are ignored.
func peopleLink(a, b *city.City, ai, bi int) *city.Link {
	if a.Facts == nil || b.Facts == nil || a.Facts.Authors == nil || b.Facts.Authors == nil {
		return nil
	}
	bm := map[string]struct {
		name string
		n    int
	}{}
	for name, n := range b.Facts.Authors {
		bm[strings.ToLower(name)] = struct {
			name string
			n    int
		}{name, n}
	}
	type shared struct {
		name string
		n    int
	}
	var both []shared
	for name, n := range a.Facts.Authors {
		lname := strings.ToLower(name)
		if strings.Contains(lname, "[bot]") || strings.HasSuffix(lname, "bot") {
			continue
		}
		if o, ok := bm[lname]; ok {
			both = append(both, shared{name, min(n, o.n)})
		}
	}
	if len(both) == 0 {
		return nil
	}
	sort.Slice(both, func(i, j int) bool {
		if both[i].n != both[j].n {
			return both[i].n > both[j].n
		}
		return both[i].name < both[j].name
	})
	l := &city.Link{From: ai, To: bi, Kind: "people", PeopleCount: len(both)}
	for i, s := range both {
		if i == 10 {
			break
		}
		l.People = append(l.People, s.name)
	}
	l.Evidence = []string{fmt.Sprintf("%d shared %s", len(both), plural(len(both), "contributor", "contributors"))}
	return l
}
