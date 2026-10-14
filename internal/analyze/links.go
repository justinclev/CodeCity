package analyze

import (
	"path"
	"sort"
	"strings"

	"github.com/justinclev/codecity/internal/city"
	"github.com/justinclev/codecity/internal/flow"
	"github.com/justinclev/codecity/internal/messaging"
	"github.com/justinclev/codecity/internal/netscan"
	"github.com/justinclev/codecity/internal/scan"
)

// Facts for cross-repository highways: the HTTP routes a repository serves, the
// requests it makes, and the message topics it publishes and consumes.

const maxLinkFacts = 4000

var dbWrite = map[string]bool{"INSERT": true, "UPDATE": true, "DELETE": true, "REPLACE": true, "UPSERT": true, "MERGE": true, "CREATE": true, "ALTER": true, "DROP": true}

func linkFacts(f *city.Facts, byPath map[string]int, g *flow.Graph) {
	for _, r := range g.Routes() {
		if i, ok := byPath[r.Path]; ok && len(f.Serves) < maxLinkFacts && !scan.IsTestPath(r.Path) {
			f.Serves = append(f.Serves, city.Served{Building: i, Method: r.Method, Route: r.Route})
		}
	}
	dbSeen := map[city.DBUse]bool{}
	nodes := make(map[int]*flow.Node, len(g.Nodes))
	for _, n := range g.Nodes {
		nodes[n.ID] = n
	}
	for _, e := range g.Edges {
		from, to := nodes[e.From], nodes[e.To]
		if e.Kind != flow.EIO || from == nil || to == nil || to.Kind != flow.KIO || to.Sub != "db" || e.Label == "open" {
			continue
		}
		i, ok := byPath[from.Path]
		table := strings.ToLower(strings.TrimPrefix(to.Name, "public."))
		if !ok || scan.IsTestPath(from.Path) || len(table) < 3 || strings.HasPrefix(table, "information_schema") || strings.HasPrefix(table, "pg_") || strings.ContainsAny(table, " ()") {
			continue
		}
		u := city.DBUse{Building: i, Table: table, Write: dbWrite[e.Label]}
		if !dbSeen[u] && len(f.DB) < maxLinkFacts {
			dbSeen[u] = true
			f.DB = append(f.DB, u)
		}
	}
	seen := map[city.Call]bool{}
	for _, r := range g.Requests {
		i, ok := byPath[r.Path]
		if !ok || scan.IsTestPath(r.Path) || len(f.Calls) >= maxLinkFacts {
			continue
		}
		c := city.Call{Building: i, Method: r.Method, URL: r.URL}
		if !seen[c] {
			seen[c] = true
			f.Calls = append(f.Calls, c)
		}
	}
}

// netFile is a source or configuration file read for network facts.
type netFile struct {
	path    string
	content []byte
}

// wantNet: files the network scan reads (source in the languages netscan / messaging know, and configuration).
func wantNet(p string) bool {
	l := strings.ToLower(p)
	base := path.Base(l)
	switch {
	case strings.HasSuffix(l, ".java"), strings.HasSuffix(l, ".kt"), strings.HasSuffix(l, ".kts"), strings.HasSuffix(l, ".cs"),
		strings.HasSuffix(l, ".go"), strings.HasSuffix(l, ".py"), strings.HasSuffix(l, ".rs"), strings.HasSuffix(l, ".graphql"), strings.HasSuffix(l, ".gql"), strings.HasSuffix(l, ".graphqls"),
		strings.HasSuffix(l, ".js"), strings.HasSuffix(l, ".jsx"), strings.HasSuffix(l, ".ts"), strings.HasSuffix(l, ".tsx"), strings.HasSuffix(l, ".mjs"), strings.HasSuffix(l, ".cjs"),
		strings.HasSuffix(l, ".yaml"), strings.HasSuffix(l, ".yml"), strings.HasSuffix(l, ".json"), strings.HasSuffix(l, ".env"):
		return !strings.HasSuffix(l, "package-lock.json") && !strings.HasSuffix(l, "tsconfig.json")
	}
	return base == ".env" || strings.HasPrefix(base, ".env.") || base == "dockerfile" || strings.HasPrefix(base, "dockerfile.")
}

// networkFacts reads routes, requests, topics and service names from source and configuration files.
func networkFacts(c *city.City, f *city.Facts, files []netFile) {
	byPath := make(map[string]int, len(c.Buildings))
	for i, b := range c.Buildings {
		byPath[b.Path] = i
	}
	env := map[string]string{}
	aliasSeen := map[string]bool{}
	for _, nf := range files {
		for k, v := range netscan.Env(nf.path, nf.content) {
			if _, dup := env[k]; !dup {
				env[k] = v
			}
		}
		for _, a := range netscan.Aliases(nf.path, nf.content) {
			if !aliasSeen[a] && len(f.Aliases) < 64 {
				aliasSeen[a] = true
				f.Aliases = append(f.Aliases, a)
			}
		}
	}
	consts, ambiguous := map[string]string{}, map[string]bool{}
	for _, nf := range files {
		messaging.MergeConsts(consts, ambiguous, messaging.Consts(nf.content))
	}
	type gql struct {
		building int
		r        netscan.Route
	}
	var gqlSchemas []gql
	graphqlServer := false
	servedSeen := map[city.Served]bool{}
	callSeen := map[city.Call]bool{}
	msgSeen := map[city.Msg]bool{}
	addServe := func(s city.Served) {
		if !servedSeen[s] && len(f.Serves) < maxLinkFacts {
			servedSeen[s] = true
			f.Serves = append(f.Serves, s)
		}
	}
	addMsg := func(i int, op messaging.Op) {
		m := city.Msg{Building: i, Dir: op.Dir, Broker: op.Broker, Topic: op.Topic}
		if !msgSeen[m] && len(f.Messages) < maxLinkFacts {
			msgSeen[m] = true
			f.Messages = append(f.Messages, m)
		}
	}
	for _, nf := range files {
		i, ok := byPath[nf.path]
		if !ok || scan.IsTestPath(nf.path) {
			continue
		}
		res := netscan.Scan(nf.path, nf.content, env)
		for _, r := range res.Serves {
			if r.Method == "GRAPHQL" && r.Weak {
				gqlSchemas = append(gqlSchemas, gql{i, r})
				continue
			}
			addServe(city.Served{Building: i, Method: r.Method, Route: r.Route, Weak: r.Weak})
		}
		graphqlServer = graphqlServer || res.GraphQLServer
		for _, cl := range res.Calls {
			k := city.Call{Building: i, Method: cl.Method, URL: cl.URL}
			if !callSeen[k] && len(f.Calls) < maxLinkFacts {
				callSeen[k] = true
				f.Calls = append(f.Calls, k)
			}
		}
		for _, r := range netscan.OpenAPI(nf.path, nf.content) {
			addServe(city.Served{Building: i, Method: r.Method, Route: r.Route, Weak: true})
		}
		for _, op := range messaging.Scan(nf.path, nf.content, consts) {
			addMsg(i, op)
		}
		for _, op := range messaging.AsyncAPI(nf.path, nf.content) {
			addMsg(i, op)
		}
	}
	if graphqlServer { // a schema file only counts as served where the repository really runs a GraphQL server
		for _, g := range gqlSchemas {
			addServe(city.Served{Building: g.building, Method: g.r.Method, Route: g.r.Route})
		}
	}
	sort.SliceStable(f.Messages, func(a, b int) bool { return f.Messages[a].Topic < f.Messages[b].Topic })
}
