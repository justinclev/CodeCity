// Package scan decides which files count and measures them.
package scan

import (
	"bytes"
	"path"
	"strings"
)

// Options controls filtering.
type Options struct {
	Excludes         []string
	IncludeVendored  bool
	IncludeGenerated bool
	MaxBytes         int64
}

// DefaultMaxBytes is the largest file we will read.
const DefaultMaxBytes = 2 << 20

// Metrics for one file.
type Metrics struct {
	Lines int
	LOC   int
}

var vendorDirs = map[string]bool{"node_modules": true, "vendor": true, "third_party": true, "bower_components": true, ".git": true}

var lockNames = map[string]bool{
	"package-lock.json": true, "go.sum": true, "pnpm-lock.yaml": true, "npm-shrinkwrap.json": true,
	"yarn.lock": true, "Cargo.lock": true, "poetry.lock": true, "Gemfile.lock": true, "composer.lock": true,
}

var binaryExt = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".bmp": true, ".ico": true, ".webp": true, ".tiff": true,
	".pdf": true, ".zip": true, ".gz": true, ".tgz": true, ".bz2": true, ".xz": true, ".7z": true, ".rar": true, ".tar": true,
	".woff": true, ".woff2": true, ".ttf": true, ".otf": true, ".eot": true,
	".mp3": true, ".mp4": true, ".mov": true, ".avi": true, ".wav": true, ".ogg": true, ".webm": true,
	".exe": true, ".dll": true, ".so": true, ".dylib": true, ".a": true, ".o": true, ".class": true, ".jar": true, ".wasm": true,
	".psd": true, ".sketch": true, ".bin": true, ".pyc": true, ".db": true, ".sqlite": true,
}

// PathSkip returns a reason (or "") from path/mode/size alone.
func PathSkip(p, mode string, size int64, o Options) string {
	switch mode {
	case "160000":
		return "submodule"
	case "120000":
		return "symlink"
	}
	base := path.Base(p)
	if !o.IncludeVendored {
		for _, seg := range strings.Split(path.Dir(p), "/") {
			if vendorDirs[seg] {
				return "vendored"
			}
		}
		if lockNames[base] || strings.HasSuffix(base, ".lock") {
			return "lockfile"
		}
	}
	lb := strings.ToLower(base)
	if strings.HasSuffix(lb, ".min.js") || strings.HasSuffix(lb, ".min.css") || strings.HasSuffix(lb, ".map") {
		return "minified"
	}
	if binaryExt[strings.ToLower(path.Ext(base))] {
		return "binary"
	}
	max := o.MaxBytes
	if max == 0 {
		max = DefaultMaxBytes
	}
	if size > max {
		return "large"
	}
	for _, pat := range o.Excludes {
		if matchExclude(pat, p) {
			return "excluded"
		}
	}
	return ""
}

func matchExclude(pat, p string) bool {
	if pat == "" {
		return false
	}
	if strings.HasSuffix(pat, "/") {
		pre := strings.TrimPrefix(pat, "/")
		return strings.HasPrefix(p, pre) || strings.Contains(p, "/"+pre)
	}
	target := path.Base(p)
	if strings.Contains(pat, "/") {
		target = p
	}
	ok, _ := path.Match(pat, target)
	return ok
}

// ContentSkip inspects bytes: binary or generated.
func ContentSkip(b []byte, o Options) string {
	head := b
	if len(head) > 8000 {
		head = head[:8000]
	}
	if bytes.IndexByte(head, 0) >= 0 {
		return "binary"
	}
	if !o.IncludeGenerated && isGenerated(head) {
		return "generated"
	}
	return ""
}

func isGenerated(head []byte) bool {
	if len(head) > 1500 {
		head = head[:1500]
	}
	s := strings.ToLower(string(head))
	if strings.Contains(s, "@generated") {
		return true
	}
	return strings.Contains(s, "code generated") && strings.Contains(s, "do not edit")
}

// Measure counts total and non-blank lines.
func Measure(b []byte) Metrics {
	var m Metrics
	if len(b) == 0 {
		return m
	}
	for _, line := range bytes.Split(b, []byte("\n")) {
		m.Lines++
		if len(bytes.TrimSpace(line)) > 0 {
			m.LOC++
		}
	}
	if b[len(b)-1] == '\n' { // trailing newline does not start a new line
		m.Lines--
	}
	return m
}
