package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/justinclev/codecity/internal/analyze"
	"github.com/justinclev/codecity/internal/city"
	"github.com/justinclev/codecity/internal/flow"
	"github.com/justinclev/codecity/internal/insights"
	"github.com/justinclev/codecity/internal/outline"
	"github.com/justinclev/codecity/internal/scan"
	"github.com/justinclev/codecity/internal/server"
	"github.com/justinclev/codecity/internal/workspace"
)

const version = "0.2.0"

const usage = `codecity - render a git repository as a 3D city

Usage:
  codecity analyze <repo>... [flags]  write city.json
  codecity serve   [repo]... [flags]  serve the viewer; repos are optional, you can also enter them in the page
  codecity report  <repo>... [flags]  print a Markdown report: hotspots, coupling, knowledge risk

Several repos become several cities on one map, connected where one depends on
another (manifests, imports) or where they share contributors.
  codecity outline <file>           show the pieces (types, functions, …) found in a source file
  codecity flow <dir> [-json]       summarize the flow graph (calls, inputs, outputs) of a working tree
  codecity version

<repo> is a local path or a git URL (https://, ssh://, git@host:path).
Only committed content is analyzed. With --max-commits N > 1 the first-parent history up to --ref
(default HEAD) is sampled to N commits and the viewer gets a time scrubber. URLs are fully cloned
for history (shallow for --max-commits 1), which can be slow for big repos.

Flags:
  --ref <ref>         branch, tag or commit (default HEAD)
  --exclude <glob>    exclude files (repeatable; "dir/" excludes a directory)
  --include-vendored  include node_modules, vendor, lockfiles
  --include-generated include generated files
  --max-commits <n>   history samples (default 100; 1 = snapshot only)
  --no-churn          skip change-frequency analysis (hotspots); allows a shallow clone for --max-commits 1
  --min-weight <n>    minimum footprint weight per file (default 8)
  -o <file>           analyze: output file, "-" for stdout (default city.json); report: default stdout
  --top <n>           report: rows per section (default 15)
  --addr <host:port>  serve: listen address (default 127.0.0.1:8080)
  --web-dir <dir>     serve: use viewer files from a directory instead of the embedded build
  -q                  quiet
`

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	switch cmd {
	case "analyze", "serve", "report":
		if err := run(cmd, args); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
	case "outline":
		if len(args) != 1 {
			fmt.Fprintln(os.Stderr, "usage: codecity outline <file>")
			os.Exit(2)
		}
		src, err := os.ReadFile(args[0])
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
		for _, p := range outline.Outline(scan.Language(args[0]), src) {
			ind := ""
			if p.Parent >= 0 {
				ind = "    "
			}
			fmt.Printf("%5d-%-5d %s%-10s %s  (loc %d, complexity %d)\n", p.Start, p.End, ind, p.Kind, p.Name, p.LOC, p.Complexity)
		}
	case "flow":
		if err := flowCmd(args); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
	case "version", "--version":
		fmt.Println("codecity", version)
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", cmd, usage)
		os.Exit(2)
	}
}

