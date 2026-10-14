// Package server serves the viewer and an API for analyzing repositories from the page.
package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/justinclev/codecity/internal/analyze"
	"github.com/justinclev/codecity/internal/city"
	"github.com/justinclev/codecity/internal/flow"
	"github.com/justinclev/codecity/internal/gitx"
	"github.com/justinclev/codecity/internal/outline"
	"github.com/justinclev/codecity/internal/scan"
	"github.com/justinclev/codecity/internal/web"
	"github.com/justinclev/codecity/internal/workspace"
)

// Request is the body of POST /api/analyze.
type Request struct {
	// Sources lists repositories, one "source [ref]" per entry; Source is the single-repo shorthand.
	Sources    []string `json:"sources,omitempty"`
	Source     string   `json:"source,omitempty"`
	Ref        string   `json:"ref"` // default ref for entries without one
	MaxCommits int      `json:"maxCommits"`
	NoChurn    bool     `json:"noChurn"`
	Split      bool     `json:"split"` // split a monolithic repo into one city per project
}

// MaxRepos caps how many repositories one analysis may combine.
const MaxRepos = 12

type target struct{ source, ref string }

// targets parses and validates the requested repositories.
func (s *Server) targets(req *Request) ([]target, error) {
	lines := req.Sources
	if len(lines) == 0 && strings.TrimSpace(req.Source) != "" {
		lines = []string{req.Source}
	}
	var out []target
	seen := map[string]bool{}
	for _, ln := range lines {
		f := strings.Fields(ln)
		if len(f) == 0 || strings.HasPrefix(f[0], "#") {
			continue
		}
		t := target{source: f[0], ref: req.Ref}
		if len(f) > 1 {
			t.ref = f[1]
		}
		if len(f) > 2 || strings.HasPrefix(t.ref, "-") {
			return nil, errBad(fmt.Sprintf("invalid line %q (expected: source [ref])", ln))
		}
		if !s.allowLocal && (!gitx.IsURL(t.source) || strings.HasPrefix(t.source, "file://")) {
			return nil, errForbidden("this server only analyzes remote git URLs (it is not bound to a loopback address)")
		}
		if key := t.source + " " + t.ref; !seen[key] {
			seen[key] = true
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		return nil, errBad("source is required")
	}
	if len(out) > MaxRepos {
		return nil, errBad(fmt.Sprintf("at most %d repositories at once", MaxRepos))
	}
	return out, nil
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

	mu    sync.Mutex
	body  []byte
	city  *city.City
	repos []*gitx.Repo // kept open for /api/file, indexed like city.Repos
	// symbols is the lazily built definition index for /api/symbols (nil until requested)
	symbols   []byte
	symbolsMu sync.Mutex
	// flow is the lazily built flow graph for /api/flow (gzip-compressed JSON)
	flow   []byte
	flowMu sync.Mutex
	paths  map[string]fileRef // building path → repo + path inside it
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
	if strings.HasPrefix(req.Ref, "-") {
		return 0, errBad("invalid ref")
	}
	targets, err := s.targets(&req)
	if err != nil {
		return 0, err
	}
	if req.MaxCommits < 1 {
		req.MaxCommits = 1
	}
	if req.MaxCommits > MaxCommitsLimit {
		req.MaxCommits = MaxCommitsLimit
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.job != nil && s.job.State == "running" {
		return 0, errConflict("an analysis is already running")
	}
	s.nextID++
	var names []string
	for _, t := range targets {
		names = append(names, t.source)
	}
	j := &Job{ID: s.nextID, State: "running", Stage: "starting", Source: strings.Join(names, ", "), Req: req}
	s.job = j
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel

	go func() {
		defer cancel()
		var cities []*city.City
		var repos []*gitx.Repo
		var err error
		for k, t := range targets {
			opts := s.Base
			opts.Source, opts.Ref, opts.MaxCommits, opts.NoChurn = t.source, t.ref, req.MaxCommits, req.NoChurn || s.Base.NoChurn
			opts.Split = req.Split || s.Base.Split
			prefix := ""
			if len(targets) > 1 {
				prefix = fmt.Sprintf("[%d/%d] %s: ", k+1, len(targets), shortName(t.source))
			}
			var cs []*city.City
			var repo *gitx.Repo
			cs, repo, err = analyze.RunRepoN(ctx, opts, func(stage string, done, total int) {
				s.mu.Lock()
				if s.job == j {
					j.Stage, j.Done, j.Total = prefix+stage, done, total
				}
				s.mu.Unlock()
			})
			if err != nil {
				if len(targets) > 1 {
					err = fmt.Errorf("%s: %w", t.source, err)
				}
				break
			}
			cities = append(cities, cs...)
			for range cs { // one city per project shares the repo's single clone
				repos = append(repos, repo)
			}
		}
		var world *city.City
		if err == nil {
			s.mu.Lock()
			j.Stage, j.Done, j.Total = "linking repositories", 0, 0
			s.mu.Unlock()
			world = workspace.Build(cities)
		}
		s.finish(j, world, repos, err, ctx)
	}()
	return j.ID, nil
}

func shortName(src string) string {
	src = strings.TrimSuffix(strings.TrimRight(src, "/"), ".git")
	if i := strings.LastIndexAny(src, "/:"); i >= 0 {
		return src[i+1:]
	}
	return src
}

func (s *Server) finish(j *Job, c *city.City, repos []*gitx.Repo, err error, ctx context.Context) {
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
		s.body, s.city, s.symbols, s.flow = body, c, nil, nil
		s.paths = make(map[string]fileRef, len(c.Buildings))
		for _, b := range c.Buildings {
			orig := b.Path
			base := ""
			if len(c.Repos) > 0 {
				orig = strings.TrimPrefix(b.Path, c.Repos[b.Repo].Name+"/")
				base = c.Repos[b.Repo].Base
			} else {
				base = c.Repo.Base
			}
			if base != "" { // a monorepo project: the blob lives under its subdir
				orig = base + "/" + orig
			}
			s.paths[b.Path] = fileRef{repo: b.Repo, path: orig, lang: b.Lang}
			for _, df := range b.Docs { // documents inside a library building are not buildings themselves
				if df.Path == "" { // a listed dependency, not an openable file
					continue
				}
				dorig := df.Path
				if len(c.Repos) > 0 {
					dorig = strings.TrimPrefix(df.Path, c.Repos[b.Repo].Name+"/")
				}
				if base != "" {
					dorig = base + "/" + dorig
				}
				s.paths[df.Path] = fileRef{repo: b.Repo, path: dorig, lang: df.Lang}
			}
		}
		if old := s.repos; len(old) > 0 { // let in-flight file reads finish before removing temp clones
			time.AfterFunc(30*time.Second, func() { closeRepos(old) })
		}
		s.repos, repos = repos, nil
	}
	closeRepos(repos)
}

// closeRepos closes each distinct repository once (monorepo projects share one clone).
func closeRepos(repos []*gitx.Repo) {
	seen := map[*gitx.Repo]bool{}
	for _, r := range repos {
		if r != nil && !seen[r] {
			seen[r] = true
			r.Close()
		}
	}
}

type fileRef struct {
	repo       int
	path, lang string
}

// Close releases the open repository (removing a temporary clone).
func (s *Server) Close() {
	s.mu.Lock()
	repos := s.repos
	s.repos = nil
	if s.cancel != nil {
		s.cancel()
	}
	s.mu.Unlock()
	closeRepos(repos)
}

// maxSymbols caps the definition index.
const maxSymbols = 150000

// Symbols returns the definition index of the loaded world at each repository's
// newest analyzed commit: JSON {"symbols": [[name, kind, path, start, end], ...]}.
// It is built on first use (it reads every code file) and cached.
func (s *Server) Symbols(ctx context.Context) ([]byte, error) {
	s.symbolsMu.Lock()
	defer s.symbolsMu.Unlock()
	s.mu.Lock()
	c, repos, cached := s.city, s.repos, s.symbols
	s.mu.Unlock()
	if cached != nil {
		return cached, nil
	}
	if c == nil || len(repos) == 0 {
		return nil, &httpErr{http.StatusNotFound, "no repository loaded"}
	}
	type sym = [5]any
	var out []sym
	for k, repo := range repos {
		commit := c.Repo.Commit
		prefix, base := "", ""
		if len(c.Repos) > 0 {
			commit = c.Repos[k].Commit
			prefix = c.Repos[k].Name + "/"
			base = c.Repos[k].Base
		}
		entries, err := repo.ListFiles(ctx, commit)
		if err != nil {
			return nil, err
		}
		oid := make(map[string]string, len(entries))
		for _, e := range entries {
			oid[e.Path] = e.Oid
		}
		br, err := repo.NewBlobReader(ctx)
		if err != nil {
			return nil, err
		}
		for _, b := range c.Buildings {
			if b.Repo != k || !outline.Supported(b.Lang) || len(out) >= maxSymbols {
				continue
			}
			gp := strings.TrimPrefix(b.Path, prefix)
			if base != "" {
				gp = base + "/" + gp
			}
			o, ok := oid[gp]
			if !ok {
				continue
			}
			content, err := br.Read(o, maxFileBytes)
			if err != nil {
				br.Close()
				return nil, err
			}
			for _, p := range outline.Outline(b.Lang, content) {
				if p.Kind == "imports" || p.Kind == "scope" || p.Name == "" {
					continue
				}
				out = append(out, sym{p.Name, p.Kind, b.Path, p.Start, p.End})
			}
		}
		br.Close()
	}
	body, err := json.Marshal(map[string]any{"symbols": out})
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if s.city == c {
		s.symbols = body
	}
	s.mu.Unlock()
	return body, nil
}

// FileResponse is the body of GET /api/file.
type FileResponse struct {
	Path    string          `json:"path"`
	Commit  string          `json:"commit"`
	Lang    string          `json:"lang"`
	Content string          `json:"content"`
	Lines   int             `json:"lines"`
	Pieces  []outline.Piece `json:"pieces"`
	Partial bool            `json:"partial,omitempty"` // content was truncated
}

const maxFileBytes = 1 << 20

// File returns the content and outline of a file of the loaded city at one of its commits.
func (s *Server) File(ctx context.Context, path, commit string) (*FileResponse, error) {
	s.mu.Lock()
	c, repos, paths := s.city, s.repos, s.paths
	s.mu.Unlock()
	if c == nil || len(repos) == 0 {
		return nil, &httpErr{http.StatusNotFound, "no repository loaded"}
	}
	ref, ok := paths[path]
	if !ok {
		return nil, errBad("unknown path")
	}
	lang := ref.lang
	// the commit must be one of this repository's analyzed commits
	hash := ""
	// a commit belongs to ref.repo, or to any city sharing the same underlying
	// clone (a monorepo split into project-cities shares one timeline).
	sameClone := func(r int) bool {
		return r == ref.repo || (r >= 0 && r < len(repos) && ref.repo < len(repos) && repos[r] == repos[ref.repo])
	}
	if i, err := strconv.Atoi(commit); err == nil && i >= 0 && i < len(c.Commits) && sameClone(c.Commits[i].Repo) {
		hash = c.Commits[i].Hash
	} else if len(commit) >= 4 {
		for _, k := range c.Commits {
			if sameClone(k.Repo) && strings.HasPrefix(k.Hash, commit) {
				hash = k.Hash
				break
			}
		}
	}
	if hash == "" {
		return nil, errBad("unknown commit")
	}
	b, err := repos[ref.repo].ReadFile(ctx, hash, ref.path, maxFileBytes+1)
	if err != nil {
		return nil, &httpErr{http.StatusNotFound, "file not present at that commit"}
	}
	partial := len(b) > maxFileBytes
	if partial {
		b = b[:maxFileBytes]
	}
	if scan.ContentSkip(b, scan.Options{IncludeGenerated: true}) == "binary" {
		return nil, errBad("binary file")
	}
	text := strings.ToValidUTF8(string(b), "\uFFFD")
	pieces := outline.Outline(lang, []byte(text))
	lines := strings.Count(text, "\n")
	if text != "" && !strings.HasSuffix(text, "\n") {
		lines++
	}
	return &FileResponse{Path: path, Commit: hash, Lang: lang, Content: text, Lines: lines, Pieces: pieces, Partial: partial}, nil
}

// Flow returns the flow graph of the loaded city at each repository's newest commit, as gzip-compressed JSON.
func (s *Server) Flow(ctx context.Context) ([]byte, error) {
	s.flowMu.Lock()
	defer s.flowMu.Unlock()
	s.mu.Lock()
	c, repos, cached := s.city, s.repos, s.flow
	s.mu.Unlock()
	if cached != nil {
		return cached, nil
	}
	if c == nil || len(repos) == 0 {
		return nil, &httpErr{http.StatusNotFound, "no repository loaded"}
	}
	const maxFiles, maxBytes = 25000, 96 << 20
	var groups []flow.Repo
	total, count := 0, 0
	for k, repo := range repos {
		commit, prefix := c.Repo.Commit, ""
		if len(c.Repos) > 0 {
			commit, prefix = c.Repos[k].Commit, c.Repos[k].Name+"/"
		}
		entries, err := repo.ListFiles(ctx, commit)
		if err != nil {
			return nil, err
		}
		br, err := repo.NewBlobReader(ctx)
		if err != nil {
			return nil, err
		}
		g := flow.Repo{Prefix: prefix, Commit: commit}
		for _, e := range entries {
			lang := scan.Language(e.Path)
			if !flow.Wanted(e.Path, lang) || e.Size > maxFileBytes || count >= maxFiles || total >= maxBytes ||
				strings.Contains("/"+e.Path, "/node_modules/") || strings.Contains("/"+e.Path, "/vendor/") || strings.HasSuffix(e.Path, ".min.js") {
				continue
			}
			content, err := br.Read(e.Oid, maxFileBytes)
			if err != nil {
				br.Close()
				return nil, err
			}
			if scan.ContentSkip(content, scan.Options{}) != "" { // generated, minified, binary
				continue
			}
			g.Files = append(g.Files, flow.File{Path: e.Path, Lang: lang, Content: content})
			total += len(content)
			count++
		}
		br.Close()
		groups = append(groups, g)
		if err := ctx.Err(); err != nil {
			return nil, err
		}
	}
	graph := flow.BuildAll(groups, flow.Options{})
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if err := json.NewEncoder(zw).Encode(graph); err != nil {
		return nil, err
	}
	zw.Close()
	body := buf.Bytes()
	s.mu.Lock()
	if s.city == c {
		s.flow = body
	}
	s.mu.Unlock()
	return body, nil
}

// HistoryResponse explains where a file came from: the commit that added it and its recent changes.
type HistoryResponse struct {
	Path    string            `json:"path"`
	Total   int               `json:"total"`             // non-merge commits touching the file
	Created *gitx.FileCommit  `json:"created,omitempty"` // the (oldest) commit that added it
	Recent  []gitx.FileCommit `json:"recent"`            // newest first
}

// History returns the commit history of a file of the loaded city, as of its repository's newest analyzed commit.
func (s *Server) History(ctx context.Context, path string, n int) (*HistoryResponse, error) {
	s.mu.Lock()
	c, repos, paths := s.city, s.repos, s.paths
	s.mu.Unlock()
	if c == nil || len(repos) == 0 {
		return nil, &httpErr{http.StatusNotFound, "no repository loaded"}
	}
	ref, ok := paths[path]
	if !ok {
		return nil, errBad("unknown path")
	}
	tip := c.Repo.Commit // the analyzed newest commit of this (sub-)repo
	if len(c.Repos) > 0 && ref.repo < len(c.Repos) {
		tip = c.Repos[ref.repo].Commit
	}
	if tip == "" {
		return nil, errBad("no commits for this repository")
	}
	if n <= 0 || n > 50 {
		n = 12
	}
	repo := repos[ref.repo]
	recent, err := repo.FileLog(ctx, tip, ref.path, n, false)
	if err != nil {
		return nil, err
	}
	out := &HistoryResponse{Path: path, Recent: recent}
	if recent == nil {
		out.Recent = []gitx.FileCommit{}
	}
	if total, err := repo.FileCommitCount(ctx, tip, ref.path); err == nil {
		out.Total = total
	}
	// shallow clones have no history to speak of; the oldest "add" is where the file was born
	if added, err := repo.FileLog(ctx, tip, ref.path, 0, true); err == nil && len(added) > 0 {
		out.Created = &added[len(added)-1]
	}
	return out, nil
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
	mux.HandleFunc("GET /api/file", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		f, err := s.File(r.Context(), q.Get("path"), q.Get("commit"))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, f)
	})
	// POST (not GET) so the Origin check applies: listing refs may contact a remote host.
	mux.HandleFunc("POST /api/refs", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Source string `json:"source"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&body); err != nil || strings.TrimSpace(body.Source) == "" {
			writeErr(w, errBad("source is required"))
			return
		}
		src := strings.TrimSpace(body.Source)
		if strings.HasPrefix(src, "-") || strings.ContainsAny(src, "\n\r") {
			writeErr(w, errBad("invalid source"))
			return
		}
		if !s.allowLocal && (!gitx.IsURL(src) || strings.HasPrefix(src, "file://")) {
			writeErr(w, errForbidden("this server only lists refs of remote git URLs"))
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		defer cancel()
		refs, err := gitx.ListRefs(ctx, src)
		if err != nil {
			writeErr(w, errBad(err.Error()))
			return
		}
		writeJSON(w, http.StatusOK, refs)
	})
	mux.HandleFunc("GET /api/flow", func(w http.ResponseWriter, r *http.Request) {
		body, err := s.Flow(r.Context())
		if err != nil {
			writeErr(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			w.Write(body)
			return
		}
		zr, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			writeErr(w, err)
			return
		}
		io.Copy(w, zr)
	})
	mux.HandleFunc("GET /api/history", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		n, _ := strconv.Atoi(q.Get("n"))
		h, err := s.History(r.Context(), q.Get("path"), n)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, h)
	})
	mux.HandleFunc("GET /api/symbols", func(w http.ResponseWriter, r *http.Request) {
		b, err := s.Symbols(r.Context())
		if err != nil {
			writeErr(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(b)
	})
	mux.HandleFunc("POST /api/github/repos", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Token string `json:"token"`
			User  string `json:"user"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&body); err != nil {
			writeErr(w, errBad("invalid request"))
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		repos, err := GitHubRepos(ctx, body.Token, body.User)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"repos": repos})
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
