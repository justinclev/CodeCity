package workspace

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/justinclev/codecity/internal/city"
)

// Build links and merges analyzed repositories into one world City. A single
// city is returned unchanged.
func Build(cities []*city.City) *city.City {
	if len(cities) == 1 {
		return cities[0]
	}
	names := uniqueNames(cities)

	// links on the per-repo cities (local indices), remapped while merging
	var links []city.Link
	for a := range cities {
		for b := range cities {
			if a == b {
				continue
			}
			if l := link(cities[a], cities[b], a, b); l != nil {
				links = append(links, *l)
			}
			if l := messageLinks(cities[a], cities[b], a, b, names); l != nil {
				links = append(links, *l)
			}
			if a < b {
				if l := dataLinks(cities[a], cities[b], a, b, names); l != nil {
					links = append(links, *l)
				}
				if l := peopleLink(cities[a], cities[b], a, b); l != nil {
					links = append(links, *l)
				}
			}
		}
	}
	links = append(links, apiLinks(cities, names)...)
	offsets, w, d := arrange(cities, links)
	return merge(cities, names, links, offsets, w, d)
}

func uniqueNames(cities []*city.City) []string {
	names := make([]string, len(cities))
	used := map[string]int{}
	for i, c := range cities {
		n := c.Repo.Name
		if n == "" {
			n = fmt.Sprintf("repo%d", i+1)
		}
		n = strings.ReplaceAll(n, "/", "-")
		used[n]++
		if used[n] > 1 {
			n = fmt.Sprintf("%s-%d", n, used[n])
		}
		names[i] = n
	}
	return names
}

// arrange places cities in rows (connected cities next to each other) and
// returns each city's offset plus the world size.
func arrange(cities []*city.City, links []city.Link) (offsets [][2]float64, worldW, worldD float64) {
	n := len(cities)
	// order: start from the largest city, then breadth-first along dependency links
	weight := make([]float64, n)
	adj := make([][]int, n)
	for _, l := range links {
		if l.Kind != "people" {
			adj[l.From] = append(adj[l.From], l.To)
			adj[l.To] = append(adj[l.To], l.From)
		}
	}
	for i, c := range cities {
		weight[i] = c.Bounds.W * c.Bounds.D
	}
	byWeight := make([]int, n)
	for i := range byWeight {
		byWeight[i] = i
	}
	sort.SliceStable(byWeight, func(x, y int) bool { return weight[byWeight[x]] > weight[byWeight[y]] })
	var order []int
	placed := make([]bool, n)
	for _, start := range byWeight {
		if placed[start] {
			continue
		}
		queue := []int{start}
		placed[start] = true
		for len(queue) > 0 {
			c := queue[0]
			queue = queue[1:]
			order = append(order, c)
			nb := append([]int(nil), adj[c]...)
			sort.SliceStable(nb, func(x, y int) bool { return weight[nb[x]] > weight[nb[y]] })
			for _, x := range nb {
				if !placed[x] {
					placed[x] = true
					queue = append(queue, x)
				}
			}
		}
	}

	maxSide, area := 0.0, 0.0
	for _, c := range cities {
		maxSide = math.Max(maxSide, math.Max(c.Bounds.W, c.Bounds.D))
		area += c.Bounds.W * c.Bounds.D
	}
	gap := math.Max(12, maxSide*0.3)
	rowW := math.Max(maxSide, math.Sqrt(area)*1.6)

	offsets = make([][2]float64, n)
	type row struct {
		items []int
		h     float64
	}
	var rows []row
	cur, x := row{}, 0.0
	for _, i := range order {
		c := cities[i]
		if len(cur.items) > 0 && x+c.Bounds.W > rowW {
			rows = append(rows, cur)
			cur, x = row{}, 0
		}
		cur.items = append(cur.items, i)
		cur.h = math.Max(cur.h, c.Bounds.D)
		x += c.Bounds.W + gap
	}
	rows = append(rows, cur)

	z := gap
	for _, r := range rows {
		x := gap
		for _, i := range r.items {
			c := cities[i]
			offsets[i] = [2]float64{x, z + (r.h-c.Bounds.D)/2}
			x += c.Bounds.W + gap
			worldW = math.Max(worldW, x)
		}
		z += r.h + gap
	}
	return offsets, worldW, z
}

