package workspace

import (
	"fmt"
	"sort"
	"strings"

	"github.com/justinclev/codecity/internal/city"
	"github.com/justinclev/codecity/internal/flow"
)

// Highways: connections through the network rather than through imports.
//   - "api": a request in one repository matches a route another one serves;
//   - "message": one repository publishes to a topic the other consumes.

// genericRoutes are served by nearly every service: matching them proves nothing.
var genericRoutes = map[string]bool{"/health": true, "/healthz": true, "/ready": true, "/readyz": true, "/live": true, "/livez": true,
	"/ping": true, "/metrics": true, "/version": true, "/status": true, "/favicon.ico": true, "/robots.txt": true, "/": true, "/api": true}

// hostWords reduces a name to comparable lowercase letters and digits ("orders-service" → "orders").
func hostWord(s string) string {
	s = strings.ToLower(s)
	for _, suf := range []string{"-service", "-svc", "-api", "-server", "-backend", "service", "svc"} {
		s = strings.TrimSuffix(s, suf)
	}
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, s)
}

// hostNames: does the host of a request point at repository name?
func hostNames(host, name string) bool {
	h := host
	if i := strings.IndexByte(h, ':'); i >= 0 {
		h = h[:i]
	}
	h = strings.SplitN(h, ".", 2)[0]
	hw, nw := hostWord(h), hostWord(name)
	return hw != "" && nw != "" && (hw == nw || strings.Contains(nw, hw) && len(hw) >= 4 || strings.Contains(hw, nw) && len(nw) >= 4)
}

type pair struct{ a, b int }

// apiLinks finds, for every request, the repository serving the most specific matching route.
// A request is linked only when that route belongs to exactly one other repository (or the
// request's host names it), and not when the calling repository serves it itself.
func apiLinks(cities []*city.City, names []string) []city.Link {
	type acc struct {
		l    city.Link
		seen map[city.Via]bool
		n    map[string]bool
	}
	links := map[pair]*acc{}
	for a, ca := range cities {
		if ca.Facts == nil {
			continue
		}
		for _, call := range ca.Facts.Calls {
			bestScore := -1
			var cands []struct {
				repo, score int
				s           city.Served
			}
			host := ""
			for b, cb := range cities {
				if cb.Facts == nil {
					continue
				}
				for _, sv := range cb.Facts.Serves {
					score, h, ok := flow.Match(sv.Method, sv.Route, call.Method, call.URL)
					if !ok || genericRoutes[strings.TrimRight(sv.Route, "/")] {
						continue
					}
					host = h
					if len(strings.TrimLeft(sv.Route, "/")) < 3 {
						continue
					}
					if score > bestScore {
						bestScore = score
					}
					cands = append(cands, struct {
						repo, score int
						s           city.Served
					}{b, score, sv})
				}
			}
			var best []struct {
				repo, score int
				s           city.Served
			}
			for _, c := range cands {
				if c.score == bestScore {
					best = append(best, c)
				}
			}
			if len(best) == 0 {
				continue
			}
			// the caller serves it itself: a call to its own route
			selfServes := false
			repos := map[int]bool{}
			for _, c := range best {
				repos[c.repo] = true
				if c.repo == a {
					selfServes = true
				}
			}
			if selfServes {
				continue
			}
			if !anonymousHost(host) {
				// an explicit host must name the serving repository
				keep := map[int]bool{}
				for r := range repos {
					if hostNames(host, names[r]) {
						keep[r] = true
					}
				}
				repos = keep
			} else if len(repos) > 1 { // hostless and ambiguous
				if hinted := hintRepos(call.URL, repos, names); len(hinted) == 1 {
					repos = hinted
				} else {
					continue
				}
			}
			if len(repos) != 1 {
				continue
			}
			for _, c := range best {
				if !repos[c.repo] {
					continue
				}
				k := pair{a, c.repo}
				x := links[k]
				if x == nil {
					x = &acc{l: city.Link{From: a, To: c.repo, Kind: "api"}, seen: map[city.Via]bool{}, n: map[string]bool{}}
					links[k] = x
				}
				label := strings.TrimSpace(firstWord(call.Method, c.s.Method) + " " + c.s.Route)
				v := city.Via{From: call.Building, To: c.s.Building, Label: label}
				if !x.seen[v] && len(x.l.Via) < maxFileLinks {
					x.seen[v] = true
					x.l.Via = append(x.l.Via, v)
				}
				x.n[label] = true
				break
			}
		}
	}
	var out []city.Link
	keys := make([]pair, 0, len(links))
	for k := range links {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].a < keys[j].a || keys[i].a == keys[j].a && keys[i].b < keys[j].b })
	for _, k := range keys {
		x := links[k]
		labels := make([]string, 0, len(x.n))
		for l := range x.n {
			labels = append(labels, l)
		}
		sort.Strings(labels)
		x.l.Evidence = []string{fmt.Sprintf("%s calls %d %s of %s", names[k.a], len(labels), plural(len(labels), "route", "routes"), names[k.b])}
		for i, l := range labels {
			if i == 12 {
				break
			}
			x.l.Evidence = append(x.l.Evidence, l)
		}
		out = append(out, x.l)
	}
	return out
}

