#!/usr/bin/env bash
# Package-level checks on a built, patched Chromium package (W-P3). Needs python3 only.
# Usage: scripts/verify_chrome_package.sh [--target dev|store] [<unpatchedDir> <patchedDir>]
#   no dirs  -> the default build output under chrome_plugin/dist/build/
#   --target -> require the package to be that build target (thankmu/targets.json); without it the
#               target is inferred from the manifest, and the run fails if no single target matches
# 1. no upstream marks in anything user-visible, and the About pane's GPLv3 notice and source offer for the
#    target (scripts/check_package_brand.py)
# 2. blocking files identical to the unpatched upstream build, plus exactly the ThankMu layer
#    (scripts/check_blocking_unchanged.py)
# 3. upstream's popup keeps every control and readout, between the ThankMu frames (scripts/check_popup_inventory.py, W-P6)
# 4. with --target: the toolbar/store icons are the target's final set, none of upstream's or a placeholder
#    (scripts/check_icons.py; the dev set and the store set are different files)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"
ROOT="$(cd "$HERE/.." && pwd)"
TARGET_ARG=()
if [ "${1:-}" = "--target" ]; then
  [ -n "${2:-}" ] || die "--target needs a value (dev or store)"
  TARGET_ARG=("target=$2"); shift 2
fi
UNPATCHED="${1:-$ROOT/$UBO_PREFIX/dist/build/uBOLite.chromium.unpatched}"
PATCHED="${2:-$ROOT/$UBO_PREFIX/dist/build/uBOLite.chromium}"
command -v python3 >/dev/null || die "required tool not found: python3"
[ -f "$PATCHED/manifest.json" ] || die "patched package not found: $PATCHED (build first)"
[ -f "$UNPATCHED/manifest.json" ] || die "unpatched baseline not found: $UNPATCHED (build_chrome.sh writes it)"
python3 -I "$HERE/check_package_brand.py" "$PATCHED" ${TARGET_ARG[@]+"${TARGET_ARG[@]}"}
python3 -I "$HERE/check_blocking_unchanged.py" "$UNPATCHED" "$PATCHED" ${TARGET_ARG[@]+"${TARGET_ARG[@]}"}
python3 -I "$HERE/check_popup_inventory.py" "$UNPATCHED" "$PATCHED"
if [ "${#TARGET_ARG[@]}" -gt 0 ]; then
  python3 -I "$HERE/check_icons.py" "$UNPATCHED" "$PATCHED" "${TARGET_ARG[@]}"
fi
