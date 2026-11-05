#!/usr/bin/env bash
# Run scripts/build_chrome.sh inside the pinned node toolchain (version from .nvmrc).
# For the shell-executor CI runner, which has docker but no node. Usage: same as build_chrome.sh.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
. "$ROOT/scripts/lib.sh"

[ -f "$ROOT/.nvmrc" ] || die ".nvmrc missing: it is the single source of the node version"
NODE_VERSION="$(tr -d '[:space:]' < "$ROOT/.nvmrc")"
[ -n "$NODE_VERSION" ] || die ".nvmrc is empty"
IMAGE="thankmu-chrome-build:node${NODE_VERSION}"

# The image has no git, so name the build here; CI is forwarded so the build can tell it runs in CI.
BUILD_SHORTSHA="$(build_short_sha "$ROOT")"; export BUILD_SHORTSHA
docker build -q -t "$IMAGE" --build-arg "NODE_VERSION=$NODE_VERSION" -f "$HERE/Dockerfile.chrome-build" "$HERE" >/dev/null
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e BUILD_SHORTSHA -e CI -e BUILDS_KEEP \
  -v "$ROOT:/work" -w /work "$IMAGE" bash scripts/build_chrome.sh "$@"
