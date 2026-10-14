#!/usr/bin/env bash
# Builds the example services in examples/highways into throwaway git repos and serves them
# as one world, so you can see API and Kafka highways without a repo of your own.
#   scripts/demo-highways.sh [highways|highways-lang] [--addr 127.0.0.1:8080]
#   highways      12 services: API, Kafka, AsyncAPI/OpenAPI, GraphQL, WebSocket, env-var URLs, shared table
#   highways-lang  Java/C#/Rust/Python examples: FastAPI, Flask, axum, gRPC, compose service names
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
world=highways
case "${1:-}" in highways|highways-lang) world="$1"; shift;; esac
bin="$here/bin/codecity"
[ -x "$bin" ] || { echo "run 'make build' first" >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
repos=()
for svc in "$here"/examples/$world/*/; do
  name="$(basename "$svc")"
  cp -r "$svc" "$tmp/$name"
  git -C "$tmp/$name" init -q -b main
  git -C "$tmp/$name" add -A
  git -C "$tmp/$name" -c user.name=Demo -c user.email=demo@example.com commit -q -m "demo"
  repos+=("$tmp/$name")
done
"$bin" serve "${repos[@]}" --max-commits 1 --no-churn "$@"
