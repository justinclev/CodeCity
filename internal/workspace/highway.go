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
func hostNames(host, name string, aliases ...string) bool {
	h0 := host
	if i := strings.IndexByte(h0, ':'); i >= 0 {
		h0 = h0[:i]
	}
	h0 = strings.SplitN(h0, ".", 2)[0]
	for _, a := range aliases {
		if a != "" && strings.EqualFold(a, h0) {
			return true
		}
	}
	return hostNamesPlain(host, name)
}

func hostNamesPlain(host, name string) bool {
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
	matchers := make([]*flow.Matcher, len(cities))
	for b, cb := range cities {
		if cb.Facts == nil {
			continue
		}
		rs := make([]flow.Route, len(cb.Facts.Serves))
		for i, sv := range cb.Facts.Serves {
			rs[i] = flow.Route{Method: sv.Method, Route: sv.Route}
		}
		matchers[b] = flow.NewMatcher(rs)
	}
	type cand struct {
		repo, score int
		s           city.Served
	}
	bestOf := func(cands []cand, weak bool) []cand {
		top := -1
		for _, c := range cands {
			if c.s.Weak == weak && c.score > top {
				top = c.score
			}
		}
		var out []cand
		for _, c := range cands {
			if c.s.Weak == weak && c.score == top {
				out = append(out, c)
			}
		}
		return out
	}
	for a, ca := range cities {
		if ca.Facts == nil {
			continue
		}
		for _, call := range ca.Facts.Calls {
			bestScore := -1
			var cands []cand
			host := ""
			for b, cb := range cities {
				if matchers[b] == nil {
					continue
				}
				idx, score, h := matchers[b].Match(call.Method, call.URL)
				host = h
				for _, i := range idx {
					sv := cb.Facts.Serves[i]
					if genericRoutes[strings.TrimRight(sv.Route, "/")] || len(strings.TrimLeft(sv.Route, "/")) < 2 {
						continue
					}
					if score > bestScore {
						bestScore = score
					}
					cands = append(cands, cand{b, score, sv})
				}
			}
			// a route in a file that may only be a copy (spec, schema) counts only when no real handler matches
			best := bestOf(cands, false)
			if len(best) == 0 {
				best = bestOf(cands, true)
			}
			if len(best) == 0 {
				continue
			}
			// the caller serves it itself: a call to its own route
			selfServes := false
			repos := map[int]bool{}
			for _, c := range best {
				repos[c.repo] = true
				if c.repo == a && !c.s.Weak {
					selfServes = true
				}
			}
			if selfServes && len(bestOf(cands, false)) > 0 {
				continue
			}
			if !anonymousHost(host) {
				// an explicit host must name the serving repository
				keep := map[int]bool{}
				for r := range repos {
					if hostNames(host, names[r], aliasesOf(cities[r])...) {
						keep[r] = true
					}
				}
				repos = keep
			} else if len(repos) > 1 { // hostless and ambiguous
				if hinted := hintRepos(call.URL, repos, names, cities); len(hinted) == 1 {
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
				label := routeLabel(call.Method, c.s)
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
func hintRepos(url string, repos map[int]bool, names []string, cities []*city.City) map[int]bool {
	u := strings.ToLower(url)
	out := map[int]bool{}
	for r := range repos {
		if w := hostWord(names[r]); len(w) >= 4 && strings.Contains(u, w) {
			out[r] = true
		}
		for _, a := range aliasesOf(cities[r]) {
			if len(a) >= 3 && strings.Contains(u, strings.ToLower(a)) {
				out[r] = true
			}
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

func aliasesOf(c *city.City) []string {
	if c.Facts == nil {
		return nil
	}
	return c.Facts.Aliases
}

// anonymousHost: no host, this machine, or a host built from a variable: nothing names the target.
func anonymousHost(h string) bool {
	if i := strings.IndexByte(h, ':'); i >= 0 {
		h = h[:i]
	}
	return h == "" || h == "localhost" || h == "0.0.0.0" || strings.HasPrefix(h, "127.") || h == "(dynamic host)"
}

// routeLabel names a call for people: "GET /api/orders", "gRPC Order", "GraphQL Query.users".
func routeLabel(callMethod string, sv city.Served) string {
	switch {
	case strings.HasPrefix(sv.Route, "/grpc/"):
		return "gRPC " + strings.TrimPrefix(sv.Route, "/grpc/")
	case strings.HasPrefix(sv.Route, "/graphql/"):
		return "GraphQL " + strings.TrimPrefix(sv.Route, "/graphql/")
	}
	return strings.TrimSpace(firstWord(callMethod, sv.Method) + " " + sv.Route)
}

// dataLinks: two repositories that use the same database table. The repository that writes it (and
// the other only reads) is the source; when both write, the lower index is.
func dataLinks(a, b *city.City, ai, bi int, names []string) *city.Link {
	if a.Facts == nil || b.Facts == nil || len(a.Facts.DB) == 0 || len(b.Facts.DB) == 0 {
		return nil
	}
	type use struct {
		buildings []int
		write     bool
	}
	collect := func(c *city.City) map[string]*use {
		m := map[string]*use{}
		for _, u := range c.Facts.DB {
			x := m[u.Table]
			if x == nil {
				x = &use{}
				m[u.Table] = x
			}
			x.write = x.write || u.Write
			if len(x.buildings) < 3 {
				x.buildings = append(x.buildings, u.Building)
			}
		}
		return m
	}
	ta, tb := collect(a), collect(b)
	var shared []string
	aWrites, bWrites := 0, 0
	for t, ua := range ta {
		if ub, ok := tb[t]; ok && (ua.write || ub.write) { // two readers share nothing worth a road
			shared = append(shared, t)
			if ua.write && !ub.write {
				aWrites++
			}
			if ub.write && !ua.write {
				bWrites++
			}
		}
	}
	if len(shared) == 0 {
		return nil
	}
	sort.Strings(shared)
	ft, tt, fi, ti := ta, tb, ai, bi
	if bWrites > aWrites {
		ft, tt, fi, ti = tb, ta, bi, ai
	}
	l := &city.Link{From: fi, To: ti, Kind: "data"}
	for _, t := range shared {
		for _, x := range ft[t].buildings {
			for _, y := range tt[t].buildings {
				if len(l.Via) < maxFileLinks {
					l.Via = append(l.Via, city.Via{From: x, To: y, Label: t})
				}
			}
		}
	}
	l.Evidence = []string{fmt.Sprintf("%s and %s share %d database %s", names[fi], names[ti], len(shared), plural(len(shared), "table", "tables"))}
	for i, t := range shared {
		if i == 12 {
			break
		}
		w := "reads"
		if ft[t].write {
			w = "writes"
		}
		o := "reads"
		if tt[t].write {
			o = "writes"
		}
		l.Evidence = append(l.Evidence, fmt.Sprintf("%s (%s %s, %s %s)", t, names[fi], w, names[ti], o))
	}
	return l
}