func firstWord(a, b string) string {
	if a != "" {
		return a
	}
	if b != "ANY" {
		return b
	}
	return ""
}

// hintRepos keeps the repositories whose name appears in the URL's first path segments or host.
func hintRepos(url string, repos map[int]bool, names []string) map[int]bool {
	u := strings.ToLower(url)
	out := map[int]bool{}
	for r := range repos {
		if w := hostWord(names[r]); len(w) >= 4 && strings.Contains(u, w) {
			out[r] = true
		}
	}
	return out
}

// messageLinks: repository a publishes to a topic repository b consumes (same broker, same name).
func messageLinks(a, b *city.City, ai, bi int, names []string) *city.Link {
	if a.Facts == nil || b.Facts == nil {
		return nil
	}
	type key struct{ broker, topic string }
	subs := map[key][]int{}
	for _, m := range b.Facts.Messages {
		if m.Dir == "sub" {
			subs[key{m.Broker, m.Topic}] = append(subs[key{m.Broker, m.Topic}], m.Building)
		}
	}
	l := &city.Link{From: ai, To: bi, Kind: "message"}
	seen := map[city.Via]bool{}
	topics := map[string]bool{}
	brokers := map[string]bool{}
	for _, m := range a.Facts.Messages {
		if m.Dir != "pub" {
			continue
		}
		for _, sb := range subs[key{m.Broker, m.Topic}] {
			v := city.Via{From: m.Building, To: sb, Label: m.Topic}
			if !seen[v] && len(l.Via) < maxFileLinks {
				seen[v] = true
				l.Via = append(l.Via, v)
			}
			topics[m.Broker+" "+m.Topic] = true
			brokers[m.Broker] = true
		}
	}
	if len(topics) == 0 {
		return nil
	}
	ts := make([]string, 0, len(topics))
	for t := range topics {
		ts = append(ts, t)
	}
	sort.Strings(ts)
	l.Evidence = []string{fmt.Sprintf("%s publishes %d %s %s consumes", names[ai], len(ts), plural(len(ts), "topic", "topics"), names[bi])}
	for i, t := range ts {
		if i == 12 {
			break
		}
		l.Evidence = append(l.Evidence, t)
	}
	for br := range brokers {
		l.Brokers = append(l.Brokers, br)
	}
	sort.Strings(l.Brokers)
	return l
}

// anonymousHost: no host, this machine, or a host built from a variable: nothing names the target.
func anonymousHost(h string) bool {
	if i := strings.IndexByte(h, ':'); i >= 0 {
		h = h[:i]
	}
	return h == "" || h == "localhost" || h == "0.0.0.0" || strings.HasPrefix(h, "127.") || h == "(dynamic host)"
}
