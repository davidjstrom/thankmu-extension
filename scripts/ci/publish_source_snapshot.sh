#!/usr/bin/env bash
# Publish the complete corresponding source of a Chrome release (GPLv3 §3, §6) as ONE squashed commit,
# tagged chrome-vX.Y.Z, to the public source repo: the location the About pane's source offer and the
# store listing point at (ADR-013 "Source publication"; EX-002 (a), a distribution channel, never a
# development host). Nothing else ever pushes there, and nobody works from it.
#
# It belongs to the release path (W-P4). The release_chrome job runs it AFTER the zip has passed
# check_store_zip.py and BEFORE the job ends, so a release whose source failed to publish keeps no
# artifact and cannot be submitted: the source is public no later than the binary, by construction.
#
# Usage: scripts/ci/publish_source_snapshot.sh X.Y.Z [--dry-run]
#   --dry-run builds, verifies and names the snapshot commit locally and pushes nothing, so
#   release_chrome_dry_run rehearses this path with no public repo and no credential. Everything
#   except the fetch and the push is the same code.
#
# Real runs need two CI variables (Settings -> CI/CD -> Variables), both Protected (the tag is a
# protected ref, ADR-001), the token also masked:
#   SNAPSHOT_REPO_URL    https push URL of the public source repo. It lives only in this variable,
#                        never in a tracked file, which is what keeps the host out of the repo (EX-002).
#   SNAPSHOT_PUSH_TOKEN  a token with write access to that one repo and nothing else.
#
# What is published: the release commit's tree minus PRIVATE below, plus a generated README.md.
# The licence requires the source of the binary, not our reasoning, so the design notes (docs/) and
# the store-submission material (store/) stay private; everything needed to build the released
# package ships. Re-running is safe: an already-published release with the same tree is a no-op, and
# a tag that already points at a different tree fails loudly instead of being moved.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
. "$ROOT/scripts/lib.sh"

# The branch the public repo keeps, and who the snapshot commits are by. Changing these changes the
# public repo's history shape, so they live here and nowhere else.
SNAPSHOT_BRANCH="main"
SNAPSHOT_COMMIT_NAME="ThankMu release"
SNAPSHOT_COMMIT_EMAIL="releases@thankmu.com"

# Held back from the snapshot: our reasoning and our store paperwork (ADR-013: the licence wants the
# source of the binary, not how we decided it) and the gitignored build landing folder. Each entry is
# a tracked path, matched exactly or as a directory prefix.
PRIVATE=(docs store builds)
# Replaced, not held back: the development README links into the private tracking repo and carries
# notes for us. A generated one (below) takes its place.
REPLACED=README.md
# Must survive, or the snapshot is not the corresponding source of the released package: the licence
# texts, the upstream manifest the build starts from, the whole ThankMu layer's configuration and
# patch step, and the scripts that compile and check the package (GPLv3 §1, "the scripts used to
# control compilation"). A sample, not an inventory: a missing one means the filter above went wrong.
REQUIRED=(
  NOTICE
  .nvmrc
  .gitlab-ci.yml
  chrome_plugin/LICENSE.txt
  chrome_plugin/platform/mv3/chromium/manifest.json
  scripts/build_chrome.sh
  scripts/ci/docker_build_chrome.sh
  scripts/ci/Dockerfile.chrome-build
  scripts/verify_chrome_package.sh
  thankmu/brand.json
  thankmu/patch.json
  thankmu/patch_extension.py
  thankmu/targets.json
)
# Must never survive: this is a push to a public repo, so agent state, env files and key material
# fail the run rather than ship, whatever the exclude list above says.
FORBIDDEN_RE='(^|/)(\.claude|\.env([.-][^/]*)?|[^/]*\.(key|pem|p12|pfx|jks))(/|$)'

VERSION=""; DRY=0; TOKEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    -*) die "unknown option: $1 (usage: publish_source_snapshot.sh X.Y.Z [--dry-run])" ;;
    *) [ -z "$VERSION" ] || die "usage: publish_source_snapshot.sh X.Y.Z [--dry-run] (two versions given: '$VERSION' and '$1')"; VERSION="$1" ;;
  esac
  shift
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: publish_source_snapshot.sh X.Y.Z [--dry-run] (got '$VERSION'; strip the chrome-v tag prefix first)"
TAG="chrome-v$VERSION"
command -v git >/dev/null || die "required tool not found: git"
command -v python3 >/dev/null || die "required tool not found: python3"
if [ "$DRY" -eq 0 ]; then
  require_env SNAPSHOT_REPO_URL SNAPSHOT_PUSH_TOKEN
  case "$SNAPSHOT_REPO_URL" in
    https://*) ;;
    # A loopback server is the test double (tests/fake_git_http.py). Any other plain-http URL would
    # put the push token on the wire in clear text.
    http://127.0.0.1[:/]*|http://localhost[:/]*) ;;
    *) die "SNAPSHOT_REPO_URL must be an https URL (the push token is sent over it)" ;;
  esac
  # Copy the token into a plain variable and un-export the CI variable, so git and its credential
  # helper see it only through SNAPSHOT_PUSH_TOKEN_CUR, set for the one fetch or push being run.
  TOKEN="$SNAPSHOT_PUSH_TOKEN"
  export -n SNAPSHOT_PUSH_TOKEN
