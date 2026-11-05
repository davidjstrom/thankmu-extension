# Shared helpers for scripts/*.sh. Source, do not execute.

# The three upstream trees we carry as git subtrees: name, prefix in this repo.
# The name upper-cased drives the env var names (MIRROR_<NAME>_URL, UPSTREAM_<NAME>_URL).
UBO_PREFIX="chrome_plugin"
CODEMIRROR_PREFIX="chrome_plugin/platform/mv3/extension/lib/codemirror/codemirror-ubol"
S14E_PREFIX="chrome_plugin/platform/mv3/extension/lib/s14e-serializer"
SUBTREE_NAMES="ubo codemirror s14e"
# Upstream submodule we deliberately do not carry (not needed to build). Its gitlink is dropped on every pull.
DROPPED_GITLINK="chrome_plugin/publish-extension"

die() { echo "ERROR: $*" >&2; exit 1; }

require_env() {
  local v
  for v in "$@"; do
    [ -n "${!v:-}" ] || die "required environment variable $v is not set"
  done
}

upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }

# prefix_of <name> -> path of that subtree in this repo
prefix_of() {
  case "$1" in
    ubo) echo "$UBO_PREFIX" ;;
    codemirror) echo "$CODEMIRROR_PREFIX" ;;
    s14e) echo "$S14E_PREFIX" ;;
    *) die "unknown subtree name: $1" ;;
  esac
}

# Local builds are landed under builds/<target>/ (scripts/land_build.sh). Keep the newest N per target.
# Override per run with BUILDS_KEEP; this is the only place the default lives.
BUILDS_KEEP_DEFAULT=10

# build_short_sha <repo-root> -> "<shortsha>" or "<shortsha>-dirty" (tracked files differ from HEAD)
build_short_sha() {
  command -v git >/dev/null || die "git not found: cannot name the build (set BUILD_SHORTSHA)"
  local sha
  sha="$(git -C "$1" rev-parse --short HEAD 2>/dev/null)" || die "cannot read the git revision of $1 (set BUILD_SHORTSHA)"
  if git -C "$1" diff --quiet HEAD -- 2>/dev/null; then echo "$sha"; else echo "$sha-dirty"; fi
}
