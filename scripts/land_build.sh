#!/usr/bin/env bash
# Land a finished, verified build under builds/<target>/<version>-<shortsha>/ so it is easy to find
# and load into Chrome. Called by scripts/build_chrome.sh as its last step; never lands a failed build.
# Usage: scripts/land_build.sh <target> <patchedPackageDir> [<zip>]
#   leaves: builds/<target>/<version>-<sha>/unpacked/ and .../<package_name>_<target>_<version>-<sha>.zip
#           builds/<target>/latest -> <version>-<sha>   (relative symlink)
#           builds/<target>/current/   real directory, copy of the newest unpacked/ (load this once in Chrome, then just reload)
#   prunes: all but the newest $BUILDS_KEEP (default BUILDS_KEEP_DEFAULT in lib.sh) builds of this target
#   skips:  when CI is set (CI artifacts stay exactly as they are; the CI workspace is throwaway)
# Env: BUILD_SHORTSHA (required; the docker wrapper sets it because the image has no git), BUILDS_KEEP, CI.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"
ROOT="$(cd "$HERE/.." && pwd)"

TARGET="${1:-}"; PKG="${2:-}"; ZIP_IN="${3:-}"
[ -n "$TARGET" ] && [ -n "$PKG" ] || die "usage: land_build.sh <target> <patchedPackageDir> [<zip>]"
if [ -n "${CI:-}" ]; then echo "Landing skipped: CI is set (builds/ is for local builds)"; exit 0; fi

KEEP="${BUILDS_KEEP:-$BUILDS_KEEP_DEFAULT}"
[[ "$KEEP" =~ ^[0-9]+$ ]] && [ "$KEEP" -ge 1 ] || die "BUILDS_KEEP '$KEEP' must be a whole number >= 1"
SHA="${BUILD_SHORTSHA:-}"
[ -n "$SHA" ] || die "BUILD_SHORTSHA is not set"
[[ "$SHA" =~ ^[0-9a-f]{7,40}(-dirty)?$ ]] || die "BUILD_SHORTSHA '$SHA' must be a git short sha, optionally followed by -dirty"
[ -f "$PKG/manifest.json" ] || die "patched package not found: $PKG/manifest.json"
[ -z "$ZIP_IN" ] || [ -f "$ZIP_IN" ] || die "zip not found: $ZIP_IN"
command -v python3 >/dev/null || die "required tool not found: python3"

python3 -I - "$ROOT/thankmu/targets.json" "$TARGET" <<'PY' || die "target '$TARGET' is not in thankmu/targets.json"
import json, sys
t = json.load(open(sys.argv[1]))
sys.exit(0 if not sys.argv[2].startswith("_") and isinstance(t.get(sys.argv[2]), dict) else 1)
PY
VERSION="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$PKG/manifest.json")"
[[ "$VERSION" =~ ^[0-9]+(\.[0-9]+)*$ ]] || die "manifest version '$VERSION' is not dotted digits"
PKG_NAME="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["package_name"])' "$ROOT/thankmu/brand.json")"
[[ "$PKG_NAME" =~ ^[A-Za-z0-9_]+$ ]] || die "thankmu/brand.json package_name '$PKG_NAME' is empty or has unsafe characters"

NAME="$VERSION-$SHA"
BUILDS="$ROOT/builds"; TDIR="$BUILDS/$TARGET"; DEST="$TDIR/$NAME"
[ ! -L "$BUILDS" ] || die "$BUILDS is a symlink; refusing to land through it"
mkdir -p "$TDIR"
[ ! -L "$TDIR" ] || die "$TDIR is a symlink; refusing to land through it"
ZNAME="${PKG_NAME}_${TARGET}_${NAME}.zip"
[ ! -e "$TDIR/latest" ] || [ -L "$TDIR/latest" ] || die "$TDIR/latest exists and is not a symlink; remove it (refusing to write a link inside it)"
[ -n "$ZIP_IN" ] || command -v zip >/dev/null || die "required tool not found: zip"

# Sweep what an earlier run left behind (a SIGKILL runs no trap). An orphaned .current.old.* is the previous
# current/ if the swap was cut between its two renames: put it back before anything else.
for old in "$TDIR"/.current.old.*; do
  [ -d "$old" ] || continue
  if [ ! -e "$TDIR/current" ]; then mv "$old" "$TDIR/current"; fi
done
rm -rf "$TDIR"/.stage.* "$TDIR"/.current.*

# Stage inside builds/<target>/, then swap in, so a half-copied build never carries a real name.
STAGE="$(mktemp -d "$TDIR/.stage.XXXXXX")"
chmod 755 "$STAGE"   # mktemp makes it 0700
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/unpacked"
cp -R "$PKG"/. "$STAGE/unpacked/"
rm -f "$STAGE/unpacked/log.txt"   # same as the release packaging step
if [ -n "$ZIP_IN" ]; then cp "$ZIP_IN" "$STAGE/$ZNAME"
else ( cd "$STAGE/unpacked" && zip -qr "$STAGE/$ZNAME" . ); fi
[ -s "$STAGE/$ZNAME" ] || die "zip is missing or empty: $ZNAME"
rm -rf "$DEST"
mv "$STAGE" "$DEST"
trap - EXIT
touch "$DEST"
ln -sfn "$NAME" "$TDIR/latest"

# current/: a real directory (Chrome's Load unpacked may remember a resolved path, so a symlink would go stale).
# Copy to a sibling, then swap with two renames; the path is missing only between them.
[ ! -L "$TDIR/current" ] || die "$TDIR/current is a symlink; it must be a real directory"
NEW="$TDIR/.current.new.$$"; OLD="$TDIR/.current.old.$$"
# If interrupted between the renames, put the old current/ back rather than deleting it.
trap 'if [ ! -e "$TDIR/current" ] && [ -d "$OLD" ]; then mv "$OLD" "$TDIR/current"; fi; rm -rf "$NEW" "$OLD"' EXIT
rm -rf "$NEW" "$OLD"
cp -R "$DEST/unpacked" "$NEW"
if [ -e "$TDIR/current" ]; then mv "$TDIR/current" "$OLD"; fi
mv "$NEW" "$TDIR/current"
rm -rf "$OLD"
trap - EXIT

# Prune: newest KEEP real build dirs stay (the one just landed always does). Only plain directories
# directly under builds/<target>/ whose names look like builds are candidates; symlinks are never followed or removed.
n=0
while IFS= read -r entry; do
  [[ "$entry" =~ ^[0-9]+(\.[0-9]+)*-[0-9a-f]{7,40}(-dirty)?$ ]] || continue
  [ -d "$TDIR/$entry" ] && [ ! -L "$TDIR/$entry" ] || continue
  n=$((n+1))
  [ "$entry" = "$NAME" ] && continue
  if [ "$n" -gt "$KEEP" ]; then rm -rf -- "${TDIR:?}/$entry"; echo "Pruned old build: $TARGET/$entry"; fi
done < <(ls -1t "$TDIR")
echo "Landed: $DEST (latest -> $NAME)"
