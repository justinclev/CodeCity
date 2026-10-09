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

func repo(t *testing.T) string {
	dir := t.TempDir()
	for _, a := range [][]string{{"init", "-q", "-b", "main"}, {"add", "-A"}, {"commit", "-q", "-m", "x"}} {
		if a[0] == "add" {
			os.WriteFile(dir+"/a.go", []byte("package a\n"), 0o644)
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
	for _, q := range []string{"path=../../etc/passwd&commit=0", "path=a.go&commit=zzz", "path=a.go&commit=99"} {
		if w := do(h, "GET", "/api/file?"+q, "", "127.0.0.1:8080", ""); w.Code != 400 {
			t.Errorf("%s: %d", q, w.Code)
		}
	}
}
