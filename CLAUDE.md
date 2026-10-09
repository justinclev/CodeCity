# Code City

Renders any git repository as a 3D city: directories are districts, files are buildings.
Go CLI does the analysis and emits `city.json`; a Vite + three.js viewer renders it and is embedded in the Go binary.

## Layout
- `cmd/codecity` – CLI (`analyze`, `serve`, `version`)
- `internal/gitx` – shells out to `git` (all calls take a `context`); reads blobs from objects at a commit (`ls-tree`, `cat-file --batch`), never the working tree; also first-parent `Log` and per-range `Churn` (`log --numstat --no-renames -z`)
- `internal/scan` – file filtering (vendored, lock, minified, binary, generated, large) + LOC + language
- `internal/layout` – squarified treemap (deterministic: ties broken by name)
- `internal/city` – `city.json` schema (version 2); `web/src/types.ts` must mirror it
- `internal/analyze` – glue: repo → sampled commits → per-file size history + churn → one layout over every file ever seen → `City`
- `internal/server` – HTTP server + job API (`/api/status`, `POST /api/analyze`, `POST /api/cancel`, `/api/city`); loopback-only Host/Origin guard; local paths only accepted when bound to loopback
- `internal/web` – `//go:embed all:dist` of the built viewer
- `web/` – viewer (plain three.js, TypeScript, no framework)

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
- Hotspot = churn commits × LOC (LOC is the complexity proxy until tree-sitter lands); docs/data/config languages are excluded from hotspot ranking (`NON_CODE` in `scene.ts`).
- Floats in `city.json` are rounded to 3 decimals.
- Angular components (if any are ever added): never use inline templates or inline CSS.

## Roadmap
1. (done) static city from HEAD
2. (done) history: sampled first-parent commits, time scrubber/playback, repo picker in the page
3. (done) churn + hotspot coloring from `git log`
4. tree-sitter complexity to replace LOC in the hotspot score; per-commit true churn windows; rename tracking
