// Package gitx reads repositories by shelling out to the git binary.
// Content is read from git objects at a commit, never from the working tree,
// so local paths and fresh clones behave identically.
package gitx

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// Repo is a handle on a git repository.
type Repo struct {
	Dir     string // git dir or work tree
	Source  string // what the user passed
	cleanup func()
}

// Entry is one blob in a tree.
type Entry struct {
	Path string
	Mode string
	Oid  string
	Size int64
}

// IsURL reports whether s looks like a remote git URL rather than a path.
func IsURL(s string) bool {
	for _, p := range []string{"https://", "http://", "ssh://", "git://", "file://"} {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	// scp-like: user@host:path
	if i := strings.Index(s, "@"); i > 0 && !strings.ContainsAny(s[:i], "/ ") {
		if j := strings.Index(s[i:], ":"); j > 0 {
			return true
		}
	}
	return false
}

func git(ctx context.Context, dir string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	return cmd
}

func run(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := git(ctx, dir, args...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", fmt.Errorf("git %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(errb.String()))
	}
	return out.String(), nil
}

func checkRef(ref string) error {
	if strings.HasPrefix(ref, "-") {
		return fmt.Errorf("invalid ref %q", ref)
	}
	return nil
}

// Open opens a local path or clones a URL into a temp dir. A shallow clone
// (depth 1) is enough for a single snapshot; history needs a full clone.
// ref may be empty (HEAD / remote default branch).
func Open(ctx context.Context, source, ref string, shallow bool) (*Repo, error) {
	if err := checkRef(ref); err != nil {
		return nil, err
	}
	if IsURL(source) {
		tmp, err := os.MkdirTemp("", "codecity-*")
		if err != nil {
			return nil, err
		}
		args := []string{"-c", "protocol.ext.allow=never", "clone", "--quiet"}
		if shallow {
			args = append(args, "--depth", "1")
			if ref != "" {
				args = append(args, "--branch", ref)
			}
		}
		args = append(args, "--", source, tmp)
		if _, err := run(ctx, "", args...); err != nil {
			os.RemoveAll(tmp)
			return nil, err
		}
		return &Repo{Dir: tmp, Source: source, cleanup: func() { os.RemoveAll(tmp) }}, nil
	}
	abs, err := filepath.Abs(source)
	if err != nil {
		return nil, err
	}
	if st, err := os.Stat(abs); err != nil || !st.IsDir() {
		return nil, fmt.Errorf("%s: not a directory", source)
	}
	if _, err := run(ctx, abs, "rev-parse", "--git-dir"); err != nil {
		return nil, fmt.Errorf("%s is not a git repository", source)
	}
	return &Repo{Dir: abs, Source: source}, nil
}