func run(cmd string, args []string) error {
	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	var excludes multi
	ref := fs.String("ref", "", "")
	fs.Var(&excludes, "exclude", "")
	incV := fs.Bool("include-vendored", false, "")
	incG := fs.Bool("include-generated", false, "")
	minW := fs.Float64("min-weight", 8, "")
	maxC := fs.Int("max-commits", 100, "")
	noChurn := fs.Bool("no-churn", false, "")
	split := fs.Bool("split", false, "split a monolithic repo into one city per project (manifest root)")
	out := fs.String("o", "city.json", "")
	addr := fs.String("addr", "127.0.0.1:8080", "")
	webDir := fs.String("web-dir", "", "")
	quiet := fs.Bool("q", false, "")
	topN := fs.Int("top", 15, "")

	// allow the repo argument before or after flags
	var pos []string
	rest := args
	for len(rest) > 0 {
		if err := fs.Parse(rest); err != nil {
			return err
		}
		rest = fs.Args()
		if len(rest) > 0 {
			pos = append(pos, rest[0])
			rest = rest[1:]
		}
	}
	if len(pos) == 0 && cmd != "serve" {
		return fmt.Errorf("expected at least one <repo> argument")
	}
	logf := func(f string, a ...any) {
		if !*quiet {
			fmt.Fprintf(os.Stderr, f+"\n", a...)
		}
	}
	base := analyze.Options{Ref: *ref, Excludes: excludes, IncludeVendored: *incV, IncludeGenerated: *incG,
		MinWeight: *minW, MaxCommits: *maxC, NoChurn: *noChurn, Split: *split}

	if cmd == "analyze" || cmd == "report" {
		var cities []*city.City
		for _, src := range pos {
			o := base
			o.Source = src
			stage := ""
			cs, err := analyze.RunAll(context.Background(), o, func(st string, done, total int) {
				if st != stage {
					stage = st
					logf("%s: %s ...", src, st)
				}
			})
			if err != nil {
				return fmt.Errorf("%s: %w", src, err)
			}
			for _, c := range cs {
				logf("%s @ %s: %d commits, %d files, %d LOC (skipped %v)", c.Repo.Name, c.Repo.Commit[:8], len(c.Commits), c.Stats.Files, c.Stats.LOC, c.Stats.Skipped)
			}
			cities = append(cities, cs...)
		}
		c := workspace.Build(cities)
		for _, l := range c.Links {
			if l.Kind == "dependency" {
				logf("link: %s depends on %s (%s)", c.Repos[l.From].Name, c.Repos[l.To].Name, strings.Join(l.Evidence, "; "))
			}
		}
		if cmd == "report" {
			md := insights.Compute(c, *topN).Markdown()
			if *out == "city.json" || *out == "-" { // default for report is stdout
				_, err := fmt.Print(md)
				return err
			}
			return os.WriteFile(*out, []byte(md), 0o644)
		}
		return writeCity(c, *out)
	}

	if !server.HasViewer(*webDir) {
		fmt.Fprintln(os.Stderr, "warning: this binary has no embedded viewer (run `make build`, or pass --web-dir web/dist)")
	}
	srv := server.New(*addr, *webDir)
	srv.Base = base
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		return err
	}
	// remove temporary clones on ctrl-c
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		srv.Close()
		os.Exit(0)
	}()
	logf("serving on http://%s  (ctrl-c to stop)", ln.Addr())
	if len(pos) > 0 {
		if _, err := srv.Start(server.Request{Sources: pos, Ref: *ref, MaxCommits: *maxC, NoChurn: *noChurn, Split: *split}); err != nil {
			return err
		}
		logf("analyzing %s in the background ...", strings.Join(pos, ", "))
	}
	return http.Serve(ln, srv.Handler())
}

func writeCity(c *city.City, out string) error {
	w := os.Stdout
	if out != "-" {
		f, err := os.Create(out)
		if err != nil {
			return err
		}
		defer f.Close()
		w = f
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", " ")
	return enc.Encode(c)
}

// flowCmd builds the flow graph of a working tree (a debugging aid; the viewer gets it from /api/flow at a commit).
func flowCmd(args []string) error {
	asJSON := false
	dir := "."
	for _, a := range args {
		if a == "-json" || a == "--json" {
			asJSON = true
		} else {
			dir = a
		}
	}
	var files []flow.File
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if p != dir && (strings.HasPrefix(name, ".") || name == "node_modules" || name == "vendor" || name == "dist" || name == "target" || name == "__pycache__") {
				return filepath.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		rel = filepath.ToSlash(rel)
		lang := scan.Language(rel)
		if !flow.Wanted(rel, lang) {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil || len(b) > 1<<20 {
			return nil
		}
		files = append(files, flow.File{Path: rel, Lang: lang, Content: b})
		return nil
	})
	if err != nil {
		return err
	}
	g := flow.Build(files, flow.Options{})
	if asJSON {
		enc := json.NewEncoder(os.Stdout)
		return enc.Encode(g)
	}
	fmt.Print(flow.Summary(g))
	return nil
}