fi

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
export GIT_TERMINAL_PROMPT=0
# The token reaches git through a helper reading SNAPSHOT_PUSH_TOKEN_CUR: never in argv, in a URL or
# in git config (the same shape as scripts/mirror_refresh.sh).
helper='!f() { echo username=oauth2; echo "password=$SNAPSHOT_PUSH_TOKEN_CUR"; }; f'
snap_git() { # git in $ROOT, with the token available to the credential helper for this call only
  SNAPSHOT_PUSH_TOKEN_CUR="$TOKEN" git -C "$ROOT" -c credential.helper= -c "credential.helper=$helper" "$@"
}

head_sha="$(git -C "$ROOT" rev-parse HEAD)" || die "cannot read HEAD of $ROOT"
echo ">> source snapshot of $head_sha for $TAG$([ "$DRY" -eq 1 ] && echo ' (dry run: nothing is pushed)')"

# ── the tree: HEAD's blobs, minus PRIVATE, plus a generated README.md ───────────────────────────────
# Built with plumbing in a scratch index, so the working tree is never touched and a dirty checkout
# cannot change what is published.
is_private() { # $1 = path
  local p="$1" e
  for e in "${PRIVATE[@]}"; do
    if [ "$p" = "$e" ] || [ "${p#"$e"/}" != "$p" ]; then return 0; fi
  done
  return 1
}
: > "$work/entries"
while IFS=$'\t' read -r -d '' meta path; do
  read -r mode type sha <<<"$meta"
  [ "$type" = blob ] || die "HEAD carries a $type at '$path'; a snapshot can only publish files (a gitlink cannot be published as source)"
  if is_private "$path" || [ "$path" = "$REPLACED" ]; then
    continue
  fi
  printf '%s %s\t%s\n' "$mode" "$sha" "$path" >> "$work/entries"
done < <(git -C "$ROOT" ls-tree -r -z --full-tree HEAD)
[ -s "$work/entries" ] || die "nothing left to publish after the private paths were held back"

# The generated README.md: what the repo is, which release, and that development happens elsewhere.
# Values come from thankmu/brand.json, so the public front page cannot drift from the build's own
# brand config. The wording is a draft and goes to counsel with the About notice, the source offer
# and the listing (store/README.md item 14).
python3 -I - "$ROOT/thankmu/brand.json" "$VERSION" "$TAG" > "$work/README.md" <<'PY'
import json, sys
brand, version, tag = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3]
for key in ("name", "credit", "package_name", "support_url"):
    if not brand.get(key):
        sys.exit(f"thankmu/brand.json {key} is empty: cannot generate the snapshot README")
print(f"""# {brand['name']} for Chrome: released source

The complete corresponding source of each released {brand['name']} browser extension, published to
meet the GNU General Public License, version 3.

**This release:** {version} (store package `{brand['package_name']}_{version}.zip`, tag `{tag}`).

{brand['credit']} It is not made or endorsed by Raymond Hill.
See [`NOTICE`](NOTICE) and [`chrome_plugin/LICENSE.txt`](chrome_plugin/LICENSE.txt).

## What is here

- `chrome_plugin/`: the uBlock Origin Lite (MV3) tree this extension forks, as released.
- `thankmu/`: the {brand['name']} layer, and the brand and patch configuration the build applies.
- `scripts/`: the build. `scripts/ci/docker_build_chrome.sh` builds the package in a pinned
  toolchain; `scripts/verify_chrome_package.sh` and `scripts/check_store_zip.py` check the result.
- `tests/`: the test suite (`tests/run.sh`).
- `.gitlab-ci.yml`: the pipeline that builds and releases it.

## How this repository is used

{brand['name']} is developed privately. This repository receives **one squashed commit per public
release**, pushed by the release pipeline and tagged with that release's version. There is no
development history and no branch work here, and issues or pull requests opened here are not read.
The licence requires the source of every released binary to be public; it does not require the
development history, so that stays private.

Support and contact: {brand['support_url']}""")
PY
[ -s "$work/README.md" ] || die "the generated snapshot README is empty"
readme_blob="$(git -C "$ROOT" hash-object -w --stdin < "$work/README.md")"
printf '%s %s\t%s\n' 100644 "$readme_blob" "$REPLACED" >> "$work/entries"

GIT_INDEX_FILE="$work/index" git -C "$ROOT" update-index --index-info < "$work/entries"
tree="$(GIT_INDEX_FILE="$work/index" git -C "$ROOT" write-tree)"

