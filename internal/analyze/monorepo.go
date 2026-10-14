package analyze

import (
	"path"
	"sort"
	"strings"

	"github.com/justinclev/codecity/internal/deps"
)

// project is one detected project inside a repository: a subtree with a build
// manifest at its root (dir == "" is the repository root / leftover bucket).
type project struct {
	dir  string // git-relative directory, "" for the repository root
	name string // display name (the dir, or the repo name for the root)
}

// detectProjects finds the project roots in a repository from the paths present
// at the newest commit. A project root is any directory that directly holds a
// build manifest (go.mod, package.json, Cargo.toml, pyproject.toml, …). The
// repository root is always a bucket for files that fall under no other project.
// It returns the projects sorted with the root first, then by directory; the
// caller splits only when more than one project ends up with files.
func detectProjects(tipPaths []string, repoName string) []project {
	roots := map[string]bool{"": true} // the root bucket always exists
	for _, p := range tipPaths {
		if deps.IsManifest(path.Base(p)) {
			roots[path.Dir(p)] = true
		}
	}
	// path.Dir("go.mod") == "." for a root manifest; fold it into the root bucket.
	if roots["."] {
		delete(roots, ".")
	}
	out := make([]project, 0, len(roots))
	for d := range roots {
		name := d
		if d == "" {
			name = repoName
		}
		out = append(out, project{dir: d, name: name})
	}
	sort.Slice(out, func(i, j int) bool {
		if (out[i].dir == "") != (out[j].dir == "") {
			return out[i].dir == "" // root first
		}
		return out[i].dir < out[j].dir
	})
	return out
}

// rootOf returns the deepest project directory that contains path p (longest
// matching prefix), or "" for the root bucket. dirs must be sorted so that the
// deepest match wins; this scans all and keeps the longest.
func rootOf(p string, dirs []string) string {
	best := ""
	for _, d := range dirs {
		if d == "" {
			continue
		}
		if p == d || strings.HasPrefix(p, d+"/") {
			if len(d) > len(best) {
				best = d
			}
		}
	}
	return best
}

// groupPaths assigns every path to the deepest project that contains it and
// returns, per project directory, the member paths (unchanged, still
// repo-relative). Projects with no files are dropped from the result.
func groupPaths(paths []string, projs []project) map[string][]string {
	dirs := make([]string, len(projs))
	for i, p := range projs {
		dirs[i] = p.dir
	}
	out := map[string][]string{}
	for _, p := range paths {
		out[rootOf(p, dirs)] = append(out[rootOf(p, dirs)], p)
	}
	return out
}
