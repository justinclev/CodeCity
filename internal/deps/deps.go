// Package deps extracts what a repository provides (identities: module paths,
// package names, crate names, its git remote) and what it uses (declared
// dependencies in manifests, import statements in code), so separate
// repositories can be linked by evidence rather than guesswork.
package deps

import (
	"encoding/json"
	"path"
	"regexp"
	"strings"
)

// Ecosystem kinds.
const (
	Go     = "go"
	NPM    = "npm"
	Cargo  = "cargo"
	Python = "python"
	Git    = "git"
)

// Identity is something a repository provides that others can depend on.
type Identity struct {
	Kind string
	Name string // normalized
	Dir  string // directory inside the repo that provides it ("" = root)
	File string // manifest it came from
}

// Dep is a declared dependency.
type Dep struct {
	Kind string
	Name string // normalized
	File string // manifest that declares it
}

// IsManifest reports whether a path is a manifest Manifest understands.
func IsManifest(p string) bool {
	b := path.Base(p)
	switch b {
	case "go.mod", "package.json", "Cargo.toml", "pyproject.toml", "setup.py", "setup.cfg", ".gitmodules":
		return true
	}
	return strings.HasPrefix(b, "requirements") && strings.HasSuffix(b, ".txt")
}

// Manifest parses one manifest file.
func Manifest(p string, content []byte) (ids []Identity, deps []Dep) {
	dir := path.Dir(p)
	if dir == "." {
		dir = ""
	}
	s := string(content)
	add := func(kind, name string) {
		if name = normalize(kind, name); name != "" {
			deps = append(deps, Dep{Kind: kind, Name: name, File: p})
		}
	}
	addURL := func(u string) {
		if g := NormalizeURL(u); g != "" {
			deps = append(deps, Dep{Kind: Git, Name: g, File: p})
		}
	}
	switch b := path.Base(p); {
	case b == "go.mod":
		inReq := false
		for _, ln := range strings.Split(s, "\n") {
			ln = strings.TrimSpace(stripComment(ln, "//"))
			f := strings.Fields(ln)
			switch {
			case len(f) == 0:
			case f[0] == "module" && len(f) >= 2:
				ids = append(ids, Identity{Kind: Go, Name: strings.Trim(f[1], `"`), Dir: dir, File: p})
			case f[0] == "require" && len(f) >= 2 && f[1] == "(":
				inReq = true
			case f[0] == "require" && len(f) >= 3:
				add(Go, f[1])
			case inReq && f[0] == ")":
				inReq = false
			case inReq:
				add(Go, f[0])
			case f[0] == "replace":
				if i := indexOf(f, "=>"); i >= 0 && i+1 < len(f) && !strings.HasPrefix(f[i+1], ".") && !strings.HasPrefix(f[i+1], "/") {
					add(Go, f[i+1])
				}
			}
		}
	case b == "package.json":
		var pj struct {
			Name                 string            `json:"name"`
			Dependencies         map[string]string `json:"dependencies"`
			DevDependencies      map[string]string `json:"devDependencies"`
			PeerDependencies     map[string]string `json:"peerDependencies"`
			OptionalDependencies map[string]string `json:"optionalDependencies"`
			Repository           json.RawMessage   `json:"repository"`
		}
		if json.Unmarshal(content, &pj) != nil {
			return
		}
		if pj.Name != "" {
			ids = append(ids, Identity{Kind: NPM, Name: normalize(NPM, pj.Name), Dir: dir, File: p})
		}
		for _, m := range []map[string]string{pj.Dependencies, pj.DevDependencies, pj.PeerDependencies, pj.OptionalDependencies} {
			for name, ver := range m {
				add(NPM, name)
				if isURLish(ver) {
					addURL(ver)
				}
			}
		}
	case b == "Cargo.toml":
		section := ""
		for _, ln := range strings.Split(s, "\n") {
			ln = strings.TrimSpace(stripComment(ln, "#"))
			if strings.HasPrefix(ln, "[") {
				section = strings.Trim(ln, "[] ")
				if dep, ok := depTable(section); ok && dep != "" { // [dependencies.foo]
					add(Cargo, dep)
				}
				continue
			}
			k, v, ok := kv(ln)
			if !ok {
				continue
			}
			switch {
			case section == "package" && k == "name":
				ids = append(ids, Identity{Kind: Cargo, Name: normalize(Cargo, unquote(v)), Dir: dir, File: p})
			case isDepSection(section):
				add(Cargo, k)
				if m := gitField.FindStringSubmatch(v); m != nil {
					addURL(m[1])
				}
			case strings.HasPrefix(section, "dependencies.") || strings.Contains(section, "dependencies."):
				if k == "git" {
					addURL(unquote(v))
				}
			}
		}
	case b == "pyproject.toml":
		section := ""
		inArr := false
		for _, ln := range strings.Split(s, "\n") {
			ln = strings.TrimSpace(stripComment(ln, "#"))
			if inArr {
				for _, m := range quoted.FindAllStringSubmatch(ln, -1) {
					add(Python, reqName(m[1]))
				}
				if strings.Contains(ln, "]") {
					inArr = false
				}
				continue
			}
			if strings.HasPrefix(ln, "[") && !strings.Contains(ln, "=") {
				section = strings.Trim(ln, "[] ")
				continue
			}
			k, v, ok := kv(ln)
			if !ok {
				continue
			}
			switch {
			case (section == "project" || section == "tool.poetry") && k == "name":
				ids = append(ids, Identity{Kind: Python, Name: normalize(Python, unquote(v)), Dir: dir, File: p})
			case section == "project" && (k == "dependencies"):
				for _, m := range quoted.FindAllStringSubmatch(v, -1) {
					add(Python, reqName(m[1]))
				}
				inArr = strings.Contains(v, "[") && !strings.Contains(v, "]")
			case section == "tool.poetry.dependencies" || section == "tool.poetry.dev-dependencies" || strings.HasPrefix(section, "tool.poetry.group."):
				if k != "python" {
					add(Python, k)
				}
			}
		}
	case b == "setup.py" || b == "setup.cfg":
		if m := setupName.FindStringSubmatch(s); m != nil {
			ids = append(ids, Identity{Kind: Python, Name: normalize(Python, m[1]), Dir: dir, File: p})
		}
		if m := installRequires.FindStringSubmatch(s); m != nil {
			for _, q := range quoted.FindAllStringSubmatch(m[1], -1) {
				add(Python, reqName(q[1]))
			}
		}
	case b == ".gitmodules":
		for _, m := range submoduleURL.FindAllStringSubmatch(s, -1) {
			addURL(m[1])
		}
	default: // requirements*.txt
		for _, ln := range strings.Split(s, "\n") {
			ln = strings.TrimSpace(ln)
			if strings.HasPrefix(ln, "#") {
				continue
			}
			ln = strings.TrimSpace(stripComment(ln, " #")) // "#egg=" fragments are not comments
			ln = strings.TrimSpace(strings.TrimPrefix(ln, "-e "))
			if ln == "" || strings.HasPrefix(ln, "-") {
				continue
			}
			if isURLish(ln) {
				addURL(ln)
				if i := strings.Index(ln, "#egg="); i >= 0 {
					add(Python, ln[i+5:])
				}
				continue
			}
			add(Python, reqName(ln))
		}
	}
	return
}

