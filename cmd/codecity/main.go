package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/justinclev/codecity/internal/analyze"
	"github.com/justinclev/codecity/internal/city"
	"github.com/justinclev/codecity/internal/server"
)

const version = "0.2.0"

const usage = `codecity - render a git repository as a 3D city

Usage:
  codecity analyze <repo> [flags]   write city.json
  codecity serve   [repo] [flags]   serve the viewer; repo is optional, you can also pick one in the page
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
  -o <file>           analyze: output file, "-" for stdout (default city.json)
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
	case "analyze", "serve":
		if err := run(cmd, args); err != nil {
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
	out := fs.String("o", "city.json", "")
	addr := fs.String("addr", "127.0.0.1:8080", "")
	webDir := fs.String("web-dir", "", "")
	quiet := fs.Bool("q", false, "")

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
	if len(pos) > 1 || (len(pos) == 0 && cmd == "analyze") {
		return fmt.Errorf("expected exactly one <repo> argument")
	}
	logf := func(f string, a ...any) {
		if !*quiet {
			fmt.Fprintf(os.Stderr, f+"\n", a...)
		}
	}
	base := analyze.Options{Ref: *ref, Excludes: excludes, IncludeVendored: *incV, IncludeGenerated: *incG,
		MinWeight: *minW, MaxCommits: *maxC, NoChurn: *noChurn}

	if cmd == "analyze" {
		o := base
		o.Source = pos[0]
		stage := ""
		c, err := analyze.Run(context.Background(), o, func(st string, done, total int) {
			if st != stage {
				stage = st
				logf("%s ...", st)
			}
		})
		if err != nil {
			return err
		}
		logf("%s @ %s: %d commits, %d files, %d LOC (skipped %v)", c.Repo.Name, c.Repo.Commit[:8], len(c.Commits), c.Stats.Files, c.Stats.LOC, c.Stats.Skipped)
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
	logf("serving on http://%s  (ctrl-c to stop)", ln.Addr())
	if len(pos) == 1 {
		if _, err := srv.Start(server.Request{Source: pos[0], Ref: *ref, MaxCommits: *maxC, NoChurn: *noChurn}); err != nil {
			return err
		}
		logf("analyzing %s in the background ...", pos[0])
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
