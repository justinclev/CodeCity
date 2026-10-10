package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/justinclev/codecity/internal/city"
)

func repo(t *testing.T) string { return repoWith(t, "package a\n") }

func repoWith(t *testing.T, content string) string {
	dir := t.TempDir()
	for _, a := range [][]string{{"init", "-q", "-b", "main"}, {"add", "-A"}, {"commit", "-q", "-m", "x"}} {
		if a[0] == "add" {
			os.WriteFile(dir+"/a.go", []byte(content), 0o644)
		}
		c := exec.Command("git", a...)
		c.Dir = dir
		c.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("%v %s", err, out)
		}
	}
	return dir
}

func do(h http.Handler, method, path, body, host, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Host = host
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestAnalyzeFlow(t *testing.T) {
	s := New("127.0.0.1:8080", t.TempDir())
	h := s.Handler()
	if w := do(h, "GET", "/api/city", "", "127.0.0.1:8080", ""); w.Code != 404 {
		t.Fatalf("city before analysis: %d", w.Code)
	}
	body, _ := json.Marshal(Request{Source: repo(t), MaxCommits: 5})
	if w := do(h, "POST", "/api/analyze", string(body), "127.0.0.1:8080", "http://127.0.0.1:8080"); w.Code != 202 {
		t.Fatalf("analyze: %d %s", w.Code, w.Body)
	}
	for i := 0; i < 100 && s.Current().State == "running"; i++ {
		time.Sleep(50 * time.Millisecond)
	}
	if j := s.Current(); j.State != "done" {
		t.Fatalf("job: %+v", j)
	}
	w := do(h, "GET", "/city.json", "", "localhost:8080", "")
	var c struct {
		Version int
		Commits []any
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &c) != nil || c.Version != city.Version || len(c.Commits) != 1 {
		t.Fatalf("city: %d %s", w.Code, w.Body)
	}
}

func TestGuards(t *testing.T) {
	h := New("127.0.0.1:8080", t.TempDir()).Handler()
	if w := do(h, "GET", "/api/status", "", "evil.example:8080", ""); w.Code != 403 {
		t.Errorf("rebinding host: %d", w.Code)
	}
	if w := do(h, "POST", "/api/analyze", `{"source":"x"}`, "127.0.0.1:8080", "https://evil.example"); w.Code != 403 {
		t.Errorf("cross-origin post: %d", w.Code)
	}
	if w := do(h, "POST", "/api/analyze", `{"source":""}`, "127.0.0.1:8080", ""); w.Code != 400 {
		t.Errorf("empty source: %d", w.Code)
	}
	if w := do(h, "POST", "/api/analyze", `{"source":"https://x/y","ref":"--upload-pack=a"}`, "127.0.0.1:8080", ""); w.Code != 400 {
		t.Errorf("bad ref: %d", w.Code)
	}
	// non-loopback server: no local paths
	rh := New("0.0.0.0:8080", t.TempDir()).Handler()
	for _, src := range []string{"/etc", "file:///tmp/x"} {
		b, _ := json.Marshal(Request{Source: src})
		if w := do(rh, "POST", "/api/analyze", string(b), "example.com:8080", ""); w.Code != 403 {
			t.Errorf("%s on public server: %d", src, w.Code)
		}
	}
}

func TestBusy(t *testing.T) {
	s := New("127.0.0.1:8080", t.TempDir())
	s.mu.Lock()
	s.job = &Job{State: "running"}
	s.mu.Unlock()
	if _, err := s.Start(Request{Source: "/x"}); err == nil || !strings.Contains(err.Error(), "already running") {
		t.Errorf("want conflict, got %v", err)
	}
}

func TestFileAPI(t *testing.T) {
	s := New("127.0.0.1:8080", t.TempDir())
	h := s.Handler()
	body, _ := json.Marshal(Request{Source: repo(t), MaxCommits: 5})
	if w := do(h, "POST", "/api/analyze", string(body), "127.0.0.1:8080", ""); w.Code != 202 {
		t.Fatalf("analyze: %d", w.Code)
	}
	for i := 0; i < 100 && s.Current().State == "running"; i++ {
		time.Sleep(50 * time.Millisecond)
	}
	defer s.Close()
	w := do(h, "GET", "/api/file?path=a.go&commit=0", "", "127.0.0.1:8080", "")
	var f FileResponse
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &f) != nil || f.Content != "package a\n" || f.Lang != "Go" || len(f.Pieces) == 0 {
		t.Fatalf("file: %d %s", w.Code, w.Body)
	}
	w = do(h, "GET", "/api/symbols", "", "127.0.0.1:8080", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"symbols"`) {
		t.Errorf("symbols: %d %s", w.Code, w.Body)
	}
	w = do(h, "GET", "/api/flow", "", "127.0.0.1:8080", "")
	var fg struct {
		Version int
		Nodes   []struct{ Name, Kind string }
		Commits map[string]string
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &fg) != nil || fg.Version != 1 || len(fg.Commits) != 1 {
		t.Errorf("flow: %d %.300s", w.Code, w.Body)
	}
	w = do(h, "GET", "/api/history?path=a.go", "", "127.0.0.1:8080", "")
	var hist HistoryResponse
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &hist) != nil || hist.Total != 1 || len(hist.Recent) != 1 ||
		hist.Recent[0].Subject != "x" || hist.Created == nil || hist.Created.Hash != hist.Recent[0].Hash {
		t.Errorf("history: %d %s", w.Code, w.Body)
	}
	if w := do(h, "GET", "/api/history?path=../x", "", "127.0.0.1:8080", ""); w.Code != 400 {
		t.Errorf("history of unknown path: %d", w.Code)
	}
	for _, q := range []string{"path=../../etc/passwd&commit=0", "path=a.go&commit=zzz", "path=a.go&commit=99"} {
		if w := do(h, "GET", "/api/file?"+q, "", "127.0.0.1:8080", ""); w.Code != 400 {
			t.Errorf("%s: %d", q, w.Code)
		}
	}
}

func TestRefsAPI(t *testing.T) {
	dir := repo(t)
	for _, a := range [][]string{{"branch", "feature/x"}, {"tag", "v1.2.0"}, {"tag", "-a", "v1.10.0", "-m", "annotated"}} {
		c := exec.Command("git", a...)
		c.Dir = dir
		c.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("%v %s", err, out)
		}
	}
	h := New("127.0.0.1:8080", t.TempDir()).Handler()
	body, _ := json.Marshal(map[string]string{"source": dir})
	w := do(h, "POST", "/api/refs", string(body), "127.0.0.1:8080", "http://127.0.0.1:8080")
	var r struct {
		Default, Current string
		Refs             []struct{ Name, Kind, Commit string }
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &r) != nil {
		t.Fatalf("refs: %d %s", w.Code, w.Body)
	}
	got := map[string]string{}
	for _, x := range r.Refs {
		got[x.Name] = x.Kind
		if len(x.Commit) != 40 {
			t.Errorf("%s: commit %q", x.Name, x.Commit)
		}
	}
	if r.Default != "main" || r.Current != "main" || got["main"] != "branch" || got["feature/x"] != "branch" || got["v1.2.0"] != "tag" || got["v1.10.0"] != "tag" {
		t.Errorf("refs: %+v", r)
	}
	// the annotated tag points at the commit, not the tag object
	for _, x := range r.Refs {
		if x.Name == "v1.10.0" && x.Commit != r.Refs[0].Commit {
			t.Errorf("annotated tag not peeled: %+v", x)
		}
	}
	if w := do(h, "POST", "/api/refs", string(body), "127.0.0.1:8080", "https://evil.example"); w.Code != 403 {
		t.Errorf("cross-origin refs: %d", w.Code)
	}
	if w := do(h, "POST", "/api/refs", `{"source":"--upload-pack=x"}`, "127.0.0.1:8080", ""); w.Code != 400 {
		t.Errorf("option-like source: %d", w.Code)
	}
	pub := New("0.0.0.0:8080", t.TempDir()).Handler()
	if w := do(pub, "POST", "/api/refs", string(body), "example.com:8080", ""); w.Code != 403 {
		t.Errorf("local path on public server: %d", w.Code)
	}
}

func TestMultiRepoFileAPI(t *testing.T) {
	s := New("127.0.0.1:8080", t.TempDir())
	h := s.Handler()
	a, b := repo(t), repoWith(t, "package b\n") // distinct content → distinct commit hashes
	body, _ := json.Marshal(Request{Sources: []string{a, b + " main"}, MaxCommits: 3})
	if w := do(h, "POST", "/api/analyze", string(body), "127.0.0.1:8080", ""); w.Code != 202 {
		t.Fatalf("analyze: %d %s", w.Code, w.Body)
	}
	for i := 0; i < 200 && s.Current().State == "running"; i++ {
		time.Sleep(50 * time.Millisecond)
	}
	defer s.Close()
	if j := s.Current(); j.State != "done" {
		t.Fatalf("job: %+v", j)
	}
	c := s.city
	if len(c.Repos) != 2 {
		t.Fatalf("repos = %+v", c.Repos)
	}
	for k, r := range c.Repos {
		var hash string
		for _, cm := range c.Commits {
			if cm.Repo == k {
				hash = cm.Hash
			}
		}
		w := do(h, "GET", "/api/file?path="+r.Name+"/a.go&commit="+hash[:10], "", "127.0.0.1:8080", "")
		if w.Code != 200 {
			t.Errorf("repo %d file: %d %s", k, w.Code, w.Body)
		}
		// a commit of the other repository must be rejected
		other := c.Repos[1-k].Name
		if w := do(h, "GET", "/api/file?path="+other+"/a.go&commit="+hash[:10], "", "127.0.0.1:8080", ""); w.Code != 400 {
			t.Errorf("cross-repo commit accepted: %d", w.Code)
		}
	}
	bad, _ := json.Marshal(Request{Sources: []string{"x y z"}})
	if w := do(h, "POST", "/api/analyze", string(bad), "127.0.0.1:8080", ""); w.Code != 400 {
		t.Errorf("bad line: %d", w.Code)
	}
}
