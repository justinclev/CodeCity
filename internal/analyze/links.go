package analyze

import (
	"sort"
	"strings"

	"github.com/justinclev/codecity/internal/city"
	"github.com/justinclev/codecity/internal/flow"
	"github.com/justinclev/codecity/internal/messaging"
)

// Facts for cross-repository highways: the HTTP routes a repository serves, the
// requests it makes, and the message topics it publishes and consumes.

const maxLinkFacts = 4000

func linkFacts(f *city.Facts, byPath map[string]int, g *flow.Graph) {
	for _, r := range g.Routes() {
		if i, ok := byPath[r.Path]; ok && len(f.Serves) < maxLinkFacts && !testPath.MatchString(r.Path) {
			f.Serves = append(f.Serves, city.Served{Building: i, Method: r.Method, Route: r.Route})
		}
	}
	seen := map[city.Call]bool{}
	for _, r := range g.Requests {
		i, ok := byPath[r.Path]
		if !ok || testPath.MatchString(r.Path) || len(f.Calls) >= maxLinkFacts {
			continue
		}
		c := city.Call{Building: i, Method: r.Method, URL: r.URL}
		if !seen[c] {
			seen[c] = true
			f.Calls = append(f.Calls, c)
		}
	}
}

// messageFacts scans the files for topics (constants are resolved repository-wide).
func messageFacts(c *city.City, f *city.Facts, files []flow.File) {
	byPath := make(map[string]int, len(c.Buildings))
	for i, b := range c.Buildings {
		byPath[b.Path] = i
	}
	consts, ambiguous := map[string]string{}, map[string]bool{}
	for _, fl := range files {
		messaging.MergeConsts(consts, ambiguous, messaging.Consts(fl.Content))
	}
	for _, fl := range files {
		if testPath.MatchString(fl.Path) {
			continue
		}
		i, ok := byPath[fl.Path]
		if !ok {
			continue
		}
		for _, op := range messaging.Scan(fl.Path, fl.Content, consts) {
			if len(f.Messages) >= maxLinkFacts {
				return
			}
			f.Messages = append(f.Messages, city.Msg{Building: i, Dir: op.Dir, Broker: op.Broker, Topic: op.Topic})
		}
	}
	sort.SliceStable(f.Messages, func(a, b int) bool { return strings.Compare(f.Messages[a].Topic, f.Messages[b].Topic) < 0 })
}
