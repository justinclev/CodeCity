// Package server serves the viewer and an API for analyzing repositories from the page.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"

	"github.com/justinclev/codecity/internal/analyze"
	"github.com/justinclev/codecity/internal/city"
	"github.com/justinclev/codecity/internal/gitx"
	"github.com/justinclev/codecity/internal/web"
)

// Request is the body of POST /api/analyze.
type Request struct {
	Source     string `json:"source"`
	Ref        string `json:"ref"`
	MaxCommits int    `json:"maxCommits"`
	NoChurn    bool   `json:"noChurn"`
}

// Job is the externally visible state of an analysis.
type Job struct {
	ID     int     `json:"id"`
	State  string  `json:"state"` // running | done | error | cancelled
	Stage  string  `json:"stage"`
	Done   int     `json:"done"`
	Total  int     `json:"total"`
	Error  string  `json:"error,omitempty"`
	Source string  `json:"source"`
	Req    Request `json:"request"`
}

const MaxCommitsLimit = 1000

type Server struct {
	// Extra defaults applied to every analysis (CLI --exclude etc).
	Base analyze.Options

	webDir     string
	allowLocal bool // local paths / file:// may be analyzed from the page
	allowHosts map[string]bool

	mu     sync.Mutex
	body   []byte
	job    *Job
	cancel context.CancelFunc
	nextID int
}

// New creates a server. addr is the listen address; local paths are only
// accepted from the page when it is a loopback address.
func New(addr, webDir string) *Server {
	s := &Server{webDir: webDir, allowHosts: map[string]bool{}}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	ip := net.ParseIP(host)
	s.allowLocal = host == "localhost" || (ip != nil && ip.IsLoopback())
	if s.allowLocal { // DNS-rebinding protection: only answer to loopback host names
		for _, h := range []string{"localhost", "127.0.0.1", "::1"} {
			s.allowHosts[h] = true
		}
	}
	return s
}

// Start begins an analysis in the background.
func (s *Server) Start(req Request) (int, error) {
	req.Source = strings.TrimSpace(req.Source)
	req.Ref = strings.TrimSpace(req.Ref)
	if req.Source == "" {
		return 0, errBad("source is required")
	}
	if strings.HasPrefix(req.Ref, "-") {
		return 0, errBad("invalid ref")
	}
	if req.MaxCommits < 1 {
		req.MaxCommits = 1
	}
	if req.MaxCommits > MaxCommitsLimit {
		req.MaxCommits = MaxCommitsLimit
	}
	if !s.allowLocal && (!gitx.IsURL(req.Source) || strings.HasPrefix(req.Source, "file://")) {
		return 0, errForbidden("this server only analyzes remote git URLs (it is not bound to a loopback address)")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.job != nil && s.job.State == "running" {
		return 0, errConflict("an analysis is already running")
	}
	s.nextID++
	j := &Job{ID: s.nextID, State: "running", Stage: "starting", Source: req.Source, Req: req}
	s.job = j
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel

	opts := s.Base
	opts.Source, opts.Ref, opts.MaxCommits, opts.NoChurn = req.Source, req.Ref, req.MaxCommits, req.NoChurn || s.Base.NoChurn
	go func() {
		defer cancel()
		c, err := analyze.Run(ctx, opts, func(stage string, done, total int) {
			s.mu.Lock()
			if s.job == j {
				j.Stage, j.Done, j.Total = stage, done, total
			}
			s.mu.Unlock()
		})
		s.finish(j, c, err, ctx)
	}()
	return j.ID, nil
}

func (s *Server) finish(j *Job, c *city.City, err error, ctx context.Context) {
	var body []byte
	if err == nil {
		body, err = json.Marshal(c)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case ctx.Err() != nil:
		j.State = "cancelled"
	case err != nil:
		j.State, j.Error = "error", err.Error()
	default:
		j.State = "done"
		s.body = body
	}
}

// Current returns a copy of the latest job (zero value if none).
func (s *Server) Current() Job {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.job == nil {
		return Job{}
	}
	return *s.job
}

type httpErr struct {
	code int
	msg  string
}

func (e *httpErr) Error() string  { return e.msg }
func errBad(m string) error       { return &httpErr{http.StatusBadRequest, m} }
func errForbidden(m string) error { return &httpErr{http.StatusForbidden, m} }
func errConflict(m string) error  { return &httpErr{http.StatusConflict, m} }

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	code := http.StatusInternalServerError
	var he *httpErr
	if errors.As(err, &he) {
		code = he.code
	}
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

// Handler returns the HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	serveCity := func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		body := s.body
		s.mu.Unlock()
		if body == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "no city analyzed yet"})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(body)
	}
	mux.HandleFunc("GET /city.json", serveCity)
	mux.HandleFunc("GET /api/city", serveCity)
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		out := map[string]any{"hasCity": s.body != nil, "allowLocal": s.allowLocal, "maxCommitsLimit": MaxCommitsLimit}
		if s.job != nil {
			out["job"] = s.job
		}
		writeJSON(w, http.StatusOK, out)
	})
	mux.HandleFunc("POST /api/analyze", func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			writeErr(w, errBad("content-type must be application/json"))
			return
		}
		var req Request
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		if err := dec.Decode(&req); err != nil {
			writeErr(w, errBad("invalid JSON body"))
			return
		}
		id, err := s.Start(req)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]int{"id": id})
	})
	mux.HandleFunc("POST /api/cancel", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		if s.cancel != nil && s.job != nil && s.job.State == "running" {
			s.cancel()
		}
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	var static fs.FS = web.FS()
	if s.webDir != "" {
		static = os.DirFS(s.webDir)
	}
	mux.Handle("/", http.FileServerFS(static))
	return s.guard(mux)
}

// guard rejects requests whose Host is not loopback (DNS rebinding) and
// state-changing requests from other origins (CSRF).
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(s.allowHosts) > 0 {
			h := r.Host
			if hh, _, err := net.SplitHostPort(h); err == nil {
				h = hh
			}
			if !s.allowHosts[strings.Trim(h, "[]")] {
				http.Error(w, "forbidden host", http.StatusForbidden)
				return
			}
		}
		if r.Method == http.MethodPost {
			if o := r.Header.Get("Origin"); o != "" {
				u, err := url.Parse(o)
				if err != nil || u.Host != r.Host {
					http.Error(w, "forbidden origin", http.StatusForbidden)
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// HasViewer reports whether a viewer build is available.
func HasViewer(webDir string) bool {
	var static fs.FS = web.FS()
	if webDir != "" {
		static = os.DirFS(webDir)
	}
	_, err := fs.Stat(static, "index.html")
	return err == nil
}
