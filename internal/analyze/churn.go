package analyze

import (
	"context"
	"sort"
	"strings"

	"github.com/justinclev/codecity/internal/city"
	"github.com/justinclev/codecity/internal/gitx"
)

// Coupling thresholds (CodeScene/code-maat style defaults).
const (
	couplingMaxCommitFiles = 30 // ignore sweeping commits (reformat, rename, vendor bumps)
	couplingMinShared      = 3
	couplingMinDegree      = 25 // percent
	couplingPerFile        = 8
)

type churnData struct {
	authors map[string]*gitx.AuthorStat
	pairs   map[[2]int]int // path index pair (a < b) → shared commits
	revs    map[int]int    // path index → commits (all history)
}

// collectChurn walks each sample interval's git log, filling per-file churn and
// authors, and counting co-changes between tracked files.
func collectChurn(ctx context.Context, repo *gitx.Repo, commits []gitx.Commit, hist map[string]*fileHist, idx map[string]int, progress Progress) (*churnData, error) {
	cd := &churnData{authors: map[string]*gitx.AuthorStat{}, pairs: map[[2]int]int{}, revs: map[int]int{}}
	// Without a .mailmap the same person often appears with different capitalization
	// ("TJ Holowaychuk" / "Tj Holowaychuk"); merge those, keeping the first spelling seen.
	names := map[string]string{}
	canon := func(a string) string {
		k := strings.ToLower(strings.Join(strings.Fields(a), " "))
		if n, ok := names[k]; ok {
			return n
		}
		names[k] = a
		return a
	}
	for ci, c := range commits {
		progress("computing churn", ci, len(commits))
		from := ""
		if ci > 0 {
			from = commits[ci-1].Hash
		}
		res, err := repo.Churn(ctx, from, c.Hash)
		if err != nil {
			return nil, err
		}
		for a, st := range res.Authors {
			a = canon(a)
			t := cd.authors[a]
			if t == nil {
				t = &gitx.AuthorStat{}
				cd.authors[a] = t
			}
			t.Commits += st.Commits
			t.Last = max(t.Last, st.Last)
		}
		for p, st := range res.Files {
			h := hist[p]
			if h == nil {
				continue
			}
			h.churn = append(h.churn, [4]int64{int64(ci), int64(st.Commits), int64(st.Lines), st.Last})
			if h.authors == nil {
				h.authors = map[string]int{}
			}
			for a, n := range st.Authors {
				h.authors[canon(a)] += n
			}
		}
		for _, set := range res.CommitSets {
			ids := make([]int, 0, len(set))
			for _, p := range set {
				if i, ok := idx[p]; ok {
					ids = append(ids, i)
				}
			}
			for _, i := range ids {
				cd.revs[i]++
			}
			if len(ids) < 2 || len(set) > couplingMaxCommitFiles {
				continue
			}
			sort.Ints(ids)
			for x := 0; x < len(ids); x++ {
				for y := x + 1; y < len(ids); y++ {
					cd.pairs[[2]int{ids[x], ids[y]}]++
				}
			}
		}
	}
	return cd, nil
}

// assignOwners sets Building.Own (top author per file; ties by name) and the authors list.
func assignOwners(c *city.City, byPath map[string]*fileHist, authors map[string]*gitx.AuthorStat) {
	owner := make([]string, len(c.Buildings))
	owned := map[string]int{}
	for i, b := range c.Buildings {
		f := byPath[b.Path]
		if f == nil { // a grouped landmark building (library/plant/port) has no file history
			continue
		}
		best, bestN := "", 0
		for a, n := range f.authors {
			if n > bestN || (n == bestN && a < best) {
				best, bestN = a, n
			}
		}
		if bestN > 0 {
			owner[i] = best
			owned[best]++
		}
	}
	for a, n := range owned {
		st := authors[a]
		au := city.Author{Name: a, Files: n}
		if st != nil {
			au.Commits, au.Last = st.Commits, st.Last
		}
		c.Authors = append(c.Authors, au)
	}
	sort.Slice(c.Authors, func(i, j int) bool {
		if c.Authors[i].Commits != c.Authors[j].Commits {
			return c.Authors[i].Commits > c.Authors[j].Commits
		}
		return c.Authors[i].Name < c.Authors[j].Name
	})
	ai := map[string]int{}
	for i, a := range c.Authors {
		ai[a.Name] = i
	}
	for i := range c.Buildings {
		if owner[i] == "" {
			continue
		}
		f := byPath[c.Buildings[i].Path]
		c.Buildings[i].Own = &[3]int{ai[owner[i]], f.authors[owner[i]], len(f.authors)}
	}
}

// assignCoupling keeps each file's strongest change partners.
func assignCoupling(c *city.City, order []string, cd *churnData) {
	bi := map[string]int{}
	for i, b := range c.Buildings {
		bi[b.Path] = i
	}
	type edge struct{ to, shared, degree int }
	edges := map[int][]edge{}
	for pr, shared := range cd.pairs {
		if shared < couplingMinShared {
			continue
		}
		mean := float64(cd.revs[pr[0]]+cd.revs[pr[1]]) / 2
		degree := int(float64(shared)/mean*100 + 0.5)
		if degree < couplingMinDegree {
			continue
		}
		a, b := bi[order[pr[0]]], bi[order[pr[1]]]
		edges[a] = append(edges[a], edge{b, shared, degree})
		edges[b] = append(edges[b], edge{a, shared, degree})
	}
	for i, es := range edges {
		sort.Slice(es, func(x, y int) bool {
			if es[x].degree != es[y].degree {
				return es[x].degree > es[y].degree
			}
			if es[x].shared != es[y].shared {
				return es[x].shared > es[y].shared
			}
			return es[x].to < es[y].to
		})
		if len(es) > couplingPerFile {
			es = es[:couplingPerFile]
		}
		for _, e := range es {
			c.Buildings[i].Coupling = append(c.Buildings[i].Coupling, [3]int{e.to, e.shared, e.degree})
		}
	}
}
