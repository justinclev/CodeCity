// Package insights derives actionable findings from a City at its newest commit:
// hotspots, change coupling, knowledge risk, complexity and per-area summaries.
package insights

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/justinclev/codecity/internal/city"
)

// InactiveAfter is how long since an author's last commit (relative to the
// newest analyzed commit) before their files count as orphaned knowledge.
const InactiveAfter = 180 * 24 * time.Hour

// NonCode languages are excluded from hotspot and complexity rankings.
var NonCode = map[string]bool{"Markdown": true, "JSON": true, "YAML": true, "TOML": true, "Text": true,
	"Config": true, "XML": true, "Other": true, "HTML": true, "CSS": true}

type File struct {
	Path       string
	Lang       string
	LOC        int
	Complexity int
	Commits    int // all-time non-merge commits touching the file
	Lines      int // all-time lines changed
	LastChange time.Time
	Owner      string
	OwnerShare int // percent of the file's commits by its owner
	Authors    int
}

func (f File) Hotspot() int { return f.Commits * f.Complexity }

type Pair struct {
	A, B   string
	Shared int
	Degree int
}

type Area struct {
	Path       string
	Files      int
	LOC        int
	Complexity int
	Commits    int
	Authors    int
}

type Report struct {
	Repo        city.Repo
	Newest      time.Time
	Oldest      time.Time
	Samples     int
	HasChurn    bool
	Files       int
	LOC         int
	Authors     int
	Active      int // authors with a commit within InactiveAfter
	Hotspots    []File
	Coupling    []Pair
	Orphaned    []File // owned by an inactive author
	SingleOwner []File // one author ever, ranked by complexity
	Complex     []File
	Areas       []Area
}

// Compute builds a report from c. limit caps each list.
func Compute(c *city.City, limit int) *Report {
	r := &Report{Repo: c.Repo, Samples: len(c.Commits), HasChurn: c.HasChurn, Authors: len(c.Authors)}
	if n := len(c.Commits); n > 0 {
		r.Newest, _ = time.Parse(time.RFC3339, c.Commits[n-1].Date)
		r.Oldest, _ = time.Parse(time.RFC3339, c.Commits[0].Date)
	}
	inactive := map[int]bool{}
	for i, a := range c.Authors {
		if r.Newest.Sub(time.Unix(a.Last, 0)) > InactiveAfter {
			inactive[i] = true
		} else {
			r.Active++
		}
	}

	var files []File
	areas := map[string]*Area{}
	areaAuthors := map[string]map[int]bool{}
	for _, b := range c.Buildings {
		last := b.H[len(b.H)-1]
		if last[1] == city.Absent {
			continue
		}
		f := File{Path: b.Path, Lang: b.Lang, LOC: last[1], Complexity: last[4]}
		for _, ch := range b.Churn {
			f.Commits += int(ch[1])
			f.Lines += int(ch[2])
			if t := time.Unix(ch[3], 0); t.After(f.LastChange) {
				f.LastChange = t
			}
		}
		if b.Own != nil {
			f.Owner = c.Authors[b.Own[0]].Name
			if f.Commits > 0 {
				f.OwnerShare = b.Own[1] * 100 / f.Commits
			}
			f.Authors = b.Own[2]
			// an inactive owner only matters when they hold most of the knowledge
			if inactive[b.Own[0]] && !NonCode[f.Lang] && (f.OwnerShare >= 50 || f.Authors <= 2) {
				r.Orphaned = append(r.Orphaned, f)
			}
			if b.Own[2] == 1 && !NonCode[f.Lang] {
				r.SingleOwner = append(r.SingleOwner, f)
			}
		}
		files = append(files, f)
		r.Files++
		r.LOC += f.LOC

		top := "(root)"
		if i := strings.IndexByte(b.Path, '/'); i >= 0 {
			top = b.Path[:i]
		}
		a := areas[top]
		if a == nil {
			a = &Area{Path: top}
			areas[top] = a
			areaAuthors[top] = map[int]bool{}
		}
		a.Files++
		a.LOC += f.LOC
		a.Commits += f.Commits
		if !NonCode[f.Lang] {
			a.Complexity += f.Complexity
		}
		if b.Own != nil {
			areaAuthors[top][b.Own[0]] = true
		}
	}
	for k, a := range areas {
		a.Authors = len(areaAuthors[k])
		r.Areas = append(r.Areas, *a)
	}
	sort.Slice(r.Areas, func(i, j int) bool { return r.Areas[i].LOC > r.Areas[j].LOC })

	code := make([]File, 0, len(files))
	for _, f := range files {
		if !NonCode[f.Lang] {
			code = append(code, f)
		}
	}
	r.Hotspots = top(code, limit, func(f File) int { return f.Hotspot() })
	r.Complex = top(code, limit, func(f File) int { return f.Complexity })
	r.Orphaned = top(r.Orphaned, limit, func(f File) int { return f.Complexity })
	r.SingleOwner = top(r.SingleOwner, limit, func(f File) int { return f.Complexity })

	seen := map[[2]int]bool{}
	for i, b := range c.Buildings {
		if b.H[len(b.H)-1][1] == city.Absent {
			continue
		}
		for _, e := range b.Coupling {
			j := e[0]
			if c.Buildings[j].H[len(c.Buildings[j].H)-1][1] == city.Absent || NonCode[b.Lang] || NonCode[c.Buildings[j].Lang] {
				continue
			}
			k := [2]int{min(i, j), max(i, j)}
			if seen[k] {
				continue
			}
			seen[k] = true
			r.Coupling = append(r.Coupling, Pair{A: c.Buildings[k[0]].Path, B: c.Buildings[k[1]].Path, Shared: e[1], Degree: e[2]})
		}
	}
	sort.Slice(r.Coupling, func(i, j int) bool {
		x, y := r.Coupling[i], r.Coupling[j]
		if x.Degree*x.Shared != y.Degree*y.Shared {
			return x.Degree*x.Shared > y.Degree*y.Shared
		}
		return x.A+x.B < y.A+y.B
	})
	if len(r.Coupling) > limit {
		r.Coupling = r.Coupling[:limit]
	}
	return r
}

