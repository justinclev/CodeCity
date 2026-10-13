// Package messaging finds the message topics a source file publishes to and
// subscribes to, so repositories that talk through a broker can be linked.
// It is a heuristic text scan: only topics that resolve to a string literal
// (directly or through a named constant) are reported.
package messaging

import (
	"regexp"
	"strings"
)

// Directions.
const (
	Pub = "pub"
	Sub = "sub"
)

// Op is one publish or subscribe site.
type Op struct {
	Dir    string // Pub | Sub
	Broker string // kafka | nats | amqp | redis | mqtt | sqs | sns
	Topic  string
	Line   int
}

const expr = `(?:"[^"\n]*"|'[^'\n]*'|` + "`[^`\n]*`" + `|&?[A-Za-z_][\w.]*)`

var (
	constRe = regexp.MustCompile(`(?m)([A-Za-z_]\w*)\s*(?::\s*[\w&'<>\[\] ]+?)?\s*(?::=|=|:)\s*("[^"\n]*"|'[^'\n]*')\s*[;,]?\s*\}*\s*(?://.*|#.*)?$`)

	goField   = regexp.MustCompile(`\bTopic:\s*(` + expr + `)`)
	goList    = regexp.MustCompile(`\b(?:Topics|GroupTopics):\s*\[\]string\{([^}]*)\}`)
	goSub     = regexp.MustCompile(`\b(?:SubscribeTopics\(\s*\[\]string\{([^}]*)\}|Subscribe\(\s*(` + expr + `)\s*[,)]|ConsumePartition\(\s*(` + expr + `)|\.Consume\([^,()]+,\s*\[\]string\{([^}]*)\})`)
	jsTopic   = regexp.MustCompile(`\btopic:\s*(` + expr + `)`)
	jsTopics  = regexp.MustCompile(`\btopics:\s*\[([^\]]*)\]`)
	jsNest    = regexp.MustCompile(`@(?:MessagePattern|EventPattern)\(\s*(` + expr + `)`)
	jsEmit    = regexp.MustCompile(`\.(?:emit|send)\(\s*(` + expr + `)\s*,`)
	pyConsume = regexp.MustCompile(`\b(?:AIO)?KafkaConsumer\(\s*(` + expr + `)\s*[,)]`)
	pySub     = regexp.MustCompile(`\.subscribe\(\s*(?:topics\s*=\s*)?\[?([^\])]*)\]?\s*[,)]`)
	pyProduce = regexp.MustCompile(`\.(?:send|send_and_wait|produce)\(\s*(?:topic\s*=\s*)?(` + expr + `)\s*[,)]`)
	rsProduce = regexp.MustCompile(`\b(?:FutureRecord|BaseRecord)::to\(\s*(` + expr + `)\s*\)`)
	rsSub     = regexp.MustCompile(`\.subscribe\(\s*&\[([^\]]*)\]`)
)

// Consts collects NAME = "literal" definitions of one file.
func Consts(src []byte) map[string]string {
	out := map[string]string{}
	for _, m := range constRe.FindAllSubmatch(src, -1) {
		out[string(m[1])] = unquote(string(m[2]))
	}
	return out
}

// MergeConsts adds one file's constants to all; a name defined with two different values is dropped.
func MergeConsts(all map[string]string, ambiguous map[string]bool, one map[string]string) {
	for k, v := range one {
		if ambiguous[k] {
			continue
		}
		if old, ok := all[k]; ok && old != v {
			delete(all, k)
			ambiguous[k] = true
			continue
		}
		all[k] = v
	}
}

func unquote(s string) string {
	if len(s) >= 2 {
		return s[1 : len(s)-1]
	}
	return s
}

// resolve turns a topic expression into its string value ("" if it is not a known constant).
func resolve(e string, consts map[string]string) string {
	e = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(e), "&"))
	if e == "" {
		return ""
	}
	switch e[0] {
	case '"', '\'', '`':
		if len(e) >= 2 && e[len(e)-1] == e[0] {
			return strings.TrimSpace(unquote(e))
		}
		return ""
	}
	name := e
	if i := strings.LastIndexByte(name, '.'); i >= 0 {
		name = name[i+1:]
	}
	return consts[name]
}

func (s *scanner) list(items string, off int, dir string) {
	for _, it := range strings.Split(items, ",") {
		s.add(dir, it, off)
	}
}

type scanner struct {
	broker string
	src    []byte
	consts map[string]string
	ops    []Op
	seen   map[string]bool
	lines  []int
}

func (s *scanner) line(off int) int {
	lo, hi := 0, len(s.lines)
	for lo < hi {
		m := (lo + hi) / 2
		if s.lines[m] < off {
			lo = m + 1
		} else {
			hi = m
		}
	}
	return lo + 1
}

func (s *scanner) add(dir, e string, off int) {
	t := resolve(e, s.consts)
	if t == "" || len(t) > 200 || strings.ContainsAny(t, " \t${}%*") {
		return
	}
	if s.broker == "mqtt" && strings.ContainsAny(t, "#+") {
		return
	}
	k := s.broker + "\x00" + dir + "\x00" + t
	if s.seen[k] {
		return
	}
	s.seen[k] = true
	s.ops = append(s.ops, Op{Dir: dir, Broker: s.broker, Topic: t, Line: s.line(off)})
}

