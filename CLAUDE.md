# Code City

Renders any git repository as a 3D city: directories are districts, files are buildings.
Go CLI does the analysis and emits `city.json`; a Vite + three.js viewer renders it and is embedded in the Go binary.

## Layout
- `cmd/codecity` – CLI (`analyze`, `serve`, `version`)
- `internal/gitx` – shells out to `git` (all calls take a `context`); reads blobs from objects at a commit (`ls-tree`, `cat-file --batch`), never the working tree; also first-parent `Log` and per-range `Churn` (`log --numstat --no-renames -z`)
- `internal/scan` – file filtering (vendored, lock, minified, binary, generated, large) + LOC + language
- `internal/layout` – squarified treemap (deterministic: ties broken by name)
- `internal/city` – `city.json` schema (version 5; `Building.Imp`/`ImpD` = same-repo imported files / package dirs); `City.Facts` (json:"-") carries per-repo linking facts server-side; `web/src/types.ts` must mirror it (`SCHEMA_VERSION`)
- `internal/analyze` – glue: repo → sampled commits → per-file size/complexity history + churn → one layout over every file ever seen → `City`; `churn.go` adds owners (case-insensitive author merge) and change coupling
- `internal/deps` – what a repo provides (Go module, npm/crate/Python names, git remote, Python packages) and uses (manifest deps: go.mod, package.json, Cargo.toml, pyproject/requirements/setup.py, .gitmodules; code imports for Go/JS/TS/Python/Rust); `local.go` resolves imports *inside* a repo (JS/TS relative + `@/` aliases + workspace packages, Go module packages → directories, Python absolute/relative modules, Rust `mod`/`crate::`/`super::`)
- `internal/workspace` – multi-repo worlds: links repos by evidence (dependency = manifest match and/or imports, with importing-file → imported-directory pairs; people = shared contributors, bots ignored), arranges cities in rows (connected ones adjacent), merges into one City (world root district 0 at depth -1, repo roots are its children, paths prefixed with the repo name, timelines merged by date, authors merged case-insensitively)
- `internal/outline` – heuristic per-language outline (types, functions, methods, gaps as imports/scope) used for a file's "pieces"; `codecity outline <file>` prints it
- `internal/insights` – findings at the newest commit (hotspots, coupling, knowledge risk, complexity, areas) + Markdown; used by `codecity report`
- `internal/server` – HTTP server + job API (`/api/status`, `POST /api/analyze`, `POST /api/cancel`, `/api/city`, `GET /api/file?path=&commit=` → content + pieces, `GET /api/symbols` → lazily built definition index `[name, kind, path, start, end]` at each repo's newest commit). `POST /api/analyze` takes `sources` ("source [ref]" per entry, ≤12) and builds a workspace; file reads map merged paths back to (repo, path) and only accept that repo's commits. Keeps the analyzed repo open (temp clones are removed on the next analysis or ctrl-c); file reads are limited to paths and commits of the loaded city. Loopback-only Host/Origin guard; local paths only accepted when bound to loopback
- `internal/web` – `//go:embed all:dist` of the built viewer
- `web/` – viewer (plain three.js, TypeScript, no framework): `scene.ts` (rendering, picking, camera), `material.ts` (window/hacker/glow shader + circuit floor), `theme.ts` (night/day/hacker + procedural glyph/circuit/code textures), `code.ts` (source viewer), `links.ts` (TraceLayer: batched circuit-trace ribbons with flowing pulses; `busRoute` = raised data bus above the skyline), `fx.ts` (hacker atmosphere: floor tracers, particles, hotspot beacons), `walk/` (walk mode: `avatar.ts` original cute android, `trail.ts` light trail, `interior.ts` building interiors, `codewall.ts` code walls + clickable panels, `walk.ts` controller), `insights.ts` (mirrors `internal/insights` for the current commit), `ui.ts` (DOM), `main.ts` (wiring, jobs, deep links)

## Commands
- `make build` – builds viewer, copies it into `internal/web/dist`, builds `bin/codecity`
- `make test` / `go test ./...`
- `cd web && npm run dev` – viewer dev server (proxies `/api` and `/city.json` to a running `codecity serve` on :8080)
- `cd web && npm run typecheck`

## Conventions
- Go: stdlib only. Keep git access in `gitx`; validate refs (no leading `-`), use `--` before user-supplied URLs.
- Built viewer files in `internal/web/dist` are git-ignored except `.gitkeep`, so the embed always compiles; `go install` yields a binary without the viewer (use `make build` or `--web-dir`).
- Changing the `city.json` schema: bump `city.Version`, update `web/src/types.ts` and the viewer's `isCity` check.
- Layout stability: footprints come from each file's *peak* LOC over the sampled history and never change between commits; per-commit size is `Building.H` (change points, loc -1 = absent). Don't recompute layout per commit.
- Identity is the path: a rename shows as delete + add (churn uses `--no-renames` for the same reason).
- Churn bucket i = non-merge commits in (sample i-1, sample i]; bucket 0 = everything up to the first sample. Needs a full clone, so URLs are shallow-cloned only for `--max-commits 1 --no-churn`.
- Complexity = indentation complexity (Tornhill): per non-blank line, tabs + spaces/4. Hotspot = churn commits × complexity. Docs/data/config languages are excluded from hotspots/complexity rankings (`NON_CODE` in `scene.ts`, `NonCode` in insights).
- Coupling: co-change pairs from non-merge commits touching ≤30 files; keep pairs with ≥3 shared commits and degree ≥25% (shared / mean revisions), top 8 per file.
- Knowledge risk: owner = most commits to the file; "owner inactive" only when the owner hasn't committed for 180 days *and* holds ≥50% of the file's commits or there are ≤2 authors. Keep TS (`scene.risk`) and Go (`insights`) rules identical.
- Floats in `city.json` are rounded to 3 decimals.
- Angular components (if any are ever added): never use inline templates or inline CSS.

## Viewer notes
- Exploded view: floors = top-level pieces with containers replaced by their members (`floorsOf` in main.ts); floor height ∝ LOC, color ∝ complexity density.
- Hacker mode is a theme (`THEMES.hacker`, `uHacker` in shaders): text atlas built from repo names, circuit traces in world space, selected building wears its real source (`setSkin`). Keep color modes meaningful in it (text is tinted by the mode color).

- Multi-repo: a city exists only from its first sampled commit on the merged timeline. Connection arcs use a flow shader (pulses travel from the dependent repo to its dependency); selecting a file also draws its cross-repo import arcs. Only evidence-backed links are drawn; unrelated repos stay unconnected.

- Code links (imports inside a repo) are drawn on a raised "data bus": up from the importer's roof, orthogonally across above the skyline, down onto the target (ground traces were hidden by the dense treemap). Modes: selected file (cyan out / magenta in), whole city (file edges ≤350, else bundles between directories), off. Go package imports reach every file of the package except `_test.go`.
- Walk mode (G; forces hacker theme and the newest commit): outdoor player height = 0.6 × `scene.cell` (≈ 1/5 of a median building's width; streets come from `layout.DefaultOptions` gaps); WASD moves relative to the camera and the body turns to face its walking direction (`heading`); street-level bloom is calmer (`scene.setStreetLevel`). Player physics outdoors use building AABBs (low roofs are steppable) and district plates; interiors are separate scenes (`scene.setView`) with their own calmer bloom. Interior layout: 16×16 plate, storey 4.5, level 0 lobby (directory + file info), level k = floor k (floorsOf), switchback stairs on the east lanes, elevator in the SW shaft, code wall on the north wall (lazy per level ±1), references panel on the west wall. Teleports: same building = tracer ride inside; other building = tracer along `busRoute` over the city, then enter at the floor containing the line, highlighted.
- The player avatar is an original design ("Bit"); do not model it on existing characters.

## Roadmap
1. (done) static city from HEAD
2. (done) history: sampled first-parent commits, time scrubber/playback, repo picker in the page
3. (done) churn + hotspot coloring from `git log`
4. (done) complexity, coupling, ownership/knowledge risk, code age, compare mode, insights panel, `report` command
5. (done) pieces: outline, exploded floors, code viewer; hacker mode
6. (done) multiple repositories as connected cities
7. (done) code links inside a repo, walk mode with interiors and teleporting, Tron-style hacker world
8. Java/C#/Kotlin dependency matching (Maven/Gradle/NuGet); tree-sitter metrics/outlines; rename tracking; performance on very large repos (parallel blob reads, cached analyses)
