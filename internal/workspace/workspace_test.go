package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/justinclev/codecity/internal/analyze"
	"github.com/justinclev/codecity/internal/city"
)

func mkrepo(t *testing.T, author string, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME="+author, "GIT_AUTHOR_EMAIL=a@a", "GIT_COMMITTER_NAME=c", "GIT_COMMITTER_EMAIL=c@c")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	for p, c := range files {
		os.MkdirAll(filepath.Join(dir, filepath.Dir(p)), 0o755)
		os.WriteFile(filepath.Join(dir, p), []byte(c), 0o644)
	}
	run("add", "-A")
	run("commit", "-q", "-m", "init")
	return dir
}

func analyzeAll(t *testing.T, dirs ...string) []*city.City {
	var cs []*city.City
	for _, d := range dirs {
		c, err := analyze.Run(context.Background(), analyze.Options{Source: d, MaxCommits: 5}, nil)
		if err != nil {
			t.Fatal(err)
		}
		cs = append(cs, c)
	}
	return cs
}

func TestBuildLinksAndMerge(t *testing.T) {
	lib := mkrepo(t, "Ann", map[string]string{
		"go.mod":           "module example.com/acme/lib\n\ngo 1.22\n",
		"pkg/util/util.go": "package util\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n",
		"pkg/other/x.go":   "package other\n",
		"README.md":        "# lib\n",
	})
	app := mkrepo(t, "ann", map[string]string{ // same person, different capitalization
		"go.mod":     "module example.com/acme/app\n\nrequire example.com/acme/lib v1.0.0\n",
		"main.go":    "package main\n\nimport (\n\t\"fmt\"\n\t\"example.com/acme/lib/pkg/util\"\n)\n\nfunc main() { fmt.Println(util.Add(1, 2)) }\n",
		"cmd/x/x.go": "package main\n\nimport \"fmt\"\n\nfunc main() { fmt.Println() }\n",
	})
	tool := mkrepo(t, "Bob", map[string]string{
		"pyproject.toml":   "[project]\nname = \"tool\"\ndependencies = [\"requests\"]\n",
		"tool/__init__.py": "import requests\n",
	})
	cs := analyzeAll(t, lib, app, tool)
	w := Build(cs)

	if len(w.Repos) != 3 || w.Districts[0].Depth != -1 {
		t.Fatalf("repos = %+v", w.Repos)
	}
	var dep, people []city.Link
	for _, l := range w.Links {
		switch l.Kind {
		case "dependency":
			dep = append(dep, l)
		case "people":
			people = append(people, l)
		}
	}
	if len(dep) != 1 || dep[0].From != 1 || dep[0].To != 0 {
		t.Fatalf("dependency links = %+v", dep)
	}
	ev := strings.Join(dep[0].Evidence, "; ")
	if !strings.Contains(ev, "go.mod declares Go module example.com/acme/lib") || !strings.Contains(ev, "1 file import it") {
		t.Errorf("evidence = %s", ev)
	}
	if len(dep[0].Files) != 1 {
		t.Fatalf("files = %v", dep[0].Files)
	}
	from, to := w.Buildings[dep[0].Files[0][0]], w.Districts[dep[0].Files[0][1]]
	if from.Path != w.Repos[1].Name+"/main.go" || to.Path != w.Repos[0].Name+"/pkg/util" {
		t.Errorf("file link %s -> %s", from.Path, to.Path)
	}
	if len(people) != 1 || people[0].PeopleCount != 1 || people[0].From != 0 || people[0].To != 1 {
		t.Errorf("people links = %+v", people)
	}

	// merged structure
	seen := map[string]bool{}
	for _, b := range w.Buildings {
		if seen[b.Path] {
			t.Errorf("duplicate path %s", b.Path)
		}
		seen[b.Path] = true
		root := w.Districts[w.Repos[b.Repo].District]
		if b.X < root.X || b.Z < root.Z || b.X+b.W > root.X+root.W+1e-6 || b.Z+b.D > root.Z+root.D+1e-6 {
			t.Errorf("%s outside its city", b.Path)
		}
		for _, p := range b.H {
			if p[0] < 0 || p[0] >= len(w.Commits) || w.Commits[p[0]].Repo != b.Repo {
				t.Errorf("%s history point %v maps to wrong commit", b.Path, p)
			}
		}
	}
	// cities do not overlap
	for i := range w.Repos {
		for j := i + 1; j < len(w.Repos); j++ {
			a, b := w.Districts[w.Repos[i].District], w.Districts[w.Repos[j].District]
			if a.X < b.X+b.W && b.X < a.X+a.W && a.Z < b.Z+b.D && b.Z < a.Z+a.D {
				t.Errorf("cities %d and %d overlap", i, j)
			}
		}
	}
	if len(w.Commits) != 3 || w.Stats.Files != cs[0].Stats.Files+cs[1].Stats.Files+cs[2].Stats.Files {
		t.Errorf("commits=%d files=%d", len(w.Commits), w.Stats.Files)
	}
	if len(w.Authors) != 2 { // Ann + ann merged, Bob
		t.Errorf("authors = %+v", w.Authors)
	}
	// single repo: unchanged
	if Build(cs[:1]) != cs[0] {
		t.Error("single repo should pass through")
	}
}

