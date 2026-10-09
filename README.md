# Code City

Turn any git repository into a 3D city you can fly around. Directories become districts, files become buildings: footprint and height come from file size.

```
make build
./bin/codecity serve .                                   # a local repo
./bin/codecity serve https://github.com/mrdoob/three.js  # or a URL (shallow clone)
./bin/codecity serve . --ref v1.2.0 --exclude 'docs/' --exclude '*.snap'
./bin/codecity analyze . -o city.json                    # just the data
```

Open http://127.0.0.1:8080. Orbit with the mouse, hover for details, click a building to select it, search to dim non-matching files, and switch height metric / scale / color in the panel. You can also drop a `city.json` onto the viewer page.

Requirements: Go 1.24+, git, Node 20+ (to build the viewer).

Notes
- Only committed content at `--ref` (default `HEAD`) is analyzed; uncommitted changes are ignored.
- Skipped by default: vendored dirs, lockfiles, minified, binary, generated, symlinks, submodules, files over 2 MB. Use `--include-vendored` / `--include-generated` to keep them.
- `go install` alone produces a binary without the viewer; use `make build` (or `--web-dir web/dist`).

See `CLAUDE.md` for architecture and roadmap.
