package flow

import "strings"

// Token kinds.
const (
	tIdent  = 'i'
	tString = 's' // string literal (Val is the unquoted text; template holes are "\x00")
	tNum    = 'n'
	tPunct  = 'p'
	tRegex  = 'r'
)

type tok struct {
	k    byte
	v    string
	line int
	ind  int  // indentation of the token's line (Python blocks)
	nl   bool // first token on its line
}

var jsRegexAfter = map[string]bool{"return": true, "typeof": true, "case": true, "do": true, "else": true, "in": true, "of": true,
	"new": true, "delete": true, "void": true, "throw": true, "instanceof": true, "yield": true, "await": true}

func isIdentStart(c byte) bool {
	return c == '_' || c == '$' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= 0x80
}
func isIdentPart(c byte) bool { return isIdentStart(c) || c >= '0' && c <= '9' }

// lexC tokenizes C-family source (JavaScript/TypeScript with templates and regexes, or Rust).
func lexC(src []byte, rust bool) []tok {
	s := string(src)
	var out []tok
	line, i := 1, 0
	lineStart := true
	ind := 0
	type frame struct {
		template bool
		depth    int
	}
	stack := []frame{{}}
	emit := func(k byte, v string) {
		out = append(out, tok{k: k, v: v, line: line, ind: ind, nl: lineStart})
		lineStart = false
	}
	prevAllowsRegex := func() bool {
		if len(out) == 0 {
			return true
		}
		t := out[len(out)-1]
		switch t.k {
		case tIdent:
			return jsRegexAfter[t.v]
		case tPunct:
			return t.v != ")" && t.v != "]" && t.v != "}"
		}
		return false
	}
	// template scans a template literal body starting at i (after ` or }); returns at `${` (pushing) or the closing `.
	var template func(startLine int)
	template = func(startLine int) {
		var sb strings.Builder
		for i < len(s) {
			c := s[i]
			if c == '\\' && i+1 < len(s) {
				sb.WriteByte(s[i+1])
				i += 2
				continue
			}
			if c == '\n' {
				line++
			}
			if c == '`' {
				i++
				out = append(out, tok{k: tString, v: sb.String(), line: startLine, ind: ind})
				return
			}
			if c == '$' && i+1 < len(s) && s[i+1] == '{' {
				i += 2
				sb.WriteByte(0)
				out = append(out, tok{k: tString, v: sb.String(), line: startLine, ind: ind})
				stack = append(stack, frame{template: true})
				return
			}
			sb.WriteByte(c)
			i++
		}
	}
	for i < len(s) {
		c := s[i]
		switch {
		case c == '\n':
			line++
			i++
			lineStart = true
			ind = 0
			for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
				if s[i] == '\t' {
					ind += 4
				} else {
					ind++
				}
				i++
			}
		case c == ' ' || c == '\t' || c == '\r':
			i++
		case c == '/' && i+1 < len(s) && s[i+1] == '/':
			for i < len(s) && s[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < len(s) && s[i+1] == '*':
			depth := 0
			for i < len(s) {
				if s[i] == '\n' {
					line++
				}
				if strings.HasPrefix(s[i:], "/*") {
					depth++
					i += 2
					if !rust {
						depth = 1
					}
					continue
				}
				if strings.HasPrefix(s[i:], "*/") {
					i += 2
					depth--
					if depth <= 0 {
						break
					}
					continue
				}
				i++
			}
		case c == '"' || (c == '\'' && !rust):
			q := c
			start := line
			var sb strings.Builder
			i++
			for i < len(s) && s[i] != q {
				if s[i] == '\\' && i+1 < len(s) {
					if s[i+1] == '\n' {
						line++
					}
					sb.WriteByte(s[i+1])
					i += 2
					continue
				}
				if s[i] == '\n' {
					if !rust {
						break // unterminated (JSX text): stop at the line end
					}
					line++
				}
				sb.WriteByte(s[i])
				i++
			}
			if i < len(s) && s[i] == q {
				i++
			}
			out = append(out, tok{k: tString, v: sb.String(), line: start, ind: ind, nl: lineStart})
			lineStart = false
		case c == '\'' && rust:
			// char literal or lifetime
			if i+2 < len(s) && (s[i+2] == '\'' || s[i+1] == '\\') {
				j := i + 1
				for j < len(s) && s[j] != '\'' && s[j] != '\n' {
					if s[j] == '\\' {
						j++
					}
					j++
				}
				i = j + 1
				emit(tString, "")
			} else {
				i++ // lifetime: the identifier follows
			}
		case c == 'r' && rust && i+1 < len(s) && (s[i+1] == '#' || s[i+1] == '"') && (i == 0 || !isIdentPart(s[i-1])):
			j := i + 1
			hashes := 0
			for j < len(s) && s[j] == '#' {
				hashes++
				j++
			}
			if j >= len(s) || s[j] != '"' {
				goto ident
			}
			{
				end := "\"" + strings.Repeat("#", hashes)
				k := strings.Index(s[j+1:], end)
				if k < 0 {
					k = len(s) - j - 1
				}
				body := s[j+1 : j+1+k]
				start := line
				line += strings.Count(body, "\n")
				i = j + 1 + k + len(end)
				out = append(out, tok{k: tString, v: body, line: start, ind: ind, nl: lineStart})
				lineStart = false
			}
		case c == '`' && !rust:
			i++
			template(line)
		case c == '}' && !rust && len(stack) > 1 && stack[len(stack)-1].template && stack[len(stack)-1].depth == 0:
			stack = stack[:len(stack)-1]
			i++
			template(line)
		case c == '/' && !rust && prevAllowsRegex():
			j := i + 1
			inClass := false
			for j < len(s) && s[j] != '\n' {
				if s[j] == '\\' {
					j += 2
					continue
				}
				if s[j] == '[' {
					inClass = true
				} else if s[j] == ']' {
					inClass = false
				} else if s[j] == '/' && !inClass {
					break
				}
				j++
			}
			if j < len(s) && s[j] == '/' {
				j++
				for j < len(s) && isIdentPart(s[j]) {
					j++
				}
				emit(tRegex, s[i:j])
				i = j
			} else {
				emit(tPunct, "/")
				i++
			}
		case c >= '0' && c <= '9':
			j := i
			for j < len(s) && (isIdentPart(s[j]) || s[j] == '.') {
				j++
			}
			emit(tNum, s[i:j])
			i = j
		case isIdentStart(c):
			goto ident
		default:
			if c == '=' && i+1 < len(s) && s[i+1] == '>' {
				emit(tPunct, "=>")
				i += 2
			} else if c == '?' && i+1 < len(s) && s[i+1] == '.' && !(i+2 < len(s) && s[i+2] >= '0' && s[i+2] <= '9') {
				emit(tPunct, ".") // optional chaining reads like a member access
				i += 2
			} else if c == '!' && !rust && i+1 < len(s) && (s[i+1] == '.' || s[i+1] == ')' || s[i+1] == ';' || s[i+1] == ',' || s[i+1] == '[') && i > 0 && (isIdentPart(s[i-1]) || s[i-1] == ')' || s[i-1] == ']') {
				i++ // TypeScript non-null assertion: x!.y reads like x.y
			} else if c == ':' && i+1 < len(s) && s[i+1] == ':' {
				emit(tPunct, "::")
				i += 2
			} else if c == '-' && i+1 < len(s) && s[i+1] == '>' {
				emit(tPunct, "->")
				i += 2
			} else if c == '=' && i+1 < len(s) && s[i+1] == '=' {
				j := i
				for j < len(s) && s[j] == '=' {
					j++
				}
				emit(tPunct, s[i:j])
				i = j
			} else {
				if c == '{' {
					stack[len(stack)-1].depth++
				} else if c == '}' {
					stack[len(stack)-1].depth--
				}
				emit(tPunct, string(c))
				i++
			}
		}
		continue
	ident:
		{
			j := i
			for j < len(s) && isIdentPart(s[j]) {
				j++
			}
			emit(tIdent, s[i:j])
			i = j
		}
	}
	return out
}