var (
	gitField        = regexp.MustCompile(`git\s*=\s*"([^"]+)"`)
	quoted          = regexp.MustCompile(`["']([^"']+)["']`)
	setupName       = regexp.MustCompile(`(?m)^\s*name\s*[=:]\s*["']?([A-Za-z0-9_.\-]+)`)
	installRequires = regexp.MustCompile(`(?s)install_requires\s*=\s*\[(.*?)\]`)
	submoduleURL    = regexp.MustCompile(`(?m)^\s*url\s*=\s*(\S+)`)
	reqSplit        = regexp.MustCompile(`[\s\[<>=!~;@(]`)
)

func reqName(s string) string {
	s = strings.TrimSpace(s)
	if i := reqSplit.FindStringIndex(s); i != nil {
		s = s[:i[0]]
	}
	return s
}

func depTable(section string) (string, bool) {
	for _, pfx := range []string{"dependencies.", "dev-dependencies.", "build-dependencies."} {
		if strings.HasPrefix(section, pfx) {
			return section[len(pfx):], true
		}
		if i := strings.Index(section, "."+pfx); i >= 0 { // target.'cfg(..)'.dependencies.foo
			return section[i+1+len(pfx):], true
		}
	}
	return "", false
}

func isDepSection(s string) bool {
	return s == "dependencies" || s == "dev-dependencies" || s == "build-dependencies" || s == "workspace.dependencies" ||
		strings.HasSuffix(s, ".dependencies") || strings.HasSuffix(s, ".dev-dependencies")
}

