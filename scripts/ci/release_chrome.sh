#!/usr/bin/env bash
# The whole Chrome release path, one script for both CI jobs: release_chrome (a chrome-vX.Y.Z tag, the
# real release) and release_chrome_dry_run (a manual pipeline with RELEASE_DRY_RUN_VERSION, a rehearsal).
# They run this same script; only the trigger and the artifact's name and expiry differ.
# Usage: scripts/ci/release_chrome.sh X.Y.Z
#   1. build every release target in the pinned docker toolchain (scripts/ci/docker_build_chrome.sh), from
#      ONE upstream build of the tagged tree: "store" (the Chrome Web Store zip) and "alpha" (the public
#      pre-alpha zip, handed to testers directly). The set is thankmu/patch_extension.py RELEASE_TARGETS,
#      read from there rather than repeated here.
#   2. for each of them, verify the package it produced: brand scan, blocking files identical to upstream,
#      popup inventory, the target's icon set
#   3. for each of them, check the finished zip itself (scripts/check_store_zip.py): the extension id is what
#      the target says it is (no key for store, the pinned key for alpha), externally_connectable, version
# One tag, one source publication (scripts/ci/publish_source_snapshot.sh), every package. A target that
# fails any step fails the job, so a release never publishes one package and leaves the other unchecked.
# Needs on the runner: docker, python3, bash.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
. "$ROOT/scripts/lib.sh"

VERSION="${1:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: release_chrome.sh X.Y.Z (got '$VERSION'; strip the chrome-v tag prefix first)"
command -v python3 >/dev/null || die "required tool not found: python3"

# The release targets, from the one place they are defined.
TARGETS=()
while IFS= read -r t; do [ -z "$t" ] || TARGETS+=("$t"); done < <(
  python3 -I - "$ROOT/thankmu/patch_extension.py" <<'PY'
import importlib.util, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("thankmu_patch", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print("\n".join(mod.RELEASE_TARGETS))
PY
)
[ "${#TARGETS[@]}" -gt 0 ] || die "cannot read RELEASE_TARGETS from thankmu/patch_extension.py"

"$HERE/docker_build_chrome.sh" "$VERSION" "${TARGETS[@]}"

pkg_name="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["package_name"])' "$ROOT/thankmu/brand.json")"
[ -n "$pkg_name" ] || die "thankmu/brand.json package_name is empty"
BUILD="$ROOT/$UBO_PREFIX/dist/build"
UNPATCHED="$BUILD/uBOLite.chromium.unpatched"

zips=()
for t in "${TARGETS[@]}"; do
  # Each target's own package directory, so every one is verified and not just whichever was patched last.
  "$ROOT/scripts/verify_chrome_package.sh" --target "$t" "$UNPATCHED" "$BUILD/uBOLite.chromium.$t"
  if [ "$t" = store ]; then zip="$BUILD/${pkg_name}_$VERSION.zip"
  else zip="$BUILD/${pkg_name}_${t}_$VERSION.zip"; fi
  [ -f "$zip" ] || die "release build finished but the $t zip is missing: $zip"
  python3 -I "$ROOT/scripts/check_store_zip.py" "$zip" "$ROOT/thankmu/targets.json" "$VERSION" "$t"
  zips+=("$zip")
done
echo "Release path ok for $VERSION: ${zips[*]}"