# ── verify the tree before anything leaves the machine ─────────────────────────────────────────────
# Read the finished tree back out of git rather than trusting the list that built it, so an index or
# write-tree mistake is caught too. Every comparison is literal, never a pattern.
git -C "$ROOT" ls-tree -r --name-only --full-tree "$tree" > "$work/tree-paths"
[ -s "$work/tree-paths" ] || die "the snapshot tree $tree is empty"
while IFS= read -r p; do
  if is_private "$p"; then die "private path '$p' survived into the snapshot tree $tree"; fi
done < "$work/tree-paths"
for p in "${REQUIRED[@]}"; do
  grep -qxF -- "$p" "$work/tree-paths" || die "the snapshot is missing '$p', so it is not the complete corresponding source of $VERSION"
done
# The published $REPLACED is the generated one, never the development file.
[ "$(git -C "$ROOT" rev-parse "$tree:$REPLACED")" = "$readme_blob" ] \
  || die "$REPLACED in the snapshot tree is not the generated one"
leaked="$(grep -E -- "$FORBIDDEN_RE" "$work/tree-paths" || true)"
if [ -n "$leaked" ]; then die "the snapshot tree carries files that must never be published:"$'\n'"$leaked"; fi
n_files="$(wc -l < "$work/tree-paths" | tr -d ' ')"
echo ">> tree $tree: $n_files files (held back: ${PRIVATE[*]})"

# ── where it lands ─────────────────────────────────────────────────────────────────────────────────
# refs/snapshot/* in this repo is scratch: the public repo's current state, fetched to pick the parent
# commit and to see whether this release is already published. It is never pushed from. Cleared first,
# so a ref left by an earlier run can never make a release look published; the refspecs are wildcards,
# so the very first release (an empty public repo, nothing to match) is not an error.
parent=""
if [ "$DRY" -eq 0 ]; then
  while IFS= read -r r; do
    [ -n "$r" ] && git -C "$ROOT" update-ref -d "$r"
  done < <(git -C "$ROOT" for-each-ref --format='%(refname)' 'refs/snapshot/')
  snap_git fetch -q --no-tags --force "$SNAPSHOT_REPO_URL" \
    "+refs/heads/*:refs/snapshot/heads/*" "+refs/tags/*:refs/snapshot/tags/*" \
    || die "cannot read the public source repo at SNAPSHOT_REPO_URL (check the URL and that SNAPSHOT_PUSH_TOKEN still has access)"
  parent="$(git -C "$ROOT" rev-parse -q --verify "refs/snapshot/heads/$SNAPSHOT_BRANCH" || true)"
  existing="$(git -C "$ROOT" rev-parse -q --verify "refs/snapshot/tags/$TAG^{commit}" || true)"
  if [ -n "$existing" ]; then
    if [ "$(git -C "$ROOT" rev-parse "$existing^{tree}")" = "$tree" ]; then
      echo ">> $TAG is already published with this exact tree ($existing); nothing to do"
      exit 0
    fi
    die "$TAG already exists in the public source repo with a different tree ($existing). A published release is never rewritten: bump the version, or delete that tag deliberately."
  fi
  if [ -n "$parent" ] && [ "$(git -C "$ROOT" rev-parse "$parent^{tree}")" = "$tree" ]; then
    # A retry after main went through but the tag did not: tag what is already there rather than
    # adding an empty commit.
    echo ">> the public branch already holds this tree; tagging $parent as $TAG"
    commit="$parent"
  fi
fi

if [ -z "${commit:-}" ]; then
  brand_name="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$ROOT/thankmu/brand.json")"
  pargs=(); [ -n "$parent" ] && pargs=(-p "$parent")
  commit="$(GIT_AUTHOR_NAME="$SNAPSHOT_COMMIT_NAME" GIT_AUTHOR_EMAIL="$SNAPSHOT_COMMIT_EMAIL" \
    GIT_COMMITTER_NAME="$SNAPSHOT_COMMIT_NAME" GIT_COMMITTER_EMAIL="$SNAPSHOT_COMMIT_EMAIL" \
    git -C "$ROOT" commit-tree "$tree" ${pargs[@]+"${pargs[@]}"} <<EOF
$brand_name $VERSION

Squashed source snapshot of the released extension, published under GPLv3.
Release tag: $TAG, built from the store target of this tree.
Development history is private; this repository holds releases only.
EOF
)" || die "cannot create the snapshot commit"
fi
echo ">> snapshot commit $commit${parent:+ (parent $parent)}"

if [ "$DRY" -eq 1 ]; then
  echo ">> DRY RUN: would push $commit to $SNAPSHOT_BRANCH and tag it $TAG. Nothing was pushed."
  exit 0
fi

# Both refs in one atomic, non-forced push: main only fast-forwards (a published snapshot is never
# rewritten) and the tag is only created, never moved. A rejection fails the release.
snap_git push --atomic "$SNAPSHOT_REPO_URL" "$commit:refs/heads/$SNAPSHOT_BRANCH" "$commit:refs/tags/$TAG" \
  || die "pushing the source snapshot was rejected; the release is not published and must not be submitted"
echo ">> published $TAG ($n_files files) to the public source repo"