// LocalPath returns the absolute work tree of a local (non-cloned) repo, or "".
func (r *Repo) LocalPath(ctx context.Context) string {
	if r.cleanup != nil {
		return ""
	}
	out, err := run(ctx, r.Dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// Close removes any temporary clone.
func (r *Repo) Close() {
	if r != nil && r.cleanup != nil {
		r.cleanup()
	}
}

// Resolve returns the commit hash for ref (default HEAD) and its branch label.
// In a fresh clone, remote branches and tags are tried as fallbacks.
func (r *Repo) Resolve(ctx context.Context, ref string) (commit, label string, err error) {
	if err = checkRef(ref); err != nil {
		return
	}
	cands := []string{"HEAD"}
	if ref != "" {
		cands = []string{ref, "origin/" + ref, "refs/tags/" + ref}
	}
	var out string
	for _, c := range cands {
		if out, err = run(ctx, r.Dir, "rev-parse", "--verify", "--end-of-options", c+"^{commit}"); err == nil {
			break
		}
	}
	if err != nil {
		return "", "", err
	}
	commit = strings.TrimSpace(out)
	label = ref
	if label == "" {
		if b, e := run(ctx, r.Dir, "symbolic-ref", "--short", "-q", "HEAD"); e == nil && strings.TrimSpace(b) != "" {
			label = strings.TrimSpace(b)
		} else {
			label = "HEAD"
		}
	}
	return
}

// Commit is one entry of the first-parent history.
type Commit struct {
	Hash    string `json:"hash"`
	Date    string `json:"date"`
	Author  string `json:"author"`
	Subject string `json:"subject"`
}

// Log returns the first-parent history reachable from commit, oldest first.
// n > 0 limits it to the newest n commits.
func (r *Repo) Log(ctx context.Context, commit string, n int) ([]Commit, error) {
	args := []string{"log", "--first-parent", "--format=%H%x1f%aI%x1f%an%x1f%s%x1e"}
	if n > 0 {
		args = append(args, "-n", strconv.Itoa(n))
	}
	args = append(args, "--end-of-options", commit)
	out, err := run(ctx, r.Dir, args...)
	if err != nil {
		return nil, err
	}
	var cs []Commit
	for _, rec := range strings.Split(out, "\x1e") {
		rec = strings.TrimLeft(rec, "\n")
		if rec == "" {
			continue
		}
		f := strings.SplitN(rec, "\x1f", 4)
		if len(f) != 4 {
			continue
		}
		cs = append(cs, Commit{Hash: f[0], Date: f[1], Author: f[2], Subject: f[3]})
	}
	for i, j := 0, len(cs)-1; i < j; i, j = i+1, j-1 {
		cs[i], cs[j] = cs[j], cs[i]
	}
	return cs, nil
}

// Name guesses a display name for the repo.
func (r *Repo) Name() string {
	s := strings.TrimSuffix(strings.TrimRight(r.Source, "/"), ".git")
	if i := strings.LastIndexAny(s, "/:"); i >= 0 {
		s = s[i+1:]
	}
	if s == "" || s == "." {
		if abs, err := filepath.Abs(r.Dir); err == nil {
			s = filepath.Base(abs)
		}
	}
	return s
}

// Remote returns origin's URL if any.
func (r *Repo) Remote(ctx context.Context) string {
	if IsURL(r.Source) {
		return r.Source
	}
	out, err := run(ctx, r.Dir, "config", "--get", "remote.origin.url")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// ListFiles lists every blob (and submodule/symlink entries) at commit.
func (r *Repo) ListFiles(ctx context.Context, commit string) ([]Entry, error) {
	out, err := run(ctx, r.Dir, "ls-tree", "-r", "-z", "-l", commit)
	if err != nil {
		return nil, err
	}
	var es []Entry
	for _, rec := range strings.Split(out, "\x00") {
		if rec == "" {
			continue
		}
		tab := strings.IndexByte(rec, '\t')
		if tab < 0 {
			continue
		}
		f := strings.Fields(rec[:tab])
		if len(f) < 4 {
			continue
		}
		size := int64(0)
		if f[3] != "-" {
			size, _ = strconv.ParseInt(f[3], 10, 64)
		}
		es = append(es, Entry{Path: rec[tab+1:], Mode: f[0], Oid: f[2], Size: size})
	}
	return es, nil
}

// BlobReader streams blobs via `git cat-file --batch`.
type BlobReader struct {
	cmd *exec.Cmd
	in  io.WriteCloser
	out *bufio.Reader
}

func (r *Repo) NewBlobReader(ctx context.Context) (*BlobReader, error) {
	cmd := git(ctx, r.Dir, "cat-file", "--batch")
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &BlobReader{cmd: cmd, in: in, out: bufio.NewReaderSize(out, 1<<16)}, nil
}

// Read returns up to max bytes of the blob (the rest is discarded).
func (b *BlobReader) Read(oid string, max int64) ([]byte, error) {
	if _, err := fmt.Fprintf(b.in, "%s\n", oid); err != nil {
		return nil, err
	}
	line, err := b.out.ReadString('\n')
	if err != nil {
		return nil, err
	}
	f := strings.Fields(line)
	if len(f) != 3 {
		return nil, fmt.Errorf("cat-file: unexpected %q", strings.TrimSpace(line))
	}
	n, err := strconv.ParseInt(f[2], 10, 64)
	if err != nil {
		return nil, err
	}
	keep := n
	if max > 0 && keep > max {
		keep = max
	}
	buf := make([]byte, keep)
	if _, err := io.ReadFull(b.out, buf); err != nil {
		return nil, err
	}
	if _, err := io.CopyN(io.Discard, b.out, n-keep+1); err != nil { // +1 trailing LF
		return nil, err
	}
	return buf, nil
}

func (b *BlobReader) Close() {
	b.in.Close()
	b.cmd.Wait()
}

// ChurnStat is how often and how much a file changed in a commit range.
type ChurnStat struct {
	Commits int
	Lines   int            // added + deleted
	Last    int64          // newest commit time (unix seconds) touching the file
	Authors map[string]int // commits per author (mailmap-aware name)
}

// AuthorStat is an author's activity within a range.
type AuthorStat struct {
	Commits int
	Last    int64 // newest commit time (unix seconds)
}

// ChurnResult is the per-file churn of a range, per-author activity, and the
// file sets of each commit (for change coupling).
type ChurnResult struct {
	Files      map[string]*ChurnStat
	Authors    map[string]*AuthorStat
	CommitSets [][]string
}

// Churn aggregates per-file changes of non-merge commits reachable from `to`
// but not from `from` (from == "" means all history up to `to`). Renames are
// reported as delete + add so paths stay consistent with the tree listing.
func (r *Repo) Churn(ctx context.Context, from, to string) (*ChurnResult, error) {
	args := []string{"log", "--no-merges", "--numstat", "--no-renames", "-z", "--format=%x01%H%x02%aN%x02%ct", "--end-of-options"}
	if from != "" {
		args = append(args, from+".."+to)
	} else {
		args = append(args, to)
	}
	out, err := run(ctx, r.Dir, args...)
	if err != nil {
		return nil, err
	}
	res := &ChurnResult{Files: map[string]*ChurnStat{}, Authors: map[string]*AuthorStat{}}
	author := ""
	var ts int64
	var set []string
	flush := func() {
		if len(set) > 0 {
			res.CommitSets = append(res.CommitSets, set)
		}
		set = nil
	}
	for _, tok := range strings.Split(out, "\x00") {
		tok = strings.TrimPrefix(tok, "\n")
		if tok == "" {
			continue
		}
		if tok[0] == 1 { // commit header: \x01<hash>\x02<author>\x02<unix time>
			flush()
			h := strings.Split(tok[1:], "\x02")
			author, ts = "", 0
			if len(h) == 3 {
				author = h[1]
				ts, _ = strconv.ParseInt(strings.TrimSpace(h[2]), 10, 64)
			}
			a := res.Authors[author]
			if a == nil {
				a = &AuthorStat{}
				res.Authors[author] = a
			}
			a.Commits++
			a.Last = max(a.Last, ts)
			continue
		}
		f := strings.SplitN(tok, "\t", 3)
		if len(f) != 3 {
			continue
		}
		a, _ := strconv.Atoi(f[0]) // "-" for binary → 0
		d, _ := strconv.Atoi(f[1])
		s := res.Files[f[2]]
		if s == nil {
			s = &ChurnStat{Authors: map[string]int{}}
			res.Files[f[2]] = s
		}
		s.Commits++
		s.Lines += a + d
		s.Last = max(s.Last, ts)
		s.Authors[author]++
		set = append(set, f[2])
	}
	flush()
	return res, nil
}

// ReadFile returns the content of path at commit (at most max bytes).
func (r *Repo) ReadFile(ctx context.Context, commit, path string, max int64) ([]byte, error) {
	if strings.ContainsAny(path, "\n\x00") || strings.HasPrefix(commit, "-") {
		return nil, fmt.Errorf("invalid path")
	}
	cmd := git(ctx, r.Dir, "cat-file", "blob", commit+":"+path)
	var errb bytes.Buffer
	cmd.Stderr = &errb
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	b, rerr := io.ReadAll(io.LimitReader(out, max))
	io.Copy(io.Discard, out)
	if err := cmd.Wait(); err != nil {
		return nil, fmt.Errorf("git cat-file: %v: %s", err, strings.TrimSpace(errb.String()))
	}
	return b, rerr
}

// IsShallow reports whether the repository lacks full history.
func (r *Repo) IsShallow(ctx context.Context) bool {
	out, err := run(ctx, r.Dir, "rev-parse", "--is-shallow-repository")
	return err == nil && strings.TrimSpace(out) == "true"
}
