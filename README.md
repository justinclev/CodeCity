# Code City

Turn any git repository into a 3D city you can fly around. Directories become districts, files become buildings: footprint and height come from file size.

```
make build
./bin/codecity serve                                     # then enter a repo in the page
./bin/codecity serve .                                   # or start with a local repo
./bin/codecity serve https://github.com/expressjs/express --max-commits 60
./bin/codecity serve . --ref v1.2.0 --exclude 'docs/' --exclude '*.snap'
./bin/codecity analyze . -o city.json                    # just the data
```

Open http://127.0.0.1:8080. Type a local path or git URL in the panel (plus optional ref and number of history samples) and press Analyze; progress is shown and can be cancelled.

- **History:** the first-parent history up to the ref is sampled (default 100 commits). Use the timeline to scrub or play (space, arrow keys); buildings grow, shrink, appear and vanish. The layout never moves: footprints are fixed by each file's peak size. Green/amber tint = added/changed in that commit.
- **Churn & hotspots:** from `git log`. Color by *churn* (changes in the chosen window) or *hotspot* (changes × LOC, code files only). The panel lists the top hotspots; click one to jump to it.
- Orbit with the mouse, hover for details, click a building (with a LOC sparkline), search to dim non-matches, change height metric / scale / color. You can also drop a `city.json` onto the page.

Requirements: Go 1.24+, git, Node 20+ (to build the viewer).

Notes
- Only committed content is analyzed; uncommitted changes are ignored. History follows first parents (merge commits count as one step, but churn includes the merged commits).
- URLs are fully cloned for history/churn, which can be slow and large for big repos; use `--max-commits 1 --no-churn` (or untick "churn & hotspots" with 1 sample) for a fast shallow snapshot.
- Renames show as a delete plus an add (files are identified by path).
- When the server is bound to a non-loopback address, the page can only analyze remote URLs, not local paths.
- Skipped by default: vendored dirs, lockfiles, minified, binary, generated, symlinks, submodules, files over 2 MB. Use `--include-vendored` / `--include-generated` to keep them.
- `go install` alone produces a binary without the viewer; use `make build` (or `--web-dir web/dist`).

See `CLAUDE.md` for architecture and roadmap.
