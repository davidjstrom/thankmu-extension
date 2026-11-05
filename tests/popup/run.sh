#!/usr/bin/env bash
# W-P6: drive the real built popup in Chromium (tests/popup/popup_e2e.mjs): every D2 state in light and dark, and
# every upstream control. Then (not with --heights) the ad-slot cards on a local page (tests/popup/cards_e2e.mjs,
# W-T1 follow-up: one card per emptied slot, one shared state) and the signed-out state (tests/popup/signedout_e2e.mjs,
# W-T1 single purpose: every request the extension makes is recorded; signed out there must be none, only the corner
# pill). Needs docker; not run in CI. Usage:
#   scripts/ci/docker_build_chrome.sh      (once: the dev build at chrome_plugin/dist/build/uBOLite.chromium)
#   tests/popup/run.sh [--heights] [<unpacked extension dir>]
# --heights runs only the height matrix (every state, smallest and largest, light and dark, must fit Chrome's 600 px).
# Screenshots of each state land in tests/popup/.work/ (gitignored) for a person to look at.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
. "$ROOT/scripts/lib.sh"
PLAYWRIGHT_VERSION="$(sed -n 's/^PLAYWRIGHT_VERSION=\([0-9.]*\).*/\1/p' "$ROOT/store/screenshots/generate.sh")"   # one pin
[ -n "$PLAYWRIGHT_VERSION" ] || die "could not read PLAYWRIGHT_VERSION from store/screenshots/generate.sh"
POPUP_HEIGHTS_ONLY=0
if [ "${1:-}" = "--heights" ]; then POPUP_HEIGHTS_ONLY=1; shift; fi
export POPUP_HEIGHTS_ONLY
EXT="${1:-$ROOT/$UBO_PREFIX/dist/build/uBOLite.chromium}"
[ -f "$EXT/manifest.json" ] || die "no built extension at $EXT: run scripts/ci/docker_build_chrome.sh first"
EXT="$(cd "$EXT" && pwd)"
command -v docker >/dev/null || die "required tool not found: docker"
rm -rf "$HERE/.work"; mkdir -p "$HERE/.work/shots"
cp -R "$EXT" "$HERE/.work/ext"   # a copy: the browser profile must never write into the build
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e POPUP_HEIGHTS_ONLY -e PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 --ipc=host -v "$HERE:/t" -w /tmp \
  "mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble" bash -euc "
  mkdir -p /tmp/pw && cd /tmp/pw && npm init -y >/dev/null && npm i --silent --no-audit --no-fund playwright@${PLAYWRIGHT_VERSION}
  cp /t/popup_e2e.mjs /t/cards_e2e.mjs /t/signedout_e2e.mjs /tmp/pw/ && node popup_e2e.mjs /t/.work/ext /t/.work/shots
  if [ \"\$POPUP_HEIGHTS_ONLY\" != 1 ]; then node cards_e2e.mjs /t/.work/ext /t/.work/shots; node signedout_e2e.mjs /t/.work/ext /t/.work/shots; fi
"