// enclosingType: the identifier before the nearest unmatched '{' (Go composite literal).
func enclosingType(src []byte, pos int) string {
	depth := 0
	for i := pos - 1; i >= 0 && pos-i < 600; i-- {
		switch src[i] {
		case '}', ')', ']':
			depth++
		case '(', '[':
			if depth > 0 {
				depth--
			}
		case '{':
			if depth > 0 {
				depth--
				continue
			}
			j := i
			for j > 0 && (src[j-1] == ' ' || src[j-1] == '\t') {
				j--
			}
			k := j
			for k > 0 && (isIdent(src[k-1]) || src[k-1] == '.') {
				k--
			}
			return string(src[k:j])
		}
	}
	return ""
}

// enclosingCall: the method name before the nearest unmatched '(' (JS call).
func enclosingCall(src []byte, pos int) string {
	depth := 0
	for i := pos - 1; i >= 0 && pos-i < 800; i-- {
		switch src[i] {
		case ')', ']', '}':
			depth++
		case '[', '{':
			if depth > 0 {
				depth--
			}
		case '(':
			if depth > 0 {
				depth--
				continue
			}
			k := i
			for k > 0 && isIdent(src[k-1]) {
				k--
			}
			return string(src[k:i])
		}
	}
	return ""
}

func isIdent(c byte) bool {
	return c == '_' || c == '$' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

// Scan finds the Kafka topics a file publishes to and subscribes to.
func Scan(path string, src []byte, consts map[string]string) []Op {
	lower := strings.ToLower(string(src))
	s := &scanner{src: src, consts: consts, seen: map[string]bool{}}
	for i, c := range src {
		if c == '\n' {
			s.lines = append(s.lines, i)
		}
	}
	each := func(re *regexp.Regexp, f func(m []int)) {
		for _, m := range re.FindAllSubmatchIndex(src, -1) {
			f(m)
		}
	}
	grp := func(m []int, g int) (string, int) {
		if 2*g+1 >= len(m) || m[2*g] < 0 {
			return "", 0
		}
		return string(src[m[2*g]:m[2*g+1]]), m[2*g]
	}
	s.broker = "kafka"
	switch {
	case !strings.Contains(lower, "kafka") && !strings.Contains(lower, "sarama"):
	case strings.HasSuffix(path, ".go"):
		hasProduce := strings.Contains(string(src), ".Produce(")
		each(goField, func(m []int) {
			t, off := grp(m, 1)
			typ := enclosingType(src, m[0])
			switch {
			case strings.Contains(typ, "Reader"):
				s.add(Sub, t, off)
			case strings.Contains(typ, "TopicPartition"):
				if hasProduce {
					s.add(Pub, t, off)
				} else {
					s.add(Sub, t, off)
				}
			case strings.Contains(typ, "Writer"), strings.Contains(typ, "Message"), strings.Contains(typ, "ProducerRecord"):
				s.add(Pub, t, off)
			}
		})
		each(goList, func(m []int) { l, off := grp(m, 1); s.list(l, off, Sub) })
		each(goSub, func(m []int) {
			for g := 1; g <= 4; g++ {
				if v, off := grp(m, g); v != "" {
					if g == 1 || g == 4 {
						s.list(v, off, Sub)
					} else {
						s.add(Sub, v, off)
					}
				}
			}
		})
	case isJS(path):
		each(jsTopic, func(m []int) {
			t, off := grp(m, 1)
			switch call := enclosingCall(src, m[0]); {
			case call == "send" || call == "sendBatch" || call == "produce" || call == "emit":
				s.add(Pub, t, off)
			case call == "subscribe" || call == "run":
				s.add(Sub, t, off)
			default: // topicMessages: [{ topic, messages }] sits inside sendBatch(...)
				if strings.Contains(string(src[max(0, m[0]-300):m[0]]), "sendBatch") {
					s.add(Pub, t, off)
				}
			}
		})
		each(jsTopics, func(m []int) { l, off := grp(m, 1); s.list(l, off, Sub) })
		each(jsNest, func(m []int) { t, off := grp(m, 1); s.add(Sub, t, off) })
		if strings.Contains(lower, "clientkafka") || strings.Contains(lower, "transport.kafka") {
			each(jsEmit, func(m []int) { t, off := grp(m, 1); s.add(Pub, t, off) })
		}
	case strings.HasSuffix(path, ".py"):
		each(pyConsume, func(m []int) { t, off := grp(m, 1); s.add(Sub, t, off) })
		each(pySub, func(m []int) { l, off := grp(m, 1); s.list(l, off, Sub) })
		each(pyProduce, func(m []int) { t, off := grp(m, 1); s.add(Pub, t, off) })
	case strings.HasSuffix(path, ".rs"):
		each(rsProduce, func(m []int) { t, off := grp(m, 1); s.add(Pub, t, off) })
		each(rsSub, func(m []int) { l, off := grp(m, 1); s.list(l, off, Sub) })
	}
	s.others(path, lower)
	s.jvm(path, lower)
	return s.ops
}

func isJS(p string) bool {
	for _, e := range []string{".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"} {
		if strings.HasSuffix(p, e) {
			return true
		}
	}
	return false
}