// lexPy tokenizes Python; every token knows its line's indentation.
func lexPy(src []byte) []tok {
	s := string(src)
	var out []tok
	line, i := 1, 0
	ind, lineStart, depth := 0, true, 0
	for i < len(s) {
		c := s[i]
		switch {
		case c == '\n':
			line++
			i++
			if depth == 0 {
				lineStart = true
				ind = 0
				for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
					if s[i] == '\t' {
						ind += 4
					} else {
						ind++
					}
					i++
				}
			}
		case c == ' ' || c == '\t' || c == '\r' || c == '\\':
			i++
		case c == '#':
			for i < len(s) && s[i] != '\n' {
				i++
			}
		case c == '"' || c == '\'' || ((c == 'r' || c == 'b' || c == 'f' || c == 'u' || c == 'R' || c == 'B' || c == 'F') && pyStrPrefix(s, i)):
			j := i
			for j < len(s) && s[j] != '"' && s[j] != '\'' {
				j++
			}
			q := s[j]
			triple := strings.HasPrefix(s[j:], strings.Repeat(string(q), 3))
			start := line
			var sb strings.Builder
			if triple {
				j += 3
				end := strings.Index(s[j:], strings.Repeat(string(q), 3))
				if end < 0 {
					end = len(s) - j
				}
				sb.WriteString(s[j : j+end])
				line += strings.Count(s[j:j+end], "\n")
				j += end + 3
			} else {
				j++
				for j < len(s) && s[j] != q && s[j] != '\n' {
					if s[j] == '\\' && j+1 < len(s) {
						sb.WriteByte(s[j+1])
						j += 2
						continue
					}
					sb.WriteByte(s[j])
					j++
				}
				j++
			}
			out = append(out, tok{k: tString, v: sb.String(), line: start, ind: ind, nl: lineStart})
			lineStart = false
			i = min(j, len(s))
		case c >= '0' && c <= '9':
			j := i
			for j < len(s) && (isIdentPart(s[j]) || s[j] == '.') {
				j++
			}
			out = append(out, tok{k: tNum, v: s[i:j], line: line, ind: ind, nl: lineStart})
			lineStart = false
			i = j
		case isIdentStart(c):
			j := i
			for j < len(s) && isIdentPart(s[j]) {
				j++
			}
			out = append(out, tok{k: tIdent, v: s[i:j], line: line, ind: ind, nl: lineStart})
			lineStart = false
			i = j
		default:
			switch c {
			case '(', '[', '{':
				depth++
			case ')', ']', '}':
				if depth > 0 {
					depth--
				}
			}
			v := string(c)
			if c == '-' && i+1 < len(s) && s[i+1] == '>' {
				v = "->"
				i++
			} else if c == '=' && i+1 < len(s) && s[i+1] == '=' {
				v = "=="
				i++
			}
			out = append(out, tok{k: tPunct, v: v, line: line, ind: ind, nl: lineStart})
			lineStart = false
			i++
		}
	}
	return out
}

