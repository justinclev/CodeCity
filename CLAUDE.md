# Code City

Renders any git repository as a 3D city: directories are districts, files are buildings.
Go CLI does the analysis and emits `city.json`; a Vite + three.js viewer renders it and is embedded in the Go binary.

## Layout
- `cmd/codecity` – CLI (`analyze`, `serve`, `version`)
- `internal/gitx` – shells out to `git`; reads blobs from objects at a commit (`ls-tree`, `cat-file --batch`), never the working tree
- `internal/scan` – file filtering (vendored, lock, minified, binary, generated, large) + LOC + language
- `internal/layout` – squarified treemap (deterministic: ties broken by name)
- `internal/city` – `city.json` schema (version 1); `web/src/types.ts` must mirror it
- `internal/analyze` – glue: repo → files → tree → layout → `City`
- `internal/server` / `internal/web` – HTTP server; `//go:embed all:dist` of the built viewer
- `web/` – viewer (plain three.js, TypeScript, no framework)

## Commands
- `make build` – builds viewer, copies it into `internal/web/dist`, builds `bin/codecity`
- `make test` / `go test ./...`
- `cd web && npm run dev` – viewer dev server (proxies `/city.json` to a running `codecity serve` on :8080)
- `cd web && npm run typecheck`

## Conventions
- Go: stdlib only. Keep git access in `gitx`; validate refs (no leading `-`), use `--` before user-supplied URLs.
- Built viewer files in `internal/web/dist` are git-ignored except `.gitkeep`, so the embed always compiles; `go install` yields a binary without the viewer (use `make build` or `--web-dir`).
- Changing the `city.json` schema: bump `city.Version`, update `web/src/types.ts` and the viewer's `isCity` check.
- Floats in `city.json` are rounded to 3 decimals.
- Angular components (if any are ever added): never use inline templates or inline CSS.

## Roadmap
1. (done) static city from HEAD
2. Better metrics: tree-sitter complexity, churn/hotspots from `git log`
3. History: time scrubber / playback; layout must stay stable across commits