func TestHighways(t *testing.T) {
	orders := mkrepo(t, "Ann", map[string]string{
		"go.mod": "module example.com/acme/orders\n\ngo 1.22\n",
		"main.go": `package main

import "net/http"

func main() {
	http.HandleFunc("/api/orders", list)
	http.HandleFunc("/health", list)
	http.ListenAndServe(":80", nil)
}

func list(w http.ResponseWriter, r *http.Request) {}
`,
		"pub.go": `package main

import "github.com/segmentio/kafka-go"

const TopicCreated = "orders.created"

func publish() { w := &kafka.Writer{Topic: TopicCreated}; _ = w }
`,
	})
	web := mkrepo(t, "Ann", map[string]string{
		"go.mod": "module example.com/acme/web\n\ngo 1.22\n",
		"call.go": `package main

import "net/http"

func fetch() { http.Get("http://localhost:8080/api/orders"); http.Get("http://other/health") }
`,
		"sub.go": `package main

import "github.com/segmentio/kafka-go"

func consume() { _ = kafka.NewReader(kafka.ReaderConfig{Topic: "orders.created"}) }
`,
	})
	cs := analyzeAll(t, orders, web)
	w := Build(cs)
	kinds := map[string]city.Link{}
	for _, l := range w.Links {
		kinds[l.Kind] = l
	}
	api, ok := kinds["api"]
	if !ok || len(api.Via) != 1 || api.Via[0].Label != "GET /api/orders" && api.Via[0].Label != "/api/orders" {
		t.Fatalf("api link: %+v (links %+v)", api, w.Links)
	}
	msg, ok := kinds["message"]
	if !ok || len(msg.Via) != 1 || msg.Via[0].Label != "orders.created" || msg.Brokers[0] != "kafka" {
		t.Fatalf("message link: %+v", msg)
	}
	// message flows publisher → subscriber; indices point at the right files in the merged city
	if got := w.Buildings[msg.Via[0].From].Path; !strings.HasSuffix(got, "pub.go") {
		t.Fatalf("publisher building = %s", got)
	}
	if got := w.Buildings[msg.Via[0].To].Path; !strings.HasSuffix(got, "sub.go") {
		t.Fatalf("subscriber building = %s", got)
	}
	if got := w.Buildings[api.Via[0].To].Path; !strings.HasSuffix(got, "main.go") {
		t.Fatalf("serving building = %s", got)
	}
}

func TestHostNames(t *testing.T) {
	for _, c := range []struct {
		host, repo string
		want       bool
	}{{"orders-service:8080", "orders", true}, {"orders.internal.corp", "orders-service", true}, {"api.stripe.com", "orders", false}, {"db", "dashboard", false}} {
		if got := hostNames(c.host, c.repo); got != c.want {
			t.Errorf("hostNames(%q,%q)=%v", c.host, c.repo, got)
		}
	}
}