func top(fs []File, n int, key func(File) int) []File {
	out := make([]File, 0, len(fs))
	for _, f := range fs {
		if key(f) > 0 {
			out = append(out, f)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if key(out[i]) != key(out[j]) {
			return key(out[i]) > key(out[j])
		}
		return out[i].Path < out[j].Path
	})
	if len(out) > n {
		out = out[:n]
	}
	return out
}

// Markdown renders the report.
func (r *Report) Markdown() string {
	var b strings.Builder
	p := func(f string, a ...any) { fmt.Fprintf(&b, f, a...) }
	p("# Code City report: %s\n\n", r.Repo.Name)
	p("`%s` @ `%.8s`", r.Repo.Ref, r.Repo.Commit)
	if !r.Newest.IsZero() {
		p(" · %s", r.Newest.Format("2006-01-02"))
	}
	p("\n\n%s files · %s LOC", num(r.Files), num(r.LOC))
	if r.HasChurn {
		p(" · %d authors (%d active in the last %d days)", r.Authors, r.Active, int(InactiveAfter.Hours()/24))
	}
	p("\n\n")
	if !r.HasChurn {
		p("_Churn was not analyzed (shallow clone or --no-churn), so hotspots, coupling and ownership are unavailable._\n\n")
	}
	if len(r.Hotspots) > 0 {
		p("## Hotspots\nFiles that change often **and** are complex: the best refactoring candidates.\n\n")
		p("| # | File | Commits | Complexity | LOC | Owner |\n|---|---|---:|---:|---:|---|\n")
		for i, f := range r.Hotspots {
			p("| %d | `%s` | %d | %s | %s | %s |\n", i+1, f.Path, f.Commits, num(f.Complexity), num(f.LOC), owner(f))
		}
		p("\n")
	}
	if len(r.Coupling) > 0 {
		p("## Change coupling\nFiles that keep changing in the same commits. Expected for code + test; elsewhere it often signals a hidden dependency.\n\n")
		p("| File A | File B | Shared commits | Degree |\n|---|---|---:|---:|\n")
		for _, c := range r.Coupling {
			p("| `%s` | `%s` | %d | %d%% |\n", c.A, c.B, c.Shared, c.Degree)
		}
		p("\n")
	}
	if len(r.Orphaned) > 0 {
		p("## Knowledge risk: inactive owners\nComplex files whose main author (≥50%% of commits, or one of ≤2 authors) has not committed in %d days.\n\n", int(InactiveAfter.Hours()/24))
		p("| File | Owner | Owner share | Complexity |\n|---|---|---:|---:|\n")
		for _, f := range r.Orphaned {
			p("| `%s` | %s | %d%% | %s |\n", f.Path, f.Owner, f.OwnerShare, num(f.Complexity))
		}
		p("\n")
	}
	if len(r.SingleOwner) > 0 {
		p("## Knowledge risk: single author\nComplex files only one person has ever changed.\n\n")
		p("| File | Author | Complexity |\n|---|---|---:|\n")
		for _, f := range r.SingleOwner {
			p("| `%s` | %s | %s |\n", f.Path, f.Owner, num(f.Complexity))
		}
		p("\n")
	}
	if len(r.Complex) > 0 {
		p("## Most complex files\nIndentation complexity (sum of nesting depth per line).\n\n")
		p("| File | Complexity | LOC |\n|---|---:|---:|\n")
		for _, f := range r.Complex {
			p("| `%s` | %s | %s |\n", f.Path, num(f.Complexity), num(f.LOC))
		}
		p("\n")
	}
	if len(r.Areas) > 0 {
		p("## Areas\n\n| Directory | Files | LOC | Complexity | Commits | Owners |\n|---|---:|---:|---:|---:|---:|\n")
		for _, a := range r.Areas {
			p("| `%s` | %s | %s | %s | %s | %d |\n", a.Path, num(a.Files), num(a.LOC), num(a.Complexity), num(a.Commits), a.Authors)
		}
		p("\n")
	}
	return b.String()
}

func owner(f File) string {
	if f.Owner == "" {
		return ""
	}
	return fmt.Sprintf("%s (%d%%)", f.Owner, f.OwnerShare)
}

func num(n int) string {
	s := fmt.Sprint(n)
	if n < 0 {
		return s
	}
	var out []byte
	for i := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, s[i])
	}
	return string(out)
}
