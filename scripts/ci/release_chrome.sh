#!/usr/bin/env bash
# The whole Chrome release path, one script for both CI jobs: release_chrome (a chrome-vX.Y.Z tag, the
# real release) and release_chrome_dry_run (a manual pipeline with RELEASE_DRY_RUN_VERSION, a rehearsal).
# They run this same script; only the trigger and the artifact's name and expiry differ.
# Usage: scripts/ci/release_chrome.sh X.Y.Z
#   1. build the store target in the pinned docker toolchain (scripts/ci/docker_build_chrome.sh)
#   2. verify --target store: brand scan, blocking files identical to upstream
#   3. check the finished zip itself (scripts/check_store_zip.py): no key, externally_connectable, version
# Needs on the runner: docker, python3, bash.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
. "$ROOT/scripts/lib.sh"

VERSION="${1:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: release_chrome.sh X.Y.Z (got '$VERSION'; strip the chrome-v tag prefix first)"
command -v python3 >/dev/null || die "required tool not found: python3"

"$HERE/docker_build_chrome.sh" "$VERSION"
"$ROOT/scripts/verify_chrome_package.sh" --target store

pkg_name="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["package_name"])' "$ROOT/thankmu/brand.json")"
[ -n "$pkg_name" ] || die "thankmu/brand.json package_name is empty"
zip="$ROOT/$UBO_PREFIX/dist/build/${pkg_name}_$VERSION.zip"
[ -f "$zip" ] || die "release build finished but the store zip is missing: $zip"
python3 -I "$ROOT/scripts/check_store_zip.py" "$zip" "$ROOT/thankmu/targets.json" "$VERSION"
echo "Release path ok for $VERSION: $zip"