// TestExampleHighways builds the services under examples/highways into git repos and checks
// every highway the viewer should draw (the same repos power `make demo`).
func TestExampleHighways(t *testing.T) {
	root := filepath.Join("..", "..", "examples", "highways")
	names := []string{"gateway", "orders", "payments", "users", "web", "notifications"}
	var dirs []string
	for _, n := range names {
		files := map[string]string{}
		filepath.Walk(filepath.Join(root, n), func(p string, info os.FileInfo, err error) error {
			if err == nil && !info.IsDir() {
				b, _ := os.ReadFile(p)
				rel, _ := filepath.Rel(filepath.Join(root, n), p)
				files[filepath.ToSlash(rel)] = string(b)
			}
			return nil
		})
		dir := mkrepo(t, "Dev", files)
		named := filepath.Join(filepath.Dir(dir), "ex-"+n) // the repo's name = its directory name
		if err := os.Rename(dir, named); err != nil {
			t.Fatal(err)
		}
		dirs = append(dirs, named)
	}
	w := Build(analyzeAll(t, dirs...))
	name := func(i int) string { return w.Repos[i].Name }
	got := map[string]bool{}
	for _, l := range w.Links {
		switch l.Kind {
		case "api":
			for _, v := range l.Via {
				got["api "+name(l.From)+"→"+name(l.To)+" "+v.Label] = true
			}
		case "message":
			for _, v := range l.Via {
				got["message "+name(l.From)+"→"+name(l.To)+" "+v.Label] = true
			}
		}
	}
	for _, want := range []string{
		"api ex-web→ex-gateway /api/shop/orders",
		"api ex-web→ex-gateway /api/shop/profile",
		"api ex-gateway→ex-orders GET /internal/orders",
		"api ex-gateway→ex-users GET /internal/users/me",
		"api ex-payments→ex-users GET /internal/users/me",
		"message ex-orders→ex-payments orders.created",
		"message ex-payments→ex-orders payments.completed",
		"message ex-payments→ex-notifications payments.completed",
	} {
		if !got[want] {
			t.Errorf("missing highway %q", want)
		}
	}
	if t.Failed() {
		t.Logf("found: %v", got)
	}
}

// exampleWorld builds every directory under examples/<name> into a git repository named ex-<dir>.
func exampleWorld(t *testing.T, name string) *city.City {
	t.Helper()
	root := filepath.Join("..", "..", "examples", name)
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	var dirs []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		files := map[string]string{}
		filepath.Walk(filepath.Join(root, e.Name()), func(p string, info os.FileInfo, err error) error {
			if err == nil && !info.IsDir() {
				b, _ := os.ReadFile(p)
				rel, _ := filepath.Rel(filepath.Join(root, e.Name()), p)
				files[filepath.ToSlash(rel)] = string(b)
			}
			return nil
		})
		dir := mkrepo(t, "Dev", files)
		named := filepath.Join(filepath.Dir(dir), "ex-"+e.Name())
		if err := os.Rename(dir, named); err != nil {
			t.Fatal(err)
		}
		dirs = append(dirs, named)
	}
	return Build(analyzeAll(t, dirs...))
}

func highways(w *city.City) map[string]bool {
	got := map[string]bool{}
	for _, l := range w.Links {
		if l.Kind == "dependency" || l.Kind == "people" {
			continue
		}
		for _, v := range l.Via {
			got[l.Kind+" "+w.Repos[l.From].Name+"→"+w.Repos[l.To].Name+" "+v.Label] = true
		}
	}
	return got
}

func TestExampleHighwaysMore(t *testing.T) {
	got := highways(exampleWorld(t, "highways"))
	for _, want := range []string{
		"api ex-gateway→ex-partners GET /partners/{id}/offers",   // OpenAPI spec only
		"api ex-dashboard→ex-reports /api/reports",               // URL from REPORTS_URL in docker-compose
		"api ex-dashboard→ex-graphql-api GraphQL Query.products", // GraphQL
		"api ex-dashboard→ex-notifications GET /ws",              // WebSocket
		"message ex-orders→ex-inventory orders.created",          // Java @KafkaListener
		"message ex-orders→ex-analytics orders.created",          // AsyncAPI v3 receive
		"data ex-orders→ex-reports shop_orders",                  // shared table: orders writes, reports reads
	} {
		if !got[want] {
			t.Errorf("missing highway %q", want)
		}
	}
	if t.Failed() {
		t.Logf("found: %v", got)
	}
}

func TestExampleHighwaysLanguages(t *testing.T) {
	got := highways(exampleWorld(t, "highways-lang"))
	for _, want := range []string{
		"api ex-search→ex-catalog GET /api/catalog/items", // host "catalog-api" is the compose service of ex-catalog; FastAPI route; Rust call
		"api ex-legacy→ex-search GET /api/search",         // Flask → axum
		"api ex-billing→ex-ledger gRPC Ledger",            // C# gRPC client → Go server
	} {
		if !got[want] {
			t.Errorf("missing highway %q", want)
		}
	}
	if t.Failed() {
		t.Logf("found: %v", got)
	}
}

func TestHostNamesAliases(t *testing.T) {
	if hostNames("gw-internal:80", "edge") {
		t.Fatal("unrelated host must not match")
	}
	if !hostNames("gw-internal:80", "edge", "gw-internal") {
		t.Fatal("a compose / Kubernetes service alias names its repository")
	}
}
