// Package gitx reads repositories by shelling out to the git binary.
// Content is read from git objects at a commit, never from the working tree,
// so local paths and fresh clones behave identically.
package gitx

import (
	"bufio"
	"bytes"
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

func git(dir string, args ...string) *exec.Cmd {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	return cmd
}

func run(dir string, args ...string) (string, error) {
	cmd := git(dir, args...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
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

// Open opens a local path or shallow-clones a URL into a temp dir.
// ref may be empty (HEAD / remote default branch).
func Open(source, ref string) (*Repo, error) {
	if err := checkRef(ref); err != nil {
		return nil, err
	}
	if IsURL(source) {
		tmp, err := os.MkdirTemp("", "codecity-*")
		if err != nil {
			return nil, err
		}
		args := []string{"-c", "protocol.ext.allow=never", "clone", "--quiet", "--depth", "1"}
		if ref != "" {
			args = append(args, "--branch", ref)
		}
		args = append(args, "--", source, tmp)
		if _, err := run("", args...); err != nil {
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
	if _, err := run(abs, "rev-parse", "--git-dir"); err != nil {
		return nil, fmt.Errorf("%s is not a git repository", source)
	}
	return &Repo{Dir: abs, Source: source}, nil
}

// Close removes any temporary clone.
func (r *Repo) Close() {
	if r.cleanup != nil {
		r.cleanup()
	}
}

// Resolve returns the commit hash for ref (default HEAD) and its branch label.
func (r *Repo) Resolve(ref string) (commit, label string, err error) {
	if err = checkRef(ref); err != nil {
		return
	}
	spec := "HEAD"
	if ref != "" {
		spec = ref
	}
	out, err := run(r.Dir, "rev-parse", "--verify", "--end-of-options", spec+"^{commit}")
	if err != nil {
		return "", "", err
	}
	commit = strings.TrimSpace(out)
	label = ref
	if label == "" {
		if b, e := run(r.Dir, "symbolic-ref", "--short", "-q", "HEAD"); e == nil && strings.TrimSpace(b) != "" {
			label = strings.TrimSpace(b)
		} else {
			label = "HEAD"
		}
	}
	return
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
func (r *Repo) Remote() string {
	if IsURL(r.Source) {
		return r.Source
	}
	out, err := run(r.Dir, "config", "--get", "remote.origin.url")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// ListFiles lists every blob (and submodule/symlink entries) at commit.
func (r *Repo) ListFiles(commit string) ([]Entry, error) {
	out, err := run(r.Dir, "ls-tree", "-r", "-z", "-l", commit)
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

func (r *Repo) NewBlobReader() (*BlobReader, error) {
	cmd := git(r.Dir, "cat-file", "--batch")
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
