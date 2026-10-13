// Package netscan finds, in source text, what a service offers and calls over the network:
// HTTP routes and requests in the languages the flow analysis does not read (Java, Kotlin, C#),
// gRPC services and clients, GraphQL fields, WebSocket clients, and request URLs built from
// environment variables. It is a heuristic text scan that complements the flow graph.
package netscan

import (
	"regexp"
	"strings"
)

// Route is a served endpoint. gRPC services are "/grpc/<Service>" (method GRPC) and GraphQL root
// fields "/graphql/<Query|Mutation|Subscription>.<field>" (method GRAPHQL).
type Route struct {
	Method string
	Route  string
	// Weak routes come from files that may merely be a copy (OpenAPI specs, GraphQL schemas): they
	// make a repository a candidate for a call, but never make a call "its own".
	Weak bool
}

// Call is an outgoing request (URLs may be hostless or carry a host hint).
type Call struct {
	Method string
	URL    string
}

// Result of scanning one file.
type Result struct {
	Serves []Route
	Calls  []Call
	// GraphQLServer: the file contains a GraphQL server (so schema files of the repository are real).
	GraphQLServer bool
}

const q = `(?:"([^"\n]*)"|'([^'\n]*)'|` + "`([^`\n]*)`" + `)` // a string literal: groups 1-3

func lit(m []string, from int) string {
	for i := from; i < from+3 && i < len(m); i++ {
		if m[i] != "" {
			return m[i]
		}
	}
	return ""
}

func join(base, p string) string {
	if p == "" {
		return base
	}
	base = strings.TrimRight(base, "/")
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	if base == "" {
		return p
	}
	return base + p
}