func kv(ln string) (k, v string, ok bool) {
	i := strings.IndexByte(ln, '=')
	if i <= 0 {
		return "", "", false
	}
	return strings.Trim(strings.TrimSpace(ln[:i]), `"'`), strings.TrimSpace(ln[i+1:]), true
}

func unquote(v string) string { return strings.Trim(strings.TrimSpace(v), `"'`) }

func stripComment(ln, c string) string {
	if i := strings.Index(ln, c); i >= 0 {
		return ln[:i]
	}
	return ln
}

func indexOf(f []string, s string) int {
	for i, x := range f {
		if x == s {
			return i
		}
	}
	return -1
}

func isURLish(s string) bool {
	return strings.Contains(s, "://") || strings.HasPrefix(s, "git@") || strings.HasPrefix(s, "github:") ||
		strings.HasPrefix(s, "gitlab:") || strings.HasPrefix(s, "git+")
}

// NormalizeURL turns git URLs in any common spelling into "host/owner/repo".
func NormalizeURL(u string) string {
	u = strings.TrimSpace(u)
	if u == "" {
		return ""
	}
	if i := strings.IndexAny(u, "#?"); i >= 0 {
		u = u[:i]
	}
	u = strings.TrimPrefix(u, "git+")
	switch {
	case strings.HasPrefix(u, "github:"):
		u = "github.com/" + u[len("github:"):]
	case strings.HasPrefix(u, "gitlab:"):
		u = "gitlab.com/" + u[len("gitlab:"):]
	case strings.Contains(u, "://"):
		u = u[strings.Index(u, "://")+3:]
		if i := strings.IndexByte(u, '@'); i >= 0 && i < strings.IndexByte(u+"/", '/') {
			u = u[i+1:] // user@host
		}
	case strings.Contains(u, "@") && strings.Contains(u, ":"): // scp-like git@host:owner/repo
		u = u[strings.IndexByte(u, '@')+1:]
		u = strings.Replace(u, ":", "/", 1)
	default:
		if !strings.Contains(u, ".") || !strings.Contains(u, "/") {
			return "" // owner/repo shorthand or a plain word: ambiguous
		}
	}
	if i := strings.IndexByte(u, ':'); i >= 0 && i < strings.IndexByte(u+"/", '/') { // host:port
		u = u[:i] + u[strings.IndexByte(u+"/", '/'):]
	}
	u = strings.ToLower(strings.TrimSuffix(strings.TrimSuffix(u, "/"), ".git"))
	parts := strings.Split(u, "/")
	if len(parts) < 3 {
		return ""
	}
	return strings.Join(parts[:3], "/")
}

func normalize(kind, name string) string {
	name = strings.TrimSpace(name)
	switch kind {
	case Python, Cargo:
		return strings.NewReplacer("-", "_", ".", "_").Replace(strings.ToLower(name))
	case NPM:
		return strings.ToLower(name)
	case Go:
		return strings.Trim(name, `"`)
	}
	return name
}

// ---------------------------------------------------------------- imports

var (
	goBlock    = regexp.MustCompile(`(?s)\bimport\s*\((.*?)\)`)
	goSingle   = regexp.MustCompile(`(?m)^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"`)
	goQuoted   = regexp.MustCompile(`"([^"]+)"`)
	jsFrom     = regexp.MustCompile(`(?m)(?:^|[;\s])(?:import|export)\s[^'"\n;]*?\bfrom\s*['"]([^'"\n]+)['"]`)
	jsBare     = regexp.MustCompile(`(?m)(?:^|[;\s])import\s*['"]([^'"\n]+)['"]`)
	jsRequire  = regexp.MustCompile(`\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)`)
	pyImport   = regexp.MustCompile(`(?m)^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)`)
	pyFrom     = regexp.MustCompile(`(?m)^\s*from\s+([\w.]+)\s+import\b`)
	rustUse    = regexp.MustCompile(`(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+(?:::)?([A-Za-z_]\w*)::`)
	rustCrate  = regexp.MustCompile(`(?m)^\s*extern\s+crate\s+(\w+)`)
	rustSkip   = map[string]bool{"std": true, "core": true, "alloc": true, "crate": true, "self": true, "super": true, "proc_macro": true}
	maxScanLen = 256 << 10
)

