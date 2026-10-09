// Package outline splits a source file into its pieces (types, functions,
// methods, …) with line ranges, using per-language declaration patterns plus
// brace or indentation matching. It is a heuristic, not a parser: it is robust
// to code that does not compile and needs no grammar per language.
package outline

import (
	"regexp"
	"strings"
)

// Piece is one declaration (or a gap of top-level code between declarations).
type Piece struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`  // func, method, class, struct, interface, type, impl, module, imports, scope, …
	Start      int    `json:"start"` // 1-based, inclusive
	End        int    `json:"end"`   // 1-based, inclusive
	Parent     int    `json:"parent"`
	LOC        int    `json:"loc"`
	Complexity int    `json:"complexity"` // indentation complexity relative to the declaration
}

type rule struct {
	re   *regexp.Regexp
	kind string
	name []int // capture groups joined with "." (first non-empty wins if join is false)
	join bool
}

type family int

const (
	braces family = iota
	indent        // Python
	endKw         // Ruby, Lua, Elixir
)

type lang struct {
	family      family
	singleQuote bool // ' delimits strings (not char literals)
	lineComment string
	cPrototypes bool // a func line ending in ';' is a declaration without a body
	rules       []rule
	containers  map[string]bool // kinds whose members are listed as children
}

func r(pattern, kind string, groups ...int) rule {
	return rule{re: regexp.MustCompile(pattern), kind: kind, name: groups}
}

func rj(pattern, kind string, groups ...int) rule {
	x := r(pattern, kind, groups...)
	x.join = true
	return x
}

var containerKinds = map[string]bool{"class": true, "struct": true, "interface": true, "trait": true, "impl": true,
	"enum": true, "object": true, "module": true, "namespace": true, "record": true}

// braceMethod matches an indented member like "public Foo bar(int x) {" or "async run() {".
const braceMethod = `^\s+(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized|suspend|open|inline|readonly|get|set|fun|func|def|function|unsafe|extern|partial|new|operator|mutating)\s+)*(?:[\w<>\[\],.?*&:@]+\s+)*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(`

var controlWords = map[string]bool{"if": true, "for": true, "while": true, "switch": true, "catch": true, "return": true,
	"function": true, "else": true, "do": true, "try": true, "foreach": true, "using": true, "lock": true, "with": true,
	"match": true, "when": true, "sizeof": true, "typeof": true, "new": true, "throw": true, "await": true, "super": true, "this": true}

var langs = map[string]*lang{
	"Go": {family: braces, lineComment: "//", rules: []rule{
		rj(`^func\s+\(\s*\w*\s*\*?\s*([\w]+)(?:\[[^\]]*\])?\s*\)\s*([\w]+)`, "method", 1, 2),
		r(`^func\s+([\w]+)`, "func", 1),
		r(`^type\s+([\w]+)(?:\[[^\]]*\])?\s+struct\b`, "struct", 1),
		r(`^type\s+([\w]+)(?:\[[^\]]*\])?\s+interface\b`, "interface", 1),
		r(`^type\s+([\w]+)`, "type", 1),
		r(`^(var|const)\s*\(`, "vars", 1),
	}},
	"JavaScript": jsLang(), "TypeScript": jsLang(), "Vue": jsLang(), "Svelte": jsLang(),
	"Python": {family: indent, singleQuote: true, lineComment: "#", rules: []rule{
		r(`^\s*class\s+([\w]+)`, "class", 1),
		r(`^\s*(?:async\s+)?def\s+([\w]+)`, "func", 1),
	}},
	"Ruby": {family: endKw, singleQuote: true, lineComment: "#", rules: []rule{
		r(`^\s*(?:class|module)\s+([\w:]+)`, "class", 1),
		r(`^\s*def\s+([\w.?!=\[\]]+)`, "func", 1),
	}},
	"Lua": {family: endKw, singleQuote: true, lineComment: "--", rules: []rule{
		r(`^\s*(?:local\s+)?function\s+([\w.:]+)`, "func", 1),
	}},
	"Elixir": {family: endKw, lineComment: "#", rules: []rule{
		r(`^\s*defmodule\s+([\w.]+)`, "module", 1),
		r(`^\s*defp?\s+([\w?!]+)`, "func", 1),
	}},
	"Rust": {family: braces, lineComment: "//", rules: []rule{
		r(`^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"\w+"\s+)?fn\s+([\w]+)`, "func", 1),
		r(`^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([\w]+)`, "struct", 1),
		r(`^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([\w]+)`, "enum", 1),
		r(`^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([\w]+)`, "trait", 1),
		r(`^\s*(?:unsafe\s+)?impl(?:<[^>]*>)?\s+([^{]+?)\s*(?:where\b[^{]*)?\{?\s*$`, "impl", 1),
		r(`^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([\w]+)\s*\{`, "module", 1),
		r(`^\s*macro_rules!\s*([\w]+)`, "macro", 1),
	}},
	"Java": jvmLang(), "Kotlin": jvmLang(), "Scala": jvmLang(), "C#": jvmLang(), "Dart": jvmLang(), "Swift": jvmLang(),
	"C": cLang(), "C++": cLang(), "Objective-C": cLang(),
	"PHP": {family: braces, singleQuote: true, lineComment: "//", rules: []rule{
		r(`^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([\w]+)`, "class", 1),
		r(`^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?([\w]+)`, "func", 1),
	}},
	"Shell": {family: braces, singleQuote: true, lineComment: "#", rules: []rule{
		r(`^\s*(?:function\s+)?([\w:.-]+)\s*\(\)\s*\{?`, "func", 1),
		r(`^\s*function\s+([\w:.-]+)`, "func", 1),
	}},
}

func jsLang() *lang {
	return &lang{family: braces, singleQuote: true, lineComment: "//", rules: []rule{
		r(`^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([\w$]+)`, "class", 1),
		r(`^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)`, "func", 1),
		r(`^\s*(?:export\s+)?(?:declare\s+)?interface\s+([\w$]+)`, "interface", 1),
		r(`^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([\w$]+)`, "enum", 1),
		r(`^\s*(?:export\s+)?(?:declare\s+)?type\s+([\w$]+)\s*(?:<[^=]*>)?\s*=`, "type", 1),
		r(`^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[\w$]+)\s*(?::\s*[^=]+)?=>)`, "func", 1),
		r(`^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:\{|\[|class\b|new\b|\w+\()`, "const", 1),
		r(`^\s*((?:module\.)?exports(?:\.[\w$]+)?|[\w$]+(?:\.prototype)?\.[\w$]+)\s*=\s*(?:async\s+)?function\b`, "func", 1),
		r(`^\s*((?:module\.)?exports(?:\.[\w$]+)?|[\w$]+\.[\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>`, "func", 1),
		r(`^\s*(?:describe|it|test|context)\s*\(\s*['"`+"`"+`]([^'"`+"`"+`]{1,60})`, "test", 1),
		r(braceMethod, "method", 1),
	}}
}

func jvmLang() *lang {
	return &lang{family: braces, lineComment: "//", rules: []rule{
		r(`^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial|data|open|inner|value|enum|annotation|companion|case|readonly|ref|unsafe|file)\s+)*(?:class|interface|enum|record|struct|object|trait|protocol|extension|mixin|namespace)\s+([\w.]+)`, "class", 1),
		r(`^\s*(?:(?:public|private|protected|internal|static|override|suspend|inline|open|operator|infix|tailrec|async|mutating|final|abstract)\s+)*(?:fun|func|def)\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([\w]+)`, "func", 1),
		r(braceMethod, "method", 1),
	}}
}

func cLang() *lang {
	return &lang{family: braces, lineComment: "//", cPrototypes: true, rules: []rule{
		r(`^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct|union)\s+(?:\w+\s+)?([\w]+)\s*(?::[^{;]*)?\{?\s*$`, "class", 1),
		r(`^\s*namespace\s+([\w:]+)`, "namespace", 1),
		r(`^\s*(?:enum\s+(?:class\s+)?)([\w]+)`, "enum", 1),
		r(`^[A-Za-z_][\w\s*&:<>,]*?\b([\w]+(?:::[~\w]+)*)\s*\([^;]*$`, "func", 1),
		r(braceMethod, "method", 1),
	}}
}

// Supported reports whether lang has outline rules.
func Supported(language string) bool { _, ok := langs[language]; return ok }

type decl struct {
	line, indent int
	kind, name   string
}

// Outline returns the pieces of src. For unsupported languages it returns a
// single piece spanning the whole file.
func Outline(language string, src []byte) []Piece {
	lines := strings.Split(strings.ReplaceAll(string(src), "\r\n", "\n"), "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	n := len(lines)
	if n == 0 {
		return nil
	}
	L := langs[language]
	if L == nil {
		return finish(lines, lines, nil)
	}
	code := stripped(lines, L)
	var decls []decl
	for i, ln := range lines {
		if strings.TrimSpace(code[i]) == "" {
			continue
		}
		for _, ru := range L.rules {
			m := ru.re.FindStringSubmatch(code[i])
			if m == nil {
				continue
			}
			name := ""
			if ru.join {
				var parts []string
				for _, g := range ru.name {
					if g < len(m) && m[g] != "" {
						parts = append(parts, m[g])
					}
				}
				name = strings.Join(parts, ".")
			} else {
				for _, g := range ru.name {
					if g < len(m) && m[g] != "" {
						name = m[g]
						break
					}
				}
			}
			if ru.kind == "method" && (controlWords[name] || !looksLikeBlock(code, i)) {
				continue
			}
			if ru.kind == "func" && L.cPrototypes && strings.HasSuffix(strings.TrimSpace(code[i]), ";") {
				continue // prototype / forward declaration
			}
			decls = append(decls, decl{line: i, indent: indentOf(ln), kind: ru.kind, name: strings.TrimSpace(name)})
			break
		}
	}
	var pieces []Piece
	var depth []int
	if L.family == braces {
		depth = braceDepths(code)
	}
	for _, d := range decls {
		end := d.line
		switch L.family {
		case braces:
			end = braceEnd(code, depth, d.line)
		case indent:
			end = indentEnd(lines, d.line, d.indent)
		case endKw:
			end = endKwEnd(lines, d.line, d.indent)
		}
		pieces = append(pieces, Piece{Name: d.name, Kind: d.kind, Start: d.line + 1, End: end + 1, Parent: -1})
	}
	return finish(lines, code, nest(pieces))
}

// nest assigns parents: a piece inside a container becomes its child; pieces
// inside functions (closures, locals) are dropped; overlapping duplicates are removed.
func nest(ps []Piece) []Piece {
	var out []Piece
	var stack []int // indexes into out
	for _, p := range ps {
		if (p.Kind == "const" || p.Kind == "vars") && p.End-p.Start < 2 {
			continue // one-liners stay part of the surrounding top-level code
		}
		for len(stack) > 0 && out[stack[len(stack)-1]].End < p.Start {
			stack = stack[:len(stack)-1]
		}
		if len(stack) == 0 {
			p.Parent = -1
			out = append(out, p)
			stack = append(stack, len(out)-1)
			continue
		}
		parent := out[stack[len(stack)-1]]
		if !containerKinds[parent.Kind] || len(stack) > 1 {
			continue // inside a function body, or deeper than one member level
		}
		if p.End > parent.End {
			p.End = parent.End
		}
		p.Parent = stack[len(stack)-1]
		if p.Kind == "func" {
			p.Kind = "method"
		}
		out = append(out, p)
		stack = append(stack, len(out)-1)
	}
	return out
}

// finish fills top-level gaps with "imports"/"scope" pieces and computes metrics.
// Gaps without code (blank lines, comments) are attached to the next top-level
// piece, so doc comments stay with what they document.
func finish(lines, code []string, ps []Piece) []Piece {
	n := len(lines)
	var out []Piece
	remap := map[int]int{}
	next := 1
	// gap returns false when [from,to] holds no code (caller attaches it instead)
	gap := func(from, to int) bool {
		if from > to {
			return true
		}
		nonBlank, imports := 0, 0
		for i := from - 1; i < to; i++ {
			t := strings.TrimSpace(code[i])
			if t == "" {
				continue
			}
			nonBlank++
			if strings.Contains(t, "require(") || strings.HasPrefix(t, "module.exports") {
				imports++
				continue
			}
			for _, p := range []string{"import", "from ", "use ", "#include", "#import", "package ", "using ", "extern crate", "'use strict'", "\"use strict\"", "\"", "'", ")", "}"} {
				if strings.HasPrefix(t, p) {
					imports++
					break
				}
			}
		}
		if nonBlank == 0 {
			return false
		}
		kind, name := "scope", "top-level code"
		if imports*2 >= nonBlank && from <= 1+n/3 {
			kind, name = "imports", "imports & header"
		}
		out = append(out, Piece{Name: name, Kind: kind, Start: from, End: to, Parent: -1})
		return true
	}
	for i, p := range ps {
		if p.Parent == -1 {
			if !gap(next, p.Start-1) {
				p.Start = next
			}
			if p.End >= next {
				next = p.End + 1
			}
		} else {
			p.Parent = remap[p.Parent]
		}
		remap[i] = len(out)
		out = append(out, p)
	}
	if !gap(next, n) {
		for k := len(out) - 1; k >= 0; k-- { // trailing blank lines/comments: extend the last top-level piece
			if out[k].Parent == -1 {
				out[k].End = n
				break
			}
		}
	}
	for i := range out {
		out[i].LOC, out[i].Complexity = measure(lines, out[i].Start, out[i].End)
	}
	if len(out) == 0 {
		out = append(out, Piece{Name: "file", Kind: "scope", Start: 1, End: n, Parent: -1})
		out[0].LOC, out[0].Complexity = measure(lines, 1, n)
	}
	return out
}

func measure(lines []string, start, end int) (loc, cx int) {
	base := -1
	for i := start - 1; i < end && i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "" {
			continue
		}
		loc++
		lv := indentOf(lines[i])
		if base < 0 {
			base = lv
		}
		if lv > base {
			cx += lv - base
		}
	}
	return
}

// indentOf returns the logical indentation level (tab or 4 spaces = 1; 2-space code counts 2 spaces = 1 when consistently used).
func indentOf(s string) int {
	tabs, spaces := 0, 0
	for _, c := range s {
		switch c {
		case '\t':
			tabs++
		case ' ':
			spaces++
		default:
			return tabs + (spaces+1)/2
		}
	}
	return tabs + (spaces+1)/2
}

func looksLikeBlock(code []string, i int) bool {
	for k := i; k < len(code) && k < i+6; k++ {
		t := strings.TrimSpace(code[k])
		if strings.Contains(t, "{") {
			return true
		}
		if strings.HasSuffix(t, ";") || (k > i && t == "") {
			return false
		}
	}
	return false
}

// stripped blanks out string literals and comments (keeping line structure) so
// braces and patterns only see code.
func stripped(lines []string, L *lang) []string {
	out := make([]string, len(lines))
	inBlock := false
	var inStr byte // '"', '\'', '`' or 0 for multi-line strings ('`' and Python triple quotes)
	for i, ln := range lines {
		b := []byte(ln)
		for j := 0; j < len(b); j++ {
			c := b[j]
			switch {
			case inBlock:
				if c == '*' && j+1 < len(b) && b[j+1] == '/' {
					b[j], b[j+1] = ' ', ' '
					j++
					inBlock = false
				} else {
					b[j] = ' '
				}
			case inStr != 0:
				if c == '\\' && j+1 < len(b) {
					b[j], b[j+1] = ' ', ' '
					j++
					continue
				}
				if c == inStr {
					inStr = 0
					continue
				}
				b[j] = ' '
			case L.lineComment != "" && strings.HasPrefix(string(b[j:]), L.lineComment) && !(L.lineComment == "#" && j > 0 && b[j-1] == '$'):
				for k := j; k < len(b); k++ {
					b[k] = ' '
				}
				j = len(b)
			case c == '/' && j+1 < len(b) && b[j+1] == '*' && L.lineComment == "//":
				b[j], b[j+1] = ' ', ' '
				j++
				inBlock = true
			case c == '"' || c == '`' || (c == '\'' && L.singleQuote):
				inStr = c
			case c == '\'':
				// char literal ('x', '\n', 'ሴ') — skip it; otherwise (Rust lifetimes) leave as is
				if k := strings.IndexByte(string(b[j+1:min(len(b), j+12)]), '\''); k >= 0 && (k == 1 || b[j+1] == '\\') {
					for x := j + 1; x <= j+1+k; x++ {
						b[x] = ' '
					}
					j += k + 1
				}
			}
		}
		if inStr == '"' || inStr == '\'' { // unterminated single-line string: don't leak to the next line
			inStr = 0
		}
		out[i] = string(b)
	}
	return out
}

// braceDepths returns the brace depth at the start of each line.
func braceDepths(code []string) []int {
	d := make([]int, len(code)+1)
	depth := 0
	for i, ln := range code {
		d[i] = depth
		depth += strings.Count(ln, "{") - strings.Count(ln, "}")
		if depth < 0 {
			depth = 0
		}
	}
	d[len(code)] = depth
	return d
}

func braceEnd(code []string, depth []int, start int) int {
	d0 := depth[start]
	opened := false
	for i := start; i < len(code); i++ {
		t := strings.TrimSpace(code[i])
		if !opened {
			if strings.Contains(t, "{") {
				opened = true
			} else if i > start && (t == "" || depth[i] < d0) {
				return i - 1
			} else if strings.HasSuffix(t, ";") && depth[i] == d0 {
				return i
			} else if i-start > 12 {
				return start
			}
		}
		if opened && depth[i+1] <= d0 {
			return i
		}
	}
	if !opened {
		return start
	}
	return len(code) - 1
}

func indentEnd(lines []string, start, ind int) int {
	end := start
	for i := start + 1; i < len(lines); i++ {
		t := strings.TrimSpace(lines[i])
		if t == "" {
			continue
		}
		if indentOf(lines[i]) <= ind && !strings.HasPrefix(t, ")") && !strings.HasPrefix(t, "]") {
			break
		}
		end = i
	}
	// decorators directly above belong to the piece's header, not handled here
	return end
}

func endKwEnd(lines []string, start, ind int) int {
	for i := start + 1; i < len(lines); i++ {
		t := strings.TrimSpace(lines[i])
		if t == "" {
			continue
		}
		if indentOf(lines[i]) == ind && (t == "end" || strings.HasPrefix(t, "end ") || strings.HasPrefix(t, "end)") || strings.HasPrefix(t, "end,")) {
			return i
		}
		if indentOf(lines[i]) < ind {
			return i - 1
		}
	}
	return len(lines) - 1
}
