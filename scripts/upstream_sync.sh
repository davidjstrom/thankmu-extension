#!/usr/bin/env bash
# Pull a new upstream uBlock Origin release into chrome_plugin/ and move the two
# submodule subtrees (codemirror-ubol, s14e-serializer) to the SHAs that release pins.
# Sources are the git.draglabs.com mirrors only. See docs/upstream-sync.md.
#
# Usage: scripts/upstream_sync.sh pull <ubo-release-tag>     e.g. pull 1.75.0
# Env (all required): MIRROR_UBO_URL MIRROR_CODEMIRROR_URL MIRROR_S14E_URL
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

usage() { die "usage: scripts/upstream_sync.sh pull <ubo-release-tag>"; }

[ "${1:-}" = pull ] || usage
REF="${2:-}"; [ -n "$REF" ] || usage

require_env MIRROR_UBO_URL MIRROR_CODEMIRROR_URL MIRROR_S14E_URL
[[ "$REF" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "'$REF' is not a release tag (want X.Y.Z; rc/beta tags are not synced)"

cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain)" ] || die "working tree is not clean; commit or stash first"

mirror_url() { local v; v="MIRROR_$(upper "$1")_URL"; echo "${!v}"; }

# Squash commit message of a subtree carries "git-subtree-split: <sha>" (what we last pulled).
current_split() {
  git log -1 --format=%B -E --grep="^git-subtree-dir: $1/*\$" | sed -n 's/^git-subtree-split: //p' | head -1
}

echo ">> fetching ubo $REF from mirror"
git fetch --no-tags "$(mirror_url ubo)" "refs/tags/$REF"
UBO_COMMIT="$(git rev-parse FETCH_HEAD)"

# Read the submodule SHAs this release pins (gitlinks in upstream's tree).
for n in codemirror s14e; do
  rel="$(prefix_of "$n")"; rel="${rel#"$UBO_PREFIX"/}"
  line="$(git ls-tree "$UBO_COMMIT" -- "$rel")"
  [[ "$line" == 160000\ commit\ * ]] || die "upstream $REF has no submodule gitlink at $rel (layout changed? update scripts/lib.sh)"
  sha="${line#160000 commit }"; sha="${sha%%$'\t'*}"
  printf -v "PIN_$n" %s "$sha"   # bash 3.2 has no associative arrays
  echo "   pin $n -> $sha"
done

# Where upstream's tree has a gitlink and we hold a real subtree directory, git reports a
# file/directory conflict and parks the gitlink at "<prefix>~<sha>". Drop only those parked
# gitlinks, plus the never-carried $DROPPED_GITLINK; our directory (moved separately, below) is already in place.
is_parked_gitlink() {
  local p="$1" n
  [ "$p" = "$DROPPED_GITLINK" ] && return 0
  for n in codemirror s14e; do
    case "$p" in "$(prefix_of "$n")"~*) return 0 ;; esac
  done
  return 1
}

echo ">> subtree pull ubo $REF"
if ! git subtree pull --prefix="$UBO_PREFIX" "$(mirror_url ubo)" "$REF" --squash -m "chore(chrome_plugin): sync upstream uBlock Origin $REF (subtree pull, squashed)"; then
  conflicted="$(git diff --name-only --diff-filter=U)"
  [ -n "$conflicted" ] || die "subtree pull failed without conflicts"
  while IFS= read -r p; do
    is_parked_gitlink "$p" || die "unresolved conflict outside the submodule gitlinks: $p (resolve by hand, commit, then re-run to move the submodule subtrees)"
  done <<<"$conflicted"
  while IFS= read -r p; do
    git rm -rfq --cached -- "$p"; rm -rf -- "$p"
  done <<<"$conflicted"
  [ -z "$(git diff --name-only --diff-filter=U)" ] || die "conflicts remain after dropping parked gitlinks"
  git commit -q -m "chore(chrome_plugin): sync upstream uBlock Origin $REF (subtree pull, squashed)"
fi

for n in codemirror s14e; do
  pre="$(prefix_of "$n")"
  pin="PIN_$n"; pin="${!pin}"
  have="$(current_split "$pre")"
  [ -n "$have" ] || die "cannot find the last subtree pull for $pre"
  if [ "$have" = "$pin" ]; then
    echo ">> $n already at $pin"
  else
    echo ">> subtree pull $n -> $pin"
    git subtree pull --prefix="$pre" "$(mirror_url "$n")" "$pin" --squash \
      -m "chore(chrome_plugin): move $n subtree to ${pin:0:8} (pinned by uBlock Origin $REF)"
  fi
done

[ "$(git ls-files -s | grep -c '^160000')" = 0 ] || die "gitlinks present in index after sync"
echo ">> done. Update the pin table in docs/upstream-sync.md and review 'git log -5'."