// Imports returns normalized external import specs for a file:
// "go:<import path>", "npm:<package>", "python:<top module>", "cargo:<crate>".
func Imports(lang string, content []byte) []string {
	if len(content) > maxScanLen {
		content = content[:maxScanLen]
	}
	s := string(content)
	set := map[string]bool{}
	switch lang {
	case "Go":
		for _, b := range goBlock.FindAllStringSubmatch(s, -1) {
			for _, q := range goQuoted.FindAllStringSubmatch(b[1], -1) {
				addGo(set, q[1])
			}
		}
		for _, m := range goSingle.FindAllStringSubmatch(s, -1) {
			addGo(set, m[1])
		}
	case "JavaScript", "TypeScript", "Vue", "Svelte":
		for _, re := range []*regexp.Regexp{jsFrom, jsBare, jsRequire} {
			for _, m := range re.FindAllStringSubmatch(s, -1) {
				if r := npmRoot(m[1]); r != "" {
					set[NPM+":"+r] = true
				}
			}
		}
	case "Python":
		for _, m := range pyImport.FindAllStringSubmatch(s, -1) {
			for _, part := range strings.Split(m[1], ",") {
				mod := strings.Fields(strings.TrimSpace(part))
				if len(mod) > 0 {
					set[Python+":"+normalize(Python, strings.SplitN(mod[0], ".", 2)[0])] = true
				}
			}
		}
		for _, m := range pyFrom.FindAllStringSubmatch(s, -1) {
			if !strings.HasPrefix(m[1], ".") {
				set[Python+":"+normalize(Python, strings.SplitN(m[1], ".", 2)[0])] = true
			}
		}
	case "Rust":
		for _, re := range []*regexp.Regexp{rustUse, rustCrate} {
			for _, m := range re.FindAllStringSubmatch(s, -1) {
				if !rustSkip[m[1]] {
					set[Cargo+":"+normalize(Cargo, m[1])] = true
				}
			}
		}
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	return out
}

func addGo(set map[string]bool, p string) {
	first := strings.SplitN(p, "/", 2)[0]
	if strings.Contains(first, ".") { // the standard library has no dots in its first element
		set[Go+":"+p] = true
	}
}

func npmRoot(spec string) string {
	if spec == "" || strings.HasPrefix(spec, ".") || strings.HasPrefix(spec, "/") || strings.HasPrefix(spec, "node:") ||
		strings.Contains(spec, "://") || strings.HasPrefix(spec, "~") || strings.HasPrefix(spec, "#") {
		return ""
	}
	parts := strings.Split(spec, "/")
	if strings.HasPrefix(spec, "@") {
		if len(parts) < 2 {
			return ""
		}
		return strings.ToLower(parts[0] + "/" + parts[1])
	}
	return strings.ToLower(parts[0])
}

// genericModules are too common to identify a repository on their own.
var genericModules = map[string]bool{"tests": true, "test": true, "src": true, "lib": true, "utils": true, "util": true,
	"common": true, "scripts": true, "docs": true, "examples": true, "app": true, "core": true, "main": true, "config": true,
	"setup": true, "conftest": true, "build": true, "tools": true, "benchmarks": true, "internal": true}

// PythonModules finds importable top-level Python packages ("pkg/__init__.py"
// or "src/pkg/__init__.py") among a repository's file paths.
func PythonModules(paths []string) []Identity {
	var out []Identity
	seen := map[string]bool{}
	for _, p := range paths {
		if path.Base(p) != "__init__.py" {
			continue
		}
		dir := path.Dir(p)
		parts := strings.Split(dir, "/")
		var name string
		switch {
		case len(parts) == 1:
			name = parts[0]
		case len(parts) == 2 && (parts[0] == "src" || parts[0] == "python" || parts[0] == "lib"):
			name = parts[1]
		default:
			continue
		}
		n := normalize(Python, name)
		if genericModules[n] || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, Identity{Kind: Python, Name: n, Dir: dir, File: p})
	}
	return out
}
