package deps

import (
	"path"
	"regexp"
	"strings"
)

// Local import extraction and resolution: which files / directories of the
// same repository a file depends on.

var (
	pyFromNames = regexp.MustCompile(`(?m)^[ \t]*from[ \t]+(\.+[\w.]*|[\w.]+)[ \t]+import[ \t]+(?:\(([^)]*)\)|([\w ,*\t]+))`)
	rustPath    = regexp.MustCompile(`(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+((?:crate|super|self)(?:::\w+)+)`)
	rustMod     = regexp.MustCompile(`(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;`)
)

// LocalImports returns raw import specs, including relative ones, for
// resolving dependencies inside a repository.
func LocalImports(lang string, content []byte) []string {
	if len(content) > maxScanLen {
		content = content[:maxScanLen]
	}
	s := string(content)
	set := map[string]bool{}
	switch lang {
	case "Go":
		for _, b := range goBlock.FindAllStringSubmatch(s, -1) {
			for _, q := range goQuoted.FindAllStringSubmatch(b[1], -1) {
				set[q[1]] = true
			}
		}
		for _, m := range goSingle.FindAllStringSubmatch(s, -1) {
			set[m[1]] = true
		}
	case "JavaScript", "TypeScript", "Vue", "Svelte":
		for _, re := range []*regexp.Regexp{jsFrom, jsBare, jsRequire} {
			for _, m := range re.FindAllStringSubmatch(s, -1) {
				if !strings.Contains(m[1], "://") && !strings.HasPrefix(m[1], "node:") {
					set[m[1]] = true
				}
			}
		}
	case "Python":
		for _, m := range pyImport.FindAllStringSubmatch(s, -1) {
			for _, part := range strings.Split(m[1], ",") {
				if f := strings.Fields(part); len(f) > 0 {
					set[f[0]] = true
				}
			}
		}
		for _, m := range pyFromNames.FindAllStringSubmatch(s, -1) {
			mod := m[1]
			set[mod] = true
			names := m[2] + m[3]                          // parenthesized (multi-line) or plain list
			for _, n := range strings.Split(names, ",") { // "from pkg import module" may name modules
				f := strings.Fields(n)
				if len(f) == 0 || f[0] == "*" {
					continue
				}
				n = f[0]
				if n == "" {
					continue
				}
				if strings.HasSuffix(mod, ".") {
					set[mod+n] = true
				} else {
					set[mod+"."+n] = true
				}
			}
		}
	case "Rust":
		for _, m := range rustPath.FindAllStringSubmatch(s, -1) {
			set[m[1]] = true
		}
		for _, m := range rustMod.FindAllStringSubmatch(s, -1) {
			set["mod:"+m[1]] = true
		}
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	return out
}

// Resolver maps import specs to files or directories of one repository.
type Resolver struct {
	files   map[string]bool
	dirs    map[string]bool
	goMods  []Identity // go.mod modules of this repo
	npm     []Identity // package.json names of this repo (workspaces)
	pyRoots []string   // "" and "src" style roots that contain Python packages
}

// NewResolver indexes a repository's file paths and its own identities.
func NewResolver(paths []string, own []Identity) *Resolver {
	r := &Resolver{files: map[string]bool{}, dirs: map[string]bool{}}
	roots := map[string]bool{"": true}
	for _, p := range paths {
		r.files[p] = true
		for d := path.Dir(p); d != "." && d != "/" && !r.dirs[d]; d = path.Dir(d) {
			r.dirs[d] = true
		}
		if path.Base(p) == "__init__.py" {
			parts := strings.Split(path.Dir(p), "/")
			if len(parts) >= 2 && (parts[0] == "src" || parts[0] == "lib" || parts[0] == "python") {
				roots[parts[0]] = true
			}
		}
	}
	for k := range roots {
		r.pyRoots = append(r.pyRoots, k)
	}
	for _, id := range own {
		switch id.Kind {
		case Go:
			r.goMods = append(r.goMods, id)
		case NPM:
			r.npm = append(r.npm, id)
		}
	}
	return r
}

// Target is a resolved import: a file, or a directory (package).
type Target struct {
	Path string
	Dir  bool
}

var jsExts = []string{"", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte", ".json"}

// Resolve resolves one spec imported by file (in language lang).
func (r *Resolver) Resolve(file, lang, spec string) (Target, bool) {
	dir := path.Dir(file)
	if dir == "." {
		dir = ""
	}
	switch lang {
	case "Go":
		for _, m := range r.goMods {
			if spec == m.Name || strings.HasPrefix(spec, m.Name+"/") {
				d := path.Join(m.Dir, strings.TrimPrefix(strings.TrimPrefix(spec, m.Name), "/"))
				if r.dirs[d] || d == "" || d == "." {
					return Target{Path: strings.TrimPrefix(d, "."), Dir: true}, true
				}
			}
		}
	case "JavaScript", "TypeScript", "Vue", "Svelte":
		var bases []string
		switch {
		case strings.HasPrefix(spec, "."):
			bases = []string{path.Join(dir, spec)}
		case strings.HasPrefix(spec, "@/") || strings.HasPrefix(spec, "~/"):
			bases = []string{path.Join("src", spec[2:]), spec[2:]}
		case strings.HasPrefix(spec, "/"):
			bases = []string{strings.TrimPrefix(spec, "/")}
		default:
			root := npmRoot(spec)
			for _, id := range r.npm {
				if id.Name == root {
					rest := strings.TrimPrefix(strings.TrimPrefix(strings.ToLower(spec), root), "/")
					if rest == "" {
						return Target{Path: id.Dir, Dir: true}, true
					}
					bases = append(bases, path.Join(id.Dir, rest), path.Join(id.Dir, "src", rest))
				}
			}
		}
		for _, b := range bases {
			for _, ext := range jsExts {
				if r.files[b+ext] {
					return Target{Path: b + ext}, true
				}
			}
			for _, ext := range jsExts[1:] {
				if r.files[b+"/index"+ext] {
					return Target{Path: b + "/index" + ext}, true
				}
			}
		}
	case "Python":
		var cands []string
		if strings.HasPrefix(spec, ".") {
			dots := len(spec) - len(strings.TrimLeft(spec, "."))
			base := dir
			for i := 1; i < dots; i++ {
				base = path.Dir(base)
				if base == "." {
					base = ""
				}
			}
			rest := strings.ReplaceAll(strings.TrimLeft(spec, "."), ".", "/")
			cands = append(cands, path.Join(base, rest))
		} else {
			rest := strings.ReplaceAll(spec, ".", "/")
			for _, root := range r.pyRoots {
				cands = append(cands, path.Join(root, rest))
			}
		}
		for _, c := range cands {
			if c == "" || c == "." {
				continue
			}
			if r.files[c+".py"] {
				return Target{Path: c + ".py"}, true
			}
			if r.files[c+"/__init__.py"] {
				return Target{Path: c + "/__init__.py"}, true
			}
		}
	case "Rust":
		return r.resolveRust(file, dir, spec)
	}
	return Target{}, false
}

func (r *Resolver) resolveRust(file, dir, spec string) (Target, bool) {
	try := func(segs []string, base string) (Target, bool) {
		for n := len(segs); n >= 1; n-- {
			p := path.Join(append([]string{base}, segs[:n]...)...)
			if r.files[p+".rs"] {
				return Target{Path: p + ".rs"}, true
			}
			if r.files[p+"/mod.rs"] {
				return Target{Path: p + "/mod.rs"}, true
			}
		}
		return Target{}, false
	}
	stem := strings.TrimSuffix(path.Base(file), ".rs")
	// module directory of this file: foo.rs → foo/, mod.rs/lib.rs/main.rs → its dir
	modDir := dir
	if stem != "mod" && stem != "lib" && stem != "main" {
		modDir = path.Join(dir, stem)
	}
	if name, ok := strings.CutPrefix(spec, "mod:"); ok {
		return try([]string{name}, modDir)
	}
	segs := strings.Split(spec, "::")
	switch segs[0] {
	case "crate":
		root := dir
		if i := strings.LastIndex("/"+file, "/src/"); i >= 0 {
			root = strings.TrimPrefix(("/" + file)[:i+4], "/")
		}
		return try(segs[1:], root)
	case "self":
		return try(segs[1:], modDir)
	case "super":
		base := modDir
		for len(segs) > 0 && segs[0] == "super" {
			base = path.Dir(base)
			segs = segs[1:]
		}
		return try(segs, base)
	}
	return Target{}, false
}
