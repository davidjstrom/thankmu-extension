#!/usr/bin/env bash
# Refresh the three git.draglabs.com upstream mirrors (GitLab CE has no pull mirroring).
# Branches are force-updated (upstream rebases); tags are NOT, so a moved upstream tag fails loudly
# instead of silently changing what a later sync pulls. Runs from the scheduled CI job only. All URLs and tokens come from CI variables.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"

vars=()
for n in $SUBTREE_NAMES; do vars+=("UPSTREAM_$(upper "$n")_URL" "MIRROR_$(upper "$n")_URL" "MIRROR_PUSH_TOKEN_$(upper "$n")"); done
require_env "${vars[@]}"
# Copy each token into a plain shell variable, then un-export the CI variable: git and its credential helper
# must see only the one token of the mirror being pushed (MIRROR_PUSH_TOKEN_CUR), never all three.
for n in $SUBTREE_NAMES; do
  T="MIRROR_PUSH_TOKEN_$(upper "$n")"
  printf -v "TOK_$n" '%s' "${!T}"
  export -n "$T"
done

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
export GIT_TERMINAL_PROMPT=0
# Each mirror has its own project access token (MIRROR_PUSH_TOKEN_<NAME>). It reaches git through a credential
# helper reading MIRROR_PUSH_TOKEN_CUR, which is set for that one push only: never in argv, URLs or git config.
helper='!f() { echo username=oauth2; echo "password=$MIRROR_PUSH_TOKEN_CUR"; }; f'

for n in $SUBTREE_NAMES; do
  U="UPSTREAM_$(upper "$n")_URL"; M="MIRROR_$(upper "$n")_URL"; TK="TOK_$n"
  echo ">> refreshing mirror: $n"
  git init -q --bare "$work/$n.git"
  git -C "$work/$n.git" fetch -q --no-tags "${!U}" '+refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'
  MIRROR_PUSH_TOKEN_CUR="${!TK}" git -C "$work/$n.git" -c credential.helper= -c "credential.helper=$helper" \
    push -q "${!M}" '+refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'
done
echo ">> all mirrors refreshed"