func pyStrPrefix(s string, i int) bool {
	if i > 0 && isIdentPart(s[i-1]) {
		return false
	}
	j := i
	for j < len(s) && j-i < 3 && strings.ContainsRune("rbfuRBFU", rune(s[j])) {
		j++
	}
	return j < len(s) && (s[j] == '"' || s[j] == '\'')
}

// match returns the index of the bracket closing the one at i (or len(toks)-1).
func match(toks []tok, i int) int {
	open := toks[i].v
	close := map[string]string{"(": ")", "[": "]", "{": "}", "<": ">"}[open]
	depth := 0
	for j := i; j < len(toks); j++ {
		if toks[j].k != tPunct {
			continue
		}
		switch toks[j].v {
		case open:
			depth++
		case close:
			depth--
			if depth == 0 {
				return j
			}
		}
	}
	return len(toks) - 1
}

// chainBefore returns the member chain ending at toks[i] (an identifier): a.b.c → [a b c].
// A call or index in the chain becomes "()" / "[]".
func chainBefore(toks []tok, i int) []string {
	chain := []string{toks[i].v}
	j := i - 1
	for j >= 1 && toks[j].k == tPunct && (toks[j].v == "." || toks[j].v == "::") {
		p := toks[j-1]
		if p.k == tIdent {
			chain = append([]string{p.v}, chain...)
			j -= 2
			continue
		}
		if p.k == tPunct && (p.v == ")" || p.v == "]") {
			// skip back over the call / index
			open := "("
			if p.v == "]" {
				open = "["
			}
			depth := 0
			k := j - 1
			for ; k >= 0; k-- {
				if toks[k].k != tPunct {
					continue
				}
				if toks[k].v == p.v {
					depth++
				} else if toks[k].v == open {
					depth--
					if depth == 0 {
						break
					}
				}
			}
			if open == "(" {
				chain = append([]string{"()"}, chain...)
			} else {
				chain = append([]string{"[]"}, chain...)
			}
			if k > 0 && toks[k-1].k == tIdent {
				chain = append([]string{toks[k-1].v}, chain...)
				j = k - 2
				continue
			}
			break
		}
		if p.k == tString {
			chain = append([]string{"\"\""}, chain...)
		}
		break
	}
	return chain
}

// firstString returns the string literal that is the first argument of the call whose "(" is at i.
func firstString(toks []tok, i int) (string, bool) {
	if i+1 < len(toks) && toks[i+1].k == tString {
		// a lone literal (or the static head of a template / concatenation)
		return toks[i+1].v, true
	}
	return "", false
}

// argSpans splits the arguments of the call whose "(" is at i into token index ranges [from, to).
func argSpans(toks []tok, i int) [][2]int {
	end := match(toks, i)
	var spans [][2]int
	start := i + 1
	depth := 0
	for j := i + 1; j < end; j++ {
		if toks[j].k != tPunct {
			continue
		}
		switch toks[j].v {
		case "(", "[", "{":
			depth++
		case ")", "]", "}":
			depth--
		case ",":
			if depth == 0 {
				spans = append(spans, [2]int{start, j})
				start = j + 1
			}
		}
	}
	if start < end {
		spans = append(spans, [2]int{start, end})
	}
	return spans
}
