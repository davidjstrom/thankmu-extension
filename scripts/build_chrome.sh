#!/usr/bin/env bash
# Build the Chromium MV3 package from the in-tree chrome_plugin/ subtree.
# Never fetches uBlock Origin sources (UBO_VERSION is forced unset, so upstream's
# make-mv3.sh uses the subtree). Filter lists are fetched over HTTPS at build time
# by upstream's make-rulesets.js.
#
# Usage: scripts/build_chrome.sh [X.Y.Z [target...]]
#   no version  -> dev build (target "dev"), unpacked at chrome_plugin/dist/build/uBOLite.chromium/
#   X.Y.Z       -> release build of target "store" + zip at chrome_plugin/dist/build/<package_name>_X.Y.Z.zip
#                  (package_name from thankmu/brand.json, e.g. thankmu_chromium_1.2.3.zip)
#   X.Y.Z t...  -> release build of each named target. Every target but "store" names itself in its zip
#                  (thankmu_chromium_alpha_1.2.3.zip); "store" keeps the plain name, which is the file a
#                  submission uploads. A release tag builds "store alpha" (scripts/ci/release_chrome.sh).
# Several release targets share ONE upstream build: make-mv3.sh runs once, and each target is patched from
# the same pristine output into its own directory (uBOLite.chromium.<target>/). That is deliberate. Filter
# lists are fetched over HTTPS while that build runs, so building the targets separately would give each
# one a different filter-list snapshot under the same version number; this way the packages a tag publishes
# differ only in the things the target chooses -- app origin, extension id, name, icons.
# The target picks APP_ORIGIN and the manifest key from thankmu/targets.json (W-P3 part B).
# After upstream's make-mv3.sh, the ThankMu layer (thankmu/) rebrands the output, then
# scripts/verify_chrome_package.sh proves no upstream marks remain and blocking files are untouched.
# The pristine upstream output is kept at chrome_plugin/dist/build/uBOLite.chromium.unpatched/ for that comparison.
# On success the build is also landed in builds/<target>/<version>-<shortsha>/ (see scripts/land_build.sh; not in CI).
# Needs: node (major version from .nvmrc or newer), jq, zip, python3, rsvg-convert, bash. Run via scripts/ci/docker_build_chrome.sh for the pinned toolchain.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"

VERSION="${1:-}"
[ "$#" -eq 0 ] || shift
TARGETS=("$@")
if [ -n "$VERSION" ]; then
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version '$VERSION' must look like X.Y.Z (strip the chrome-v tag prefix first)"
  [ "${#TARGETS[@]}" -gt 0 ] || TARGETS=(store)
  seen=""
  for t in "${TARGETS[@]}"; do
    [ -n "$t" ] || die "a target name must not be empty"
    case " $seen " in *" $t "*) die "target '$t' named twice" ;; esac
    seen="$seen $t"
  done
else
  # A build with no version is the unpacked dev build; there is nothing to choose.
  [ "${#TARGETS[@]}" -eq 0 ] || die "a target can only be named for a release build: pass X.Y.Z first (got targets '${TARGETS[*]}' with no version)"
  TARGETS=(dev)
fi

ROOT="$(cd "$HERE/.." && pwd)"
for f in "$UBO_PREFIX/tools/make-mv3.sh" \
         "$CODEMIRROR_PREFIX/dist/cm6.bundle.ubol.min.js" \
         "$S14E_PREFIX/s14e-serializer.js"; do
  [ -f "$ROOT/$f" ] || die "subtree content missing: $f (run from a full checkout; see docs/upstream-sync.md)"
done
for t in node jq zip python3 rsvg-convert; do command -v "$t" >/dev/null || die "required tool not found: $t"; done
[ -f "$ROOT/.nvmrc" ] || die ".nvmrc missing: it is the single source of the node version"
want_major="$(tr -d '[:space:]v' < "$ROOT/.nvmrc")"; want_major="${want_major%%.*}"
[[ "$want_major" =~ ^[0-9]+$ ]] || die ".nvmrc does not start with a node major version"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge "$want_major" ] || die "node >= $want_major required by .nvmrc (have $(node -v))"

for f in thankmu/brand.json thankmu/patch.json thankmu/targets.json thankmu/patch_extension.py thankmu/icon.svg; do
  [ -f "$ROOT/$f" ] || die "ThankMu layer file missing: $f"
