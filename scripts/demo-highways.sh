#!/usr/bin/env bash
# Builds the example services in examples/highways into throwaway git repos and serves them
# as one world, so you can see API and Kafka highways without a repo of your own.
#   scripts/demo-highways.sh [--addr 127.0.0.1:8080]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
bin="$here/bin/codecity"
[ -x "$bin" ] || { echo "run 'make build' first" >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
repos=()
for svc in "$here"/examples/highways/*/; do
  name="$(basename "$svc")"
  cp -r "$svc" "$tmp/$name"
  git -C "$tmp/$name" init -q -b main
  git -C "$tmp/$name" add -A
  git -C "$tmp/$name" -c user.name=Demo -c user.email=demo@example.com commit -q -m "demo"
  repos+=("$tmp/$name")
done
"$bin" serve "${repos[@]}" --max-commits 1 --no-churn "$@"