func isURL(s string) bool { return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") }

func norm(u string) string {
	u = strings.TrimSpace(u)
	switch {
	case strings.HasPrefix(u, "ws://"):
		return "http://" + u[5:]
	case strings.HasPrefix(u, "wss://"):
		return "https://" + u[6:]
	}
	return u
}

var (
	// ---- Spring / JAX-RS / ASP.NET routes
	springClass  = regexp.MustCompile(`(?s)@RequestMapping\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*` + q + `[^)]*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+|open\s+|abstract\s+|final\s+)*(?:class|interface)\s`)
	springMethod = regexp.MustCompile(`@(Get|Post|Put|Delete|Patch)Mapping(?:\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*(?:` + q + `)?[^)]*\))?`)
	jaxClass     = regexp.MustCompile(`(?s)@Path\(\s*` + q + `\s*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+|open\s+)*class\s`)
	jaxMethod    = regexp.MustCompile(`(?s)@(GET|POST|PUT|DELETE|PATCH)\b\s*(?:@Produces\([^)]*\)\s*|@Consumes\([^)]*\)\s*)*(?:@Path\(\s*` + q + `\s*\))?`)
	aspClass     = regexp.MustCompile(`(?s)\[Route\(\s*"([^"]*)"\s*\)\]\s*(?:\[[^\]]*\]\s*)*(?:public\s+)?(?:sealed\s+|abstract\s+)?class\s+(\w+)`)
	aspMethod    = regexp.MustCompile(`\[Http(Get|Post|Put|Delete|Patch)(?:\(\s*"([^"]*)"\s*\))?\]`)
	aspMinimal   = regexp.MustCompile(`\.Map(Get|Post|Put|Delete|Patch)\(\s*"([^"]*)"`)

	// ---- Java / Kotlin / C# HTTP clients (absolute URLs, or paths joined to a base URL in the same file)
	jvmCall = regexp.MustCompile(`(?:\b(getForObject|getForEntity|postForObject|postForEntity|put|delete|patchForObject|exchange)\(|\.uri\(|\bURI\.create\(|\.url\(|\bnew URL\(|\bnew Uri\(|\.(Get|Post|Put|Delete|Patch)Async\(|\.(Get|Post|Put|Delete)FromJsonAsync\()\s*` + q)
	jvmBase = regexp.MustCompile(`(?:\bWebClient\.(?:create|builder\(\)\.baseUrl)\(|\.baseUrl\(|BaseAddress\s*=\s*new Uri\(|@FeignClient\([^)]*\burl\s*=\s*)\s*` + q)
	retro   = regexp.MustCompile(`@(GET|POST|PUT|DELETE|PATCH)\(\s*"(/[^"]*)"\s*\)`)

	// ---- WebSocket clients
	wsCall = regexp.MustCompile(`(?:new WebSocket\(|websocket\.connect\(|websockets\.connect\(|DefaultDialer\.Dial\(|websocket\.Dial\(|\.Dial\(\s*ctx\s*,|new WebSocketClient\(|ClientWebSocket)[^"'` + "`" + `\n]{0,20}` + q)

	// ---- gRPC
	grpcServeGo   = regexp.MustCompile(`\bRegister(\w+)Server\(`)
	grpcCallGo    = regexp.MustCompile(`\bpb\w*\.New(\w+)Client\(|\bNew(\w+)Client\(\s*\w*[cC]onn`)
	grpcServePy   = regexp.MustCompile(`\badd_(\w+)Servicer_to_server\(`)
	grpcCallPy    = regexp.MustCompile(`\b(\w+)Stub\(\s*\w*channel`)
	grpcServeJVM  = regexp.MustCompile(`\bextends\s+(\w+)Grpc\.(\w+)ImplBase|:\s*(\w+)Grpc\.(\w+)ImplBase|:\s*(\w+)\.(\w+)Base\b`)
	grpcCallJVM   = regexp.MustCompile(`\b(\w+)Grpc\.new(?:Blocking|Future|)Stub\(|\bnew\s+(\w+)\.(\w+)Client\(`)
	grpcServeJS   = regexp.MustCompile(`\.addService\(\s*[\w.]*?(\w+)\.service\b`)
	grpcCallJS    = regexp.MustCompile(`\bnew\s+[\w.]*?(\w+)\(\s*` + q + `\s*,\s*grpc\.credentials`)
	grpcServeRust = regexp.MustCompile(`\b(\w+)Server::(?:new|from_arc)\(`)
	grpcCallRust  = regexp.MustCompile(`\b(\w+)Client::(?:connect|new)\(`)
	grpcDial      = regexp.MustCompile(`(?:grpc\.(?:Dial|NewClient|DialContext)\(|insecure_channel\(|\.connect\(|ManagedChannelBuilder\.forTarget\(|forAddress\(|GrpcChannel\.ForAddress\()\s*(?:ctx\s*,\s*)?` + q)

	// ---- GraphQL
	gqlOp       = regexp.MustCompile(`\b(query|mutation|subscription)\b\s*\w*\s*(?:\([^)]*\))?\s*\{`)
	gqlType     = regexp.MustCompile(`(?m)^\s*(?:extend\s+)?type\s+(Query|Mutation|Subscription)\s*(?:implements[^{]*)?\{`)
	gqlServerRe = regexp.MustCompile(`(?i)ApolloServer|apollo-server|graphql-yoga|createYoga|mercurius|gqlgen|graphene|strawberry|ariadne|async-graphql|juniper|HotChocolate|graphql-java|netflix\.graphql|@nestjs/graphql|graphql-go|gqlgen|express-graphql|graphqlHTTP`)
)

func isLang(path string, exts ...string) bool {
	for _, e := range exts {
		if strings.HasSuffix(path, e) {
			return true
		}
	}
	return false
}

// Scan finds the routes a file serves and the requests it makes. env resolves environment-variable
// references to the URLs configured for the repository (see Env).
func Scan(path string, src []byte, env map[string]string) Result {
	var r Result
	text := string(src)
	switch {
	case isLang(path, ".graphql", ".gql", ".graphqls"):
		r.Serves = append(r.Serves, graphqlSchema(text, true)...)
		r.Calls = append(r.Calls, graphqlOps(text)...)
		return r
	case isLang(path, ".proto"):
		return r
	}
	java := isLang(path, ".java", ".kt", ".kts")
	cs := isLang(path, ".cs")
	code := java || cs || isLang(path, ".go", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".rs")
	if !code {
		return r
	}
	if java {
		r.Serves = append(r.Serves, spring(text)...)
		r.Serves = append(r.Serves, jax(text)...)
	}
	if cs {
		r.Serves = append(r.Serves, asp(text)...)
	}
	if java || cs {
		r.Calls = append(r.Calls, jvmCalls(text)...)
	}
	r.Calls = append(r.Calls, wsCalls(text)...)
	rs, cl := grpc(path, text)
	r.Serves = append(r.Serves, rs...)
	r.Calls = append(r.Calls, cl...)
	r.Calls = append(r.Calls, envCalls(text, env)...)
	if gqlServerRe.MatchString(text) {
		r.GraphQLServer = true
	}
	lower := strings.ToLower(text)
	if strings.Contains(lower, "graphql") || strings.Contains(lower, "gql") {
		r.Calls = append(r.Calls, graphqlOps(text)...)
		r.Serves = append(r.Serves, graphqlSchema(text, false)...) // code-first / inline SDL
	}
	return r
}

func method(m string) string { return strings.ToUpper(m) }

func spring(text string) []Route {
	var out []Route
	base := ""
	if m := springClass.FindStringSubmatch(text); m != nil {
		base = lit(m, 1)
	}
	for _, m := range springMethod.FindAllStringSubmatch(text, -1) {
		out = append(out, Route{Method: method(m[1]), Route: join(base, lit(m, 2))})
	}
	return out
}

func jax(text string) []Route {
	var out []Route
	base := ""
	if m := jaxClass.FindStringSubmatch(text); m != nil {
		base = lit(m, 1)
	}
	for _, m := range jaxMethod.FindAllStringSubmatch(text, -1) {
		out = append(out, Route{Method: method(m[1]), Route: join(base, lit(m, 2))})
	}
	return out
}

func asp(text string) []Route {
	var out []Route
	base := ""
	if m := aspClass.FindStringSubmatch(text); m != nil {
		ctrl := strings.ToLower(strings.TrimSuffix(m[2], "Controller"))
		base = "/" + strings.Trim(strings.ReplaceAll(m[1], "[controller]", ctrl), "/")
	}
	for _, m := range aspMethod.FindAllStringSubmatch(text, -1) {
		out = append(out, Route{Method: method(m[1]), Route: join(base, m[2])})
	}
	for _, m := range aspMinimal.FindAllStringSubmatch(text, -1) {
		out = append(out, Route{Method: method(m[1]), Route: join("", m[2])})
	}
	return out
}

func jvmCalls(text string) []Call {
	var out []Call
	base := ""
	if m := jvmBase.FindStringSubmatch(text); m != nil && isURL(lit(m, 1)) {
		base = lit(m, 1)
	}
	for _, m := range jvmCall.FindAllStringSubmatch(text, -1) {
		u := lit(m, 4)
		verb := ""
		switch v := strings.ToUpper(firstOf(m[1], m[2], m[3])); {
		case strings.HasPrefix(v, "GET"):
			verb = "GET"
		case strings.HasPrefix(v, "POST"):
			verb = "POST"
		case strings.HasPrefix(v, "PUT"):
			verb = "PUT"
		case strings.HasPrefix(v, "DELETE"):
			verb = "DELETE"
		case strings.HasPrefix(v, "PATCH"):
			verb = "PATCH"
		}
		switch {
		case isURL(u):
		case strings.HasPrefix(u, "/") && base != "":
			u = join(base, u)
		default:
			continue
		}
		out = append(out, Call{Method: verb, URL: u})
	}
	for _, m := range retro.FindAllStringSubmatch(text, -1) {
		u := m[2]
		if base != "" {
			u = join(base, u)
		}
		out = append(out, Call{Method: method(m[1]), URL: u})
	}
	return out
}

func firstOf(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}

func wsCalls(text string) []Call {
	var out []Call
	for _, m := range wsCall.FindAllStringSubmatch(text, -1) {
		if u := lit(m, 1); strings.HasPrefix(u, "ws://") || strings.HasPrefix(u, "wss://") {
			out = append(out, Call{Method: "GET", URL: norm(u)})
		}
	}
	return out
}

func grpc(path, text string) (serves []Route, calls []Call) {
	svc := func(n string) string { return "/grpc/" + n }
	add := func(re *regexp.Regexp, serve bool) {
		for _, m := range re.FindAllStringSubmatch(text, -1) {
			name := ""
			for _, g := range m[1:] {
				if g != "" {
					name = g
					break
				}
			}
			// ImplBase / Base patterns carry (Outer, Inner): the service is the outer name
			if name == "" || name == "Unimplemented" || name == "Client" {
				continue
			}
			if serve {
				serves = append(serves, Route{Method: "GRPC", Route: svc(name)})
			} else {
				calls = append(calls, Call{Method: "GRPC", URL: svc(name)})
			}
		}
	}
	switch {
	case isLang(path, ".go"):
		add(grpcServeGo, true)
		add(grpcCallGo, false)
	case isLang(path, ".py"):
		add(grpcServePy, true)
		add(grpcCallPy, false)
	case isLang(path, ".java", ".kt", ".kts", ".cs"):
		add(grpcServeJVM, true)
		add(grpcCallJVM, false)
	case isLang(path, ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"):
		add(grpcServeJS, true)
		add(grpcCallJS, false)
	case isLang(path, ".rs"):
		add(grpcServeRust, true)
		add(grpcCallRust, false)
	}
	// a gRPC client reaches its server through an address: keep it as the host of each call
	if len(calls) > 0 {
		if m := grpcDial.FindStringSubmatch(text); m != nil {
			host := strings.TrimPrefix(strings.TrimPrefix(strings.TrimPrefix(lit(m, 1), "http://"), "https://"), "dns:///")
			if i := strings.IndexByte(host, '/'); i >= 0 {
				host = host[:i]
			}
			if host != "" {
				for i := range calls {
					calls[i].URL = "http://" + host + calls[i].URL
				}
			}
		}
	}
	return
}

// graphqlSchema reads root fields of `type Query { ... }` blocks.
func graphqlSchema(text string, file bool) []Route {
	var out []Route
	for _, loc := range gqlType.FindAllStringSubmatchIndex(text, -1) {
		root := text[loc[2]:loc[3]]
		for _, f := range topFields(text[loc[1]:], true) {
			out = append(out, Route{Method: "GRAPHQL", Route: "/graphql/" + root + "." + f, Weak: file})
		}
	}
	return out
}

// graphqlOps reads the root fields of query / mutation / subscription documents.
func graphqlOps(text string) []Call {
	var out []Call
	for _, loc := range gqlOp.FindAllStringSubmatchIndex(text, -1) {
		kind := strings.ToUpper(text[loc[2]:loc[2]+1]) + text[loc[2]+1:loc[3]]
		for _, f := range topFields(text[loc[1]:], false) {
			out = append(out, Call{Method: "GRAPHQL", URL: "/graphql/" + kind + "." + f})
		}
	}
	return out
}

var gqlName = regexp.MustCompile(`^[A-Za-z_]\w*$`)

// topFields lists the field names at depth 1 of the block whose "{" was just consumed.
// In schemas a field is "name(args): Type"; in operations "alias: name(args) { ... }" or "name".
func topFields(s string, schema bool) []string {
	var out []string
	depth, paren := 1, 0
	var cur strings.Builder
	flush := func() {
		w := strings.TrimSpace(cur.String())
		cur.Reset()
		if w != "" && gqlName.MatchString(w) && !strings.HasPrefix(w, "__") && w != "on" {
			out = append(out, w)
		}
	}
	atField := true // start of a field name at depth 1
	for i := 0; i < len(s) && i < 20000; i++ {
		c := s[i]
		switch {
		case c == '"' && strings.HasPrefix(s[i:], `"""`): // description block
			j := strings.Index(s[i+3:], `"""`)
			if j < 0 {
				return out
			}
			i += 3 + j + 2
		case c == '#':
			for i < len(s) && s[i] != '\n' {
				i++
			}
		case c == '(':
			if depth == 1 && paren == 0 {
				flush()
			}
			paren++
		case c == ')':
			if paren > 0 {
				paren--
			}
		case paren > 0:
		case c == '{':
			if depth == 1 {
				flush()
			}
			depth++
		case c == '}':
			if depth == 1 {
				flush()
				return out
			}
			depth--
			if depth == 1 {
				atField = true
			}
		case depth == 1 && c == ':':
			if schema { // "name: Type" — name is the field, type follows
				flush()
				atField = false
			} else { // alias: drop it, the real field follows
				cur.Reset()
			}
		case depth == 1 && (c == '\n' || c == ',' || c == ' ' || c == '\t' || c == '\r'):
			if cur.Len() > 0 {
				flush()
				atField = !schema
				if schema {
					atField = false
				}
			}
			if c == '\n' && schema {
				atField = true
			}
		case depth == 1 && atField:
			cur.WriteByte(c)
		}
	}
	return out
}