done
# Fail on a missing/incomplete brand, patch or targets config before the (slow) upstream build, not after.
# Every requested target, not just the first: a release that cannot build its second package must fail now,
# not after the first zip is already made. With the target: a release target without targets.json source_url
# (the GPLv3 source offer), or one naming an id its manifest key does not give, fails here.
for t in "${TARGETS[@]}"; do
  python3 -I "$ROOT/thankmu/patch_extension.py" --check-config target="$t"
done
# The ThankMu extension's JS logic tests (pairing). node is only here and in the docker image, so the
# build is where CI is guaranteed to run them; tests/run.sh runs them too when it can.
js_tests=(); while IFS= read -r f; do js_tests+=("$f"); done < <(cd "$ROOT" && find thankmu -name '*.test.mjs' | sort)
[ "${#js_tests[@]}" -gt 0 ] || die "no thankmu/**/*.test.mjs found: the ThankMu JS tests are missing"
( cd "$ROOT" && node --test "${js_tests[@]}" ) || die "ThankMu JS tests failed"

unset UBO_VERSION
cd "$ROOT/$UBO_PREFIX"
# Release builds must not reuse a cached ruleset download: freshness cannot depend on workspace state.
[ -z "$VERSION" ] || rm -rf dist/build/mv3-data
mkdir -p dist/build/mv3-data
./tools/make-mv3.sh chromium ${VERSION:+"$VERSION"}

PKG="dist/build/uBOLite.chromium"
UNPATCHED="dist/build/uBOLite.chromium.unpatched"
[ -f "$PKG/manifest.json" ] || die "upstream build finished but $PKG/manifest.json is missing"
rm -rf "$UNPATCHED"
cp -R "$PKG" "$UNPATCHED"
# The zip upstream just made holds the UNPATCHED package; it must never be published.
[ -z "$VERSION" ] || rm -f "dist/build/uBOLite_$VERSION.chromium.zip"

if [ -n "$VERSION" ]; then
  pkg_name="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["package_name"])' "$ROOT/thankmu/brand.json")"
  [ -n "$pkg_name" ] || die "thankmu/brand.json package_name is empty"
fi
[ -n "${CI:-}" ] || { : "${BUILD_SHORTSHA:=$(build_short_sha "$ROOT")}"; export BUILD_SHORTSHA; }

for TARGET in "${TARGETS[@]}"; do
  if [ -z "$VERSION" ]; then
    # Dev: the upstream output is patched where it stands, as the only target of the build.
    WORK="$PKG"
  else
    # Each release target is patched from the same pristine upstream output into its own directory, so one
    # upstream build yields every package and none of them sees another's patch.
    WORK="$PKG.$TARGET"
    rm -rf "$WORK"
    cp -R "$UNPATCHED" "$WORK"
  fi
  python3 -I "$ROOT/thankmu/patch_extension.py" packageDir="$WORK" target="$TARGET"
  "$ROOT/scripts/verify_chrome_package.sh" --target "$TARGET" "$ROOT/$UBO_PREFIX/$UNPATCHED" "$ROOT/$UBO_PREFIX/$WORK"

  if [ -n "$VERSION" ]; then
    # "store" keeps the plain package name: that file is what a submission uploads. Any other target says
    # which one it is, so two packages of the same version can never be mistaken for each other.
    if [ "$TARGET" = store ]; then out="dist/build/${pkg_name}_$VERSION.zip"
    else out="dist/build/${pkg_name}_${TARGET}_$VERSION.zip"; fi
    rm -f "$out"
    stage="$(mktemp -d)"
    cp -R "$WORK"/. "$stage"/
    rm -f "$stage/log.txt"   # same as upstream's packaging step
    ( cd "$stage" && zip -qr "$ROOT/$UBO_PREFIX/$out" ./* )
    rm -rf "$stage"
  else
    out="$WORK/manifest.json"
  fi
  [ -e "$out" ] || die "build finished but expected output is missing: $out"
  echo "Artifact: $ROOT/$UBO_PREFIX/$out"

  # Last step for this target, after its patch and its verification passed: leave a ready-to-load copy in
  # builds/ (skipped in CI).
  land_zip=""; [ -z "$VERSION" ] || land_zip="$ROOT/$UBO_PREFIX/$out"
  "$ROOT/scripts/land_build.sh" "$TARGET" "$ROOT/$UBO_PREFIX/$WORK" ${land_zip:+"$land_zip"}
done

# The canonical build output keeps holding the first target's package, so a release leaves the store package
# at the path everything already reads (and an MR build leaves the dev one, patched in place above).
if [ -n "$VERSION" ]; then
  rm -rf "$PKG"
  cp -R "$PKG.${TARGETS[0]}" "$PKG"
fi