func merge(cities []*city.City, names []string, links []city.Link, offsets [][2]float64, worldW, worldD float64) *city.City {
	out := &city.City{Version: city.Version, Bounds: city.Bounds{W: r3(worldW), D: r3(worldD)}}
	out.Stats = city.Stats{Languages: map[string]city.LangStat{}, Skipped: map[string]int{}}
	out.Districts = append(out.Districts, city.District{Path: "", Name: "", Depth: -1, Parent: -1, W: r3(worldW), D: r3(worldD)})

	// merged timeline: every sampled commit of every repo, by date
	type ref struct {
		repo, idx int
		t         time.Time
	}
	var all []ref
	for k, c := range cities {
		for i, cm := range c.Commits {
			t, _ := time.Parse(time.RFC3339, cm.Date)
			all = append(all, ref{k, i, t})
		}
	}
	sort.SliceStable(all, func(i, j int) bool {
		if !all[i].t.Equal(all[j].t) {
			return all[i].t.Before(all[j].t)
		}
		if all[i].repo != all[j].repo {
			return all[i].repo < all[j].repo
		}
		return all[i].idx < all[j].idx
	})
	cmap := make([][]int, len(cities))
	for k, c := range cities {
		cmap[k] = make([]int, len(c.Commits))
	}
	for m, r := range all {
		cm := cities[r.repo].Commits[r.idx]
		cm.Repo = r.repo
		out.Commits = append(out.Commits, cm)
		cmap[r.repo][r.idx] = m
	}

	// authors merged by case-insensitive name
	akey := map[string]int{}
	var authors []city.Author
	amap := make([][]int, len(cities))
	for k, c := range cities {
		amap[k] = make([]int, len(c.Authors))
		for i, a := range c.Authors {
			key := strings.ToLower(a.Name)
			j, ok := akey[key]
			if !ok {
				j = len(authors)
				akey[key] = j
				authors = append(authors, city.Author{Name: a.Name})
			}
			authors[j].Commits += a.Commits
			authors[j].Files += a.Files
			authors[j].Last = max(authors[j].Last, a.Last)
			amap[k][i] = j
		}
	}
	perm := make([]int, len(authors))
	for i := range perm {
		perm[i] = i
	}
	sort.SliceStable(perm, func(x, y int) bool { return authors[perm[x]].Commits > authors[perm[y]].Commits })
	rank := make([]int, len(authors))
	for newIdx, old := range perm {
		rank[old] = newIdx
		out.Authors = append(out.Authors, authors[old])
	}

	dBase := make([]int, len(cities))
	bBase := make([]int, len(cities))
	var repoNames []string
	for k, c := range cities {
		ox, oz := offsets[k][0], offsets[k][1]
		dBase[k], bBase[k] = len(out.Districts), len(out.Buildings)
		name := names[k]
		repoNames = append(repoNames, name)
		for _, d := range c.Districts {
			if d.Parent < 0 {
				d.Parent, d.Name = 0, name
			} else {
				d.Parent += dBase[k]
			}
			d.Path = joinPath(name, d.Path)
			d.X, d.Z = r3(d.X+ox), r3(d.Z+oz)
			out.Districts = append(out.Districts, d)
		}
		for _, b := range c.Buildings {
			b.Repo = k
			b.District += dBase[k]
			b.Path = joinPath(name, b.Path)
			b.X, b.Z = r3(b.X+ox), r3(b.Z+oz)
			b.H = append([]city.Point(nil), b.H...)
			for i := range b.H {
				b.H[i][0] = cmap[k][b.H[i][0]]
			}
			b.Churn = append([][4]int64(nil), b.Churn...)
			for i := range b.Churn {
				b.Churn[i][0] = int64(cmap[k][b.Churn[i][0]])
			}
			if b.Own != nil {
				own := *b.Own
				own[0] = rank[amap[k][own[0]]]
				b.Own = &own
			}
			cp := make([][3]int, len(b.Coupling))
			for i, e := range b.Coupling {
				cp[i] = [3]int{e[0] + bBase[k], e[1], e[2]}
			}
			b.Coupling = cp
			b.Imp = offset(b.Imp, bBase[k])
			b.ImpD = offset(b.ImpD, dBase[k])
			out.Buildings = append(out.Buildings, b)
		}
		out.Repos = append(out.Repos, city.RepoInfo{Name: name, Source: c.Repo.Source, Remote: c.Repo.Remote, Path: c.Repo.Path,
			Ref: c.Repo.Ref, Commit: c.Repo.Commit, District: dBase[k], HasChurn: c.HasChurn})
		out.HasChurn = out.HasChurn || c.HasChurn
		out.Stats.Files += c.Stats.Files
		out.Stats.LOC += c.Stats.LOC
		out.Stats.Lines += c.Stats.Lines
		out.Stats.Bytes += c.Stats.Bytes
		for l, s := range c.Stats.Languages {
			x := out.Stats.Languages[l]
			x.Files += s.Files
			x.LOC += s.LOC
			out.Stats.Languages[l] = x
		}
		for r, n := range c.Stats.Skipped {
			out.Stats.Skipped[r] += n
		}
	}
	out.Stats.Dirs = len(out.Districts)

	for _, l := range links {
		for i, v := range l.Via {
			l.Via[i] = city.Via{From: v.From + bBase[l.From], To: v.To + bBase[l.To], Label: v.Label}
		}
		for i, f := range l.Files {
			l.Files[i] = [2]int{f[0] + bBase[l.From], f[1] + dBase[l.To]}
		}
		out.Links = append(out.Links, l)
	}

	label := strings.Join(repoNames, " + ")
	if len(repoNames) > 3 {
		label = fmt.Sprintf("%d repositories", len(repoNames))
	}
	out.Repo = city.Repo{Name: label, Source: strings.Join(repoNames, ","), Ref: "", Commit: "",
		AnalyzedAt: time.Now().UTC().Format(time.RFC3339)}
	return out
}

func joinPath(name, p string) string {
	if p == "" {
		return name
	}
	return name + "/" + p
}

func r3(v float64) float64 { return math.Round(v*1000) / 1000 }

func offset(xs []int, by int) []int {
	if len(xs) == 0 {
		return nil
	}
	out := make([]int, len(xs))
	for i, x := range xs {
		out[i] = x + by
	}
	return out
}
