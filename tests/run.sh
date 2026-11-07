#!/usr/bin/env bash
# Plain-shell test runner (no bats on the CI host). Usage: tests/run.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0; FAILED=()
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); FAILED+=("$1"); echo "  FAIL $1${2:+ -- $2}"; }
# expect_fail <name> <expected-stderr-substring> -- cmd...
expect_fail() {
  local name="$1" want="$2"; shift 3
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then bad "$name" "expected failure, got success"
  elif ! grep -q -- "$want" <<<"$out"; then bad "$name" "message lacks '$want': $out"
  else ok "$name"; fi
}
gq() { git -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }

echo "== upstream_sync.sh: required config =="
for v in MIRROR_UBO_URL MIRROR_CODEMIRROR_URL MIRROR_S14E_URL; do
  env_all=(MIRROR_UBO_URL=x MIRROR_CODEMIRROR_URL=x MIRROR_S14E_URL=x)
  rest=(); for e in "${env_all[@]}"; do [ "${e%%=*}" = "$v" ] || rest+=("$e"); done
  expect_fail "sync fails without $v" "$v" -- env -u "$v" "${rest[@]}" "$ROOT/scripts/upstream_sync.sh" pull 1.75.0
done
export MIRROR_UBO_URL=x MIRROR_CODEMIRROR_URL=x MIRROR_S14E_URL=x
expect_fail "sync rejects a non-release ref" "release tag" -- "$ROOT/scripts/upstream_sync.sh" pull 1.75.1rc3
expect_fail "sync rejects missing ref" "usage" -- "$ROOT/scripts/upstream_sync.sh" pull
expect_fail "sync rejects unknown command" "usage" -- "$ROOT/scripts/upstream_sync.sh" frobnicate
unset MIRROR_UBO_URL MIRROR_CODEMIRROR_URL MIRROR_S14E_URL

echo "== mirror_refresh.sh: required config =="
for v in UPSTREAM_UBO_URL UPSTREAM_CODEMIRROR_URL UPSTREAM_S14E_URL MIRROR_UBO_URL MIRROR_CODEMIRROR_URL MIRROR_S14E_URL MIRROR_PUSH_TOKEN_UBO MIRROR_PUSH_TOKEN_CODEMIRROR MIRROR_PUSH_TOKEN_S14E; do
  e=(UPSTREAM_UBO_URL=x UPSTREAM_CODEMIRROR_URL=x UPSTREAM_S14E_URL=x MIRROR_UBO_URL=x MIRROR_CODEMIRROR_URL=x MIRROR_S14E_URL=x MIRROR_PUSH_TOKEN_UBO=x MIRROR_PUSH_TOKEN_CODEMIRROR=x MIRROR_PUSH_TOKEN_S14E=x)
  rest=(); for x in "${e[@]}"; do [ "${x%%=*}" = "$v" ] || rest+=("$x"); done
  expect_fail "refresh fails without $v" "$v" -- env -i PATH="$PATH" HOME="$TMP" "${rest[@]}" "$ROOT/scripts/mirror_refresh.sh"
done

echo "== mirror_refresh.sh: pushes via the credential helper (authenticated HTTP) =="
for n in ubo codemirror s14e; do
  git init -q "$TMP/up-$n" && ( cd "$TMP/up-$n" && echo "$n" > f && git add f && gq commit -qm c1 && git branch -M main && gq tag 1.0.0 )
  mkdir -p "$TMP/srv" && git init -q --bare "$TMP/srv/mir-$n.git"
done
T_UBO=tok-ubo-aaa; T_CM=tok-cm-bbb; T_S14=tok-s14-ccc
python3 "$ROOT/tests/fake_git_http.py" "$TMP/srv" "$TMP/port" "$TMP/srv.log" mir-ubo.git=$T_UBO mir-codemirror.git=$T_CM mir-s14e.git=$T_S14 & SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$TMP"' EXIT
for _ in $(seq 50); do [ -s "$TMP/port" ] && break; sleep 0.1; done
PORT="$(cat "$TMP/port")"
refresh() { # <ubo-token> <codemirror-token> <s14e-token>
  env -i PATH="${REFRESH_PATH:-$PATH}" HOME="$TMP" SPY_DIR="${SPY_DIR:-}" MIRROR_PUSH_TOKEN_UBO="$1" MIRROR_PUSH_TOKEN_CODEMIRROR="$2" MIRROR_PUSH_TOKEN_S14E="$3" \
    UPSTREAM_UBO_URL="file://$TMP/up-ubo" UPSTREAM_CODEMIRROR_URL="file://$TMP/up-codemirror" UPSTREAM_S14E_URL="file://$TMP/up-s14e" \
    MIRROR_UBO_URL="http://127.0.0.1:$PORT/mir-ubo.git" MIRROR_CODEMIRROR_URL="http://127.0.0.1:$PORT/mir-codemirror.git" MIRROR_S14E_URL="http://127.0.0.1:$PORT/mir-s14e.git" \
    "$ROOT/scripts/mirror_refresh.sh" 2>&1
}
out="$(refresh wrong-token $T_CM $T_S14)" && bad "refresh with a wrong token fails" \
  || { grep -q "Authentication failed" <<<"$out" && ok "refresh with a wrong token fails with an auth failure" || bad "refresh with a wrong token fails with an auth failure" "$out"; }
# Per-mirror scoping: a valid token for another mirror is rejected (ubo token offered to codemirror, and so on).
out="$(refresh $T_UBO $T_UBO $T_S14)" && bad "refresh rejects another mirror's token (codemirror)" \
  || { grep -q "Authentication failed" <<<"$out" && ok "refresh rejects another mirror's token (codemirror)" || bad "refresh rejects another mirror's token (codemirror)" "$out"; }
out="$(refresh $T_UBO $T_CM $T_UBO)" && bad "refresh rejects another mirror's token (s14e)" \
  || { grep -q "Authentication failed" <<<"$out" && ok "refresh rejects another mirror's token (s14e)" || bad "refresh rejects another mirror's token (s14e)" "$out"; }
out="$(refresh $T_CM $T_CM $T_S14)" && bad "refresh rejects another mirror's token (ubo)" \
  || { grep -q "Authentication failed" <<<"$out" && ok "refresh rejects another mirror's token (ubo)" || bad "refresh rejects another mirror's token (ubo)" "$out"; }
out="$(refresh $T_UBO $T_CM $T_S14)" || { bad "refresh with the right tokens succeeds" "$out"; }
for n in ubo codemirror s14e; do
  if git -C "$TMP/srv/mir-$n.git" rev-parse -q --verify refs/heads/main >/dev/null && git -C "$TMP/srv/mir-$n.git" rev-parse -q --verify refs/tags/1.0.0 >/dev/null
  then ok "mirror $n received branch+tag"; else bad "mirror $n received branch+tag"; fi
done
grep -q -e "$T_UBO" -e "$T_CM" -e "$T_S14" <<<"$out" && bad "refresh does not leak tokens" || ok "refresh does not leak tokens"
grep -rqs -e "$T_UBO" -e "$T_CM" -e "$T_S14" "$TMP"/*.git/config "$TMP/.gitconfig" && bad "tokens not written to git config" || ok "tokens not written to git config"
# Each push (and so its credential helper) must see only its own mirror's token, never all three.
mkdir -p "$TMP/spy" && printf '#!/bin/sh\nfor a in "$@"; do [ "$a" = push ] && env > "$SPY_DIR/env.$$"; done\nexec "%s" "$@"\n' "$(command -v git)" > "$TMP/spy/git" && chmod +x "$TMP/spy/git"
mkdir -p "$TMP/spyout"
SPY_DIR="$TMP/spyout" REFRESH_PATH="$TMP/spy:$PATH" refresh $T_UBO $T_CM $T_S14 >/dev/null || bad "refresh succeeds with the git spy"
n_env=$(ls "$TMP/spyout" | wc -l | tr -d ' ')
[ "$n_env" = 3 ] && ok "spy recorded the environment of all three pushes" || bad "spy recorded the environment of all three pushes" "got $n_env"
leaks=0; for f in "$TMP"/spyout/env.*; do
  grep -q 'MIRROR_PUSH_TOKEN_CUR=' "$f" || leaks=$((leaks+1))
  [ "$(grep -c -e "$T_UBO" -e "$T_CM" -e "$T_S14" "$f")" = 1 ] || leaks=$((leaks+1))
  grep -q '^MIRROR_PUSH_TOKEN_\(UBO\|CODEMIRROR\|S14E\)=' "$f" && leaks=$((leaks+1))
done
[ $leaks = 0 ] && ok "each push sees exactly one token and no exported MIRROR_PUSH_TOKEN_<NAME>" || bad "each push sees exactly one token and no exported MIRROR_PUSH_TOKEN_<NAME>" "$leaks violations"
# A repo path nobody registered is rejected even with no credentials at all.
GIT_ASKPASS=false SSH_ASKPASS=false GIT_TERMINAL_PROMPT=0 git -C "$TMP/up-ubo" -c credential.helper= -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 push -q "http://127.0.0.1:$PORT/no-such.git" HEAD >"$TMP/unk.out" 2>&1 \
  && bad "push to an unknown repo path is rejected" || { grep -q "Authentication failed\|could not read Username" "$TMP/unk.out" && ok "push to an unknown repo path is rejected" || bad "push to an unknown repo path is rejected" "$(cat "$TMP/unk.out")"; }
# A rebased upstream branch is force-updated; a moved upstream tag must fail loudly and leave the mirror alone.
( cd "$TMP/up-ubo" && echo more > f && gq commit -qam c2 )
refresh $T_UBO $T_CM $T_S14 >/dev/null && ok "refresh force-updates a moved branch" || bad "refresh force-updates a moved branch"
OLD_TAG="$(git -C "$TMP/srv/mir-ubo.git" rev-parse refs/tags/1.0.0)"
( cd "$TMP/up-ubo" && gq tag -f 1.0.0 >/dev/null )
out="$(refresh $T_UBO $T_CM $T_S14)" && bad "refresh fails on a moved upstream tag" \
  || { grep -q "rejected" <<<"$out" && grep -q "1.0.0" <<<"$out" && ok "refresh fails on a moved upstream tag with a tag rejection" || bad "refresh fails on a moved upstream tag with a tag rejection" "$out"; }
[ "$(git -C "$TMP/srv/mir-ubo.git" rev-parse refs/tags/1.0.0)" = "$OLD_TAG" ] && ok "moved tag did not rewrite the mirror" || bad "moved tag did not rewrite the mirror"
kill $SRV 2>/dev/null
[ ! -s "$TMP/srv.log" ] && ok "fake git server saw no backend failures" || bad "fake git server saw no backend failures" "$(cat "$TMP/srv.log")"

echo "== upstream_sync.sh: pull moves root + submodule subtrees =="
CMP=platform/mv3/extension/lib/codemirror/codemirror-ubol
S14=platform/mv3/extension/lib/s14e-serializer
# Distinct contents per repo, so a swapped pin or prefix cannot pass.
git init -q "$TMP/sub-cm" && ( cd "$TMP/sub-cm" && echo cm-one > f && git add f && gq commit -qm a && echo cm-two > f && gq commit -qam b )
git init -q "$TMP/sub-s14" && ( cd "$TMP/sub-s14" && echo s14-one > f && echo extra > g && git add f g && gq commit -qm a && echo s14-two > f && gq commit -qam b )
CM1=$(git -C "$TMP/sub-cm" rev-parse HEAD~1); CM2=$(git -C "$TMP/sub-cm" rev-parse HEAD)
S1=$(git -C "$TMP/sub-s14" rev-parse HEAD~1); S2=$(git -C "$TMP/sub-s14" rev-parse HEAD)
[ "$CM2" != "$S2" ] && [ "$CM1" != "$S1" ] && ok "fixture submodule SHAs differ" || bad "fixture submodule SHAs differ"
git init -q "$TMP/ubo" && ( cd "$TMP/ubo" && echo one > core && git add core \
  && git update-index --add --cacheinfo "160000,$CM1,$CMP" --cacheinfo "160000,$S1,$S14" --cacheinfo "160000,$CM1,publish-extension" \
  && gq commit -qm r1 && gq tag 1.0.0 \
  && echo two > core && git add core && git update-index --cacheinfo "160000,$CM2,$CMP" --cacheinfo "160000,$S2,$S14" --cacheinfo "160000,$CM2,publish-extension" \
  && gq commit -qm r2 && gq tag 1.0.1 \
  && echo three > core && git add core && gq commit -qm r3 && gq tag 1.0.2 )   # r3 keeps the same pins
git init -q "$TMP/mono" && ( cd "$TMP/mono" && echo r > README.md && git add . && gq commit -qm init \
  && gq subtree add --prefix=chrome_plugin "file://$TMP/ubo" 1.0.0 --squash -q \
  && git rm -q --cached "chrome_plugin/$CMP" "chrome_plugin/$S14" chrome_plugin/publish-extension && rmdir "chrome_plugin/$CMP" "chrome_plugin/$S14" chrome_plugin/publish-extension && gq commit -qm drop \
  && gq subtree add --prefix="chrome_plugin/$CMP" "file://$TMP/sub-cm" "$CM1" --squash -q \
  && gq subtree add --prefix="chrome_plugin/$S14" "file://$TMP/sub-s14" "$S1" --squash -q )
cp -R "$TMP/mono" "$TMP/mono-conflict"
sync_in() { # <repo> <tag> ; output in $TMP/sync.out
  ( cd "$1" && GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t \
    MIRROR_UBO_URL="file://$TMP/ubo" MIRROR_CODEMIRROR_URL="file://$TMP/sub-cm" MIRROR_S14E_URL="file://$TMP/sub-s14" \
    "$ROOT/scripts/upstream_sync.sh" pull "$2" >"$TMP/sync.out" 2>&1 )
}
# dirty tree is refused, nothing changes
echo dirty > "$TMP/mono/chrome_plugin/core"
sync_in "$TMP/mono" 1.0.1 && bad "sync refuses a dirty tree" || { grep -q "not clean" "$TMP/sync.out" && ok "sync refuses a dirty tree" || bad "sync refuses a dirty tree" "$(cat "$TMP/sync.out")"; }
git -C "$TMP/mono" checkout -q -- chrome_plugin/core

sync_in "$TMP/mono" 1.0.1 || { echo "--- sync output"; cat "$TMP/sync.out"; }
m="$TMP/mono/chrome_plugin"
[ "$(cat $m/core 2>/dev/null)" = two ] && ok "root subtree moved to 1.0.1" || bad "root subtree moved to 1.0.1"
[ "$(cat $m/$CMP/f 2>/dev/null)" = cm-two ] && ok "codemirror subtree moved to its own pinned sha" || bad "codemirror subtree moved to its own pinned sha"
[ "$(cat $m/$S14/f 2>/dev/null)" = s14-two ] && [ "$(cat $m/$S14/g 2>/dev/null)" = extra ] && ok "s14e subtree moved to its own pinned sha" || bad "s14e subtree moved to its own pinned sha"
[ ! -e "$m/publish-extension" ] && ok "publish-extension not carried" || bad "publish-extension not carried"
[ "$(git -C $TMP/mono ls-files -s | grep -c '^160000')" = 0 ] && ok "no gitlinks after pull" || bad "no gitlinks after pull"
[ -z "$(git -C $TMP/mono status --porcelain)" ] && ok "tree clean after pull" || bad "tree clean after pull"

# unchanged pins: submodules are a no-op, root still moves
BEFORE="$(git -C "$TMP/mono" rev-parse HEAD)"
sync_in "$TMP/mono" 1.0.2 || { echo "--- sync output"; cat "$TMP/sync.out"; }
grep -q "codemirror already at $CM2" "$TMP/sync.out" && grep -q "s14e already at $S2" "$TMP/sync.out" && ok "unchanged pins are reported as a no-op" || bad "unchanged pins are reported as a no-op" "$(cat "$TMP/sync.out")"
[ "$(cat $m/core)" = three ] && ok "root still moved when submodule pins are unchanged" || bad "root still moved when submodule pins are unchanged"
[ "$(git -C "$TMP/mono" log --oneline "$BEFORE"..HEAD | grep -c 'move .* subtree')" = 0 ] && ok "no submodule pull commits for unchanged pins" || bad "no submodule pull commits for unchanged pins"

# a real (non-gitlink) conflict stops the sync and names the path
( cd "$TMP/mono-conflict" && echo local-change > chrome_plugin/core && gq commit -qam "local fork patch" )
sync_in "$TMP/mono-conflict" 1.0.1 && bad "sync stops on a non-gitlink conflict" || { grep -q "unresolved conflict outside the submodule gitlinks: chrome_plugin/core" "$TMP/sync.out" && ok "sync stops on a non-gitlink conflict" || bad "sync stops on a non-gitlink conflict" "$(cat "$TMP/sync.out")"; }
git -C "$TMP/mono-conflict" merge --abort 2>/dev/null

echo "== ThankMu layer: brand config, patch step, package checks =="
FX="$ROOT/tests/fixtures"; PY="$(command -v python3)"
mkdir -p "$TMP/rsvgbin" "$TMP/emptybin"
printf '#!/bin/sh\necho "$*" >> "${RSVG_LOG:-/dev/null}"\nwhile [ $# -gt 0 ]; do case "$1" in -o) o="$2"; shift 2;; --stylesheet) echo "$(basename "$o") $(cat "$2")" >> "${RSVG_LOG:-/dev/null}.css"; shift 2;; *) shift;; esac; done\nprintf PNGSTUB > "$o"\n' > "$TMP/rsvgbin/rsvg-convert"
chmod +x "$TMP/rsvgbin/rsvg-convert"
patch_cmd() { # <pkgdir> [brand] [patch] [target] [targets] : runs the patch step with the stub rasterizer
  env PATH="$TMP/rsvgbin:$PATH" RSVG_LOG="$TMP/rsvg.log" "$PY" -I "$ROOT/thankmu/patch_extension.py" packageDir="$1" brand="${2:-$FX/thankmu/brand.json}" patch="${3:-$FX/thankmu/patch.json}" target="${4:-dev}" targets="${5:-$FX/thankmu/targets.json}"
}
fresh() { rm -rf "$TMP/$1"; cp -R "${2:-$FX/pkg}" "$TMP/$1"; }   # fresh <name> [src] -> $TMP/<name>
pyedit() { "$PY" -I - "$@" <<'PYE'
import sys
f, old, new = sys.argv[1:4]
t = open(f, encoding="utf8").read()
assert old in t, f"fixture edit: {old!r} not in {f}"
open(f, "w", encoding="utf8").write(t.replace(old, new, 1))
PYE
}
chk_brand() { "$PY" -I "$ROOT/scripts/check_package_brand.py" "$1" brand="$FX/thankmu/brand.json" patch="${2:-$FX/thankmu/patch.json}" targets="${3:-$FX/thankmu/targets.json}" "${@:4}"; }
chk_block() { "$PY" -I "$ROOT/scripts/check_blocking_unchanged.py" "$1" "$2" brand="$FX/thankmu/brand.json" patch="$FX/thankmu/patch.json" targets="$FX/thankmu/targets.json" "${@:3}"; }

# real config is well formed (placeholders known, counts present, brand complete)
"$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config >/dev/null 2>&1 && ok "real brand.json and patch.json validate" || bad "real brand.json and patch.json validate"
expect_fail "missing brand config fails loudly" "brand config missing" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config brand="$TMP/nope.json"
for k in name short_name description author homepage_url support_url privacy_url icon_source package_name credit license_notice license_link_text source_offer source_offer_dev modification_notice; do
  "$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); del d[sys.argv[3]]; json.dump(d,open(sys.argv[2],"w"))' "$ROOT/thankmu/brand.json" "$TMP/brand-no-$k.json" "$k"
  expect_fail "brand config without $k fails loudly" "incomplete: '$k'" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config brand="$TMP/brand-no-$k.json"
done
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["name"]="  "; json.dump(d,open(sys.argv[2],"w"))' "$ROOT/thankmu/brand.json" "$TMP/brand-blank.json"
expect_fail "blank brand value fails loudly" "incomplete: 'name'" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config brand="$TMP/brand-blank.json"
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["support_url"]="http://x.test"; json.dump(d,open(sys.argv[2],"w"))' "$ROOT/thankmu/brand.json" "$TMP/brand-http.json"
expect_fail "non-https brand URL fails loudly" "https://" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config brand="$TMP/brand-http.json"
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["description"]="x"*133; json.dump(d,open(sys.argv[2],"w"))' "$ROOT/thankmu/brand.json" "$TMP/brand-long.json"
expect_fail "over-long description fails loudly" "limit 132" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config brand="$TMP/brand-long.json"
echo '{not json' > "$TMP/brand-bad.json"
expect_fail "malformed brand config fails loudly" "not valid JSON" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config brand="$TMP/brand-bad.json"
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); del d["edits"]; json.dump(d,open(sys.argv[2],"w"))' "$ROOT/thankmu/patch.json" "$TMP/patch-incomplete.json"
expect_fail "incomplete patch config fails loudly" "incomplete: 'edits'" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config patch="$TMP/patch-incomplete.json"
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["locale_key_overrides"]["*"]["extName"]="{nme}"; json.dump(d,open(sys.argv[2],"w"))' "$ROOT/thankmu/patch.json" "$TMP/patch-ph.json"
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["ruleset_details"]["homeurl_on_mark"]="keep"; json.dump(d,open(sys.argv[2],"w"))' "$ROOT/thankmu/patch.json" "$TMP/patch-hu.json"
expect_fail "bad homeurl_on_mark fails loudly" "homeurl_on_mark" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config patch="$TMP/patch-hu.json"
# the release artifact glob in CI must follow brand.json package_name, else a tag release ships no artifact and the job still passes
"$PY" -I - "$ROOT/.gitlab-ci.yml" "$ROOT/thankmu/brand.json" <<'PYE' && ok "CI release artifact glob matches brand.json package_name" || bad "CI release artifact glob matches brand.json package_name"
import json, re, sys
ci = open(sys.argv[1]).read()
pkg = json.load(open(sys.argv[2]))["package_name"]
want = f"chrome_plugin/dist/build/{pkg}_*.zip"
rel = ci[ci.index("release_chrome:"):]
rel = rel[:rel.index("refresh_mirrors:")] if "refresh_mirrors:" in rel else rel
assert want in rel, f"release_chrome artifacts do not list {want}"
assert "uBOLite_" not in rel, "release_chrome still lists the unpatched upstream zip"
PYE
expect_fail "unknown placeholder in patch config fails loudly" "unknown placeholder {nme}" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config patch="$TMP/patch-ph.json"
fresh pn; expect_fail "patch step without brand config fails loudly" "brand config missing" -- patch_cmd "$TMP/pn" "$TMP/nope.json"
expect_fail "patch step without packageDir fails" "usage" -- "$PY" -I "$ROOT/thankmu/patch_extension.py"
fresh pn; expect_fail "patch step without rsvg-convert fails loudly" "rsvg-convert not found" -- env PATH="$TMP/emptybin" "$PY" -I "$ROOT/thankmu/patch_extension.py" packageDir="$TMP/pn" brand="$FX/thankmu/brand.json" patch="$FX/thankmu/patch.json" targets="$FX/thankmu/targets.json" target=dev

# patch the fixture package; assert the rebrand, then the two package checks
: > "$TMP/rsvg.log"; fresh px
patch_cmd "$TMP/px" >/dev/null 2>"$TMP/patch.err" && ok "patch step runs on the fixture package" || bad "patch step runs on the fixture package" "$(cat "$TMP/patch.err")"
"$PY" -I - "$TMP/px" <<'PYE' && ok "rebrand: manifest, locales, html, links, credit, ruleset names" || bad "rebrand: manifest, locales, html, links, credit, ruleset names"
import json, sys, os
p = sys.argv[1]
m = json.load(open(f"{p}/manifest.json"))
assert m["short_name"] == "ThankMu" and m["author"] == "ThankMu" and m["homepage_url"] == "https://thankmu.com", m
for loc in ("en", "pl"):
    d = json.load(open(f"{p}/_locales/{loc}/messages.json"))
    assert d["extName"]["message"] == "ThankMu", d["extName"]
    assert d["extShortDesc"]["message"].startswith("Blocks ads for free"), d["extShortDesc"]
    assert d["strictblockSentence1"]["message"].startswith("ThankMu "), d["strictblockSentence1"]
    assert 'data-url="https://thankmu.com/support"' in d["supportS3P1"]["message"] and "GitHub" not in d["supportS3P1"]["message"], d["supportS3P1"]
    assert "ThankMu support" in d["supportS3P1"]["message"] and "uBlock" not in d["supportS3P1"]["message"], d["supportS3P1"]
    assert d["supportS3P1"]["description"] == "d", "descriptions are dev notes and stay"
h = open(f"{p}/dashboard.html", encoding="utf8").read()
assert h.count("ThankMu is based on uBlock Origin Lite by Raymond Hill and contributors, under GPLv3.") == 1
assert 'href="https://thankmu.com/privacy" data-i18n="aboutPrivacyPolicy"' in h
assert "aboutCode" not in h and "aboutSourceCode" not in h and "aboutContributors" not in h, "removed rows remain"
assert 'src="img/thankmu.svg" alt="ThankMu"' in h and "<title>ThankMu — Dashboard</title>" in h
assert 'id="ubol-body"' in h and "uBlock Origin Lite - a comprehensive" in h, "ids and legal comment must stay"
z = open(f"{p}/zapper-ui.html", encoding="utf8").read()
assert 'id="ubol-zapper"' in z and 'id="uBO-popup-panel"' in z and "<title>ThankMu Zapper</title>" in z
rd = json.load(open(f"{p}/rulesets/ruleset-details.json"))
assert rd[0]["id"] == "ublock-filters" and rd[0]["name"] == "Core filters – Ads" and "homeURL" not in rd[0], rd[0]
assert rd[1]["homeURL"] == "https://easylist.to/", "third-party home pages without upstream marks stay"
assert "my-thankmu-settings.json" in open(f"{p}/js/settings.js").read()
r = open(f"{p}/js/report.js").read()
assert r.count("https://thankmu.com/support") == 2 and "uBlockOrigin" not in r
assert not os.path.exists(f"{p}/img/ublock.svg") and os.path.exists(f"{p}/img/thankmu.svg")
assert not os.path.exists(f"{p}/README.md") and not os.path.exists(f"{p}/lib/codemirror/README.md")
assert h.count("Filter lists maintained by the uAssets volunteers and the listed third-party maintainers.") == 1, "lists credit"
assert rd[2]["id"] == "est-0" and rd[2]["homeURL"] == "https://example.invalid/sander85/uBO-et", "third-party maintainer link must stay"
assert [e["id"] for e in rd] == ["ublock-filters", "easylist", "est-0"], "internal ruleset ids must not change"
assert "ublock-filters" in open(f"{p}/manifest.json").read(), "manifest ruleset ids stay"
ts = open(f"{p}/js/troubleshooting.js").read()
assert '{"ublock-filters": "core-filters"}' in ts and "enabledRulesets.sort()" not in ts, ts
ed = open(f"{p}/js/ro-dnr-editor.js").read()
assert '${({"ublock-filters": "core-filters"})[this.id] ?? this.id}-dnr-ruleset.json' in ed and "${this.id}-dnr" not in ed, ed
PYE
[ "$(grep -c -- '-w 16 -h 16' "$TMP/rsvg.log")" = 2 ] && grep -q -- '-w 512 -h 512' "$TMP/rsvg.log" && ok "every upstream icon size regenerated (16, 16_off, 512) from the one SVG" || bad "every upstream icon size regenerated" "$(cat "$TMP/rsvg.log")"
[ "$(grep -c -- '--stylesheet' "$TMP/rsvg.log")" = 1 ] && grep -- 'icon_16_off.png' "$TMP/rsvg.log" | grep -q -- '--stylesheet' && ok "only the off state gets the off stylesheet" || bad "only the off state gets the off stylesheet"
grep -q -- "thankmu/icon.svg" "$TMP/rsvg.log" && ok "icons rasterize from brand.json icon_source" || bad "icons rasterize from brand.json icon_source"
[ "$(wc -c < "$TMP/px/img/icon_512.png" | tr -d ' ')" -gt 1 ] && ok "icon PNGs replaced" || bad "icon PNGs replaced"
chk_brand "$TMP/px" >/dev/null 2>"$TMP/e" && ok "brand scan passes on the patched fixture" || bad "brand scan passes on the patched fixture" "$(cat "$TMP/e")"
chk_block "$FX/pkg" "$TMP/px" >/dev/null 2>"$TMP/e" && ok "blocking-unchanged passes on the patched fixture" || bad "blocking-unchanged passes on the patched fixture" "$(cat "$TMP/e")"
chk_brand "$FX/pkg" >/dev/null 2>&1 && bad "brand scan fails on an UNPATCHED package" || ok "brand scan fails on an UNPATCHED package"

# drift: an upstream string/file that the config no longer matches must fail the build
fresh pd; pyedit "$TMP/pd/dashboard.html" 'data-i18n="aboutCode"' 'data-i18n="aboutCodeX"'
expect_fail "patch fails when a configured link vanishes upstream" "matched 0 anchors" -- patch_cmd "$TMP/pd"
fresh pd; pyedit "$TMP/pd/js/settings.js" "my-ubol-settings.json" "my-other.json"
expect_fail "patch fails when a configured edit no longer matches" "matched 0 time" -- patch_cmd "$TMP/pd"
fresh pd; rm "$TMP/pd/js/report.js"
expect_fail "patch fails when an expected file is gone" "expected file missing" -- patch_cmd "$TMP/pd"
fresh pd; mkdir "$TMP/pd/_locales/xx"
expect_fail "patch fails on a locale directory without messages.json" "_locales/xx: messages.json is missing" -- patch_cmd "$TMP/pd"
fresh pd; printf 'x' > "$TMP/pd/img/mystery.png"
expect_fail "patch fails on an icon-like PNG it does not know" "does not know" -- patch_cmd "$TMP/pd"
fresh pd; pyedit "$TMP/pd/rulesets/ruleset-details.json" '"id":"easylist"' '"id":"easylist2"'; "$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["ruleset_details"]["name_overrides"]["gone"]="x"; json.dump(d,open(sys.argv[2],"w"))' "$FX/thankmu/patch.json" "$TMP/patch-gone.json"
expect_fail "patch fails on a name override for a vanished ruleset" "unknown rulesets" -- patch_cmd "$TMP/pd" "$FX/thankmu/brand.json" "$TMP/patch-gone.json"

fresh pd; pyedit "$TMP/pd/js/troubleshooting.js" "enabledRulesets.sort()" "enabledRulesets.slice()"
expect_fail "patch fails when the troubleshooting line vanishes upstream" "matched 0 time" -- patch_cmd "$TMP/pd"
fresh pd; pyedit "$TMP/pd/js/ro-dnr-editor.js" '${this.id}-dnr-ruleset.json' '${this.name}-dnr-ruleset.json'
expect_fail "patch fails when the export file name line changes upstream" "matched 0 time" -- patch_cmd "$TMP/pd"
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["ruleset_display_ids"]["gone-0"]="gone-x"; json.dump(d,open(sys.argv[2],"w"))' "$FX/thankmu/patch.json" "$TMP/patch-dgone.json"
fresh pd; expect_fail "patch fails on a display id for a vanished ruleset" "ruleset_display_ids for unknown rulesets" -- patch_cmd "$TMP/pd" "$FX/thankmu/brand.json" "$TMP/patch-dgone.json"
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["ruleset_display_ids"]["ublock-filters"]="easylist"; json.dump(d,open(sys.argv[2],"w"))' "$FX/thankmu/patch.json" "$TMP/patch-dclash.json"
fresh pd; expect_fail "patch fails when a display id collides with a real ruleset id" "collides" -- patch_cmd "$TMP/pd" "$FX/thankmu/brand.json" "$TMP/patch-dclash.json"
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["ruleset_display_ids"]["ublock-filters"]="Bad Id"; json.dump(d,open(sys.argv[2],"w"))' "$ROOT/thankmu/patch.json" "$TMP/patch-dbad.json"
expect_fail "display id must be a plain lower-case token" "ruleset_display_ids" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config patch="$TMP/patch-dbad.json"
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); del d["ruleset_display_ids"]; json.dump(d,open(sys.argv[2],"w"))' "$ROOT/thankmu/patch.json" "$TMP/patch-dnone.json"
expect_fail "patch config without ruleset_display_ids fails loudly" "incomplete: 'ruleset_display_ids'" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config patch="$TMP/patch-dnone.json"
# the real url_pattern hides only upstream uBO's own sites and repos (the host is irrelevant: data, not a literal)
"$PY" -I - "$ROOT/thankmu/patch.json" <<'PYE' && ok "url_pattern: upstream links match, third-party maintainer links do not" || bad "url_pattern: upstream links match, third-party maintainer links do not"
import json, re, sys
rx = re.compile(json.load(open(sys.argv[1]))["url_pattern"], re.I)
hide = ["https://h.test/uBlockOrigin/uAssets", "https://h.test/uBlockOrigin/uAssets/issues?q=is%3Aissue", "https://h.test/gorhill/uBlock/wiki/X",
        "https://h.test/uBlockOrigin/uBOL-home/wiki", "https://ublockorigin.github.io/uBOL-home/tests/test-filters.html",
        "https://ublockorigin.github.io/uAssets/filters/filters.min.txt", "https://www.reddit.com/r/uBlockOrigin/comments/x/y",
        "https://crowdin.com/project/ublock", "https://h.test/chrisaljoudi/uBlock/issues/1001", "https://ublockorigin.com/"]
keep = ["https://h.test/sander85/uBO-et", "https://ubo-et.lepik.io/list.txt", "https://easylist.to/", "https://h.test/AdguardTeam/AdguardFilters",
        "https://h.test/gorhillx/other", "https://h.test/rsms/inter", "https://forums.lanik.us/viewforum.php?f=90"]
for u in hide:
    m = rx.search(u); assert m and m.group(0) == u, f"should hide fully: {u} -> {m and m.group(0)}"
for u in keep:
    assert not rx.search(u), f"should stay visible: {u}"
m = rx.search('see "https://h.test/gorhill/uBlock/wiki/X" now'); assert m.group(0) == "https://h.test/gorhill/uBlock/wiki/X"
PYE

# the scan catches a leak in every surface it claims to cover
leak() { # <name> <file> <old> <new> <expected-substring>
  fresh pm "$TMP/px"; pyedit "$TMP/pm/$2" "$3" "$4"
  expect_fail "brand scan catches: $1" "$5" -- chk_brand "$TMP/pm"
}
leak "manifest short_name" manifest.json '"short_name": "ThankMu"' '"short_name": "uBO Lite"' "short_name"
leak "locale message" _locales/pl/messages.json 'Polityka prywatności' 'Polityka uBlock' "_locales/pl"
leak "locale extName" _locales/en/messages.json '"extName": {
    "message": "ThankMu"' '"extName": {
    "message": "ThankMu uBO"' "extName"
leak "html visible text" zapper-ui.html '>Zapper</aside>' '>uBOL Zapper</aside>' "zapper-ui.html"
leak "html alt text" dashboard.html 'alt="ThankMu"' 'alt="uBlock"' "<img alt>"
leak "html link to upstream" dashboard.html 'https://thankmu.com/privacy' 'https://example.invalid/uBlockOrigin/wiki' "dashboard.html"
leak "ruleset display name" rulesets/ruleset-details.json 'Core filters – Ads' 'uBlock filters – Ads' "ruleset-details.json"
leak "ruleset home url" rulesets/ruleset-details.json '"homeURL": "https://easylist.to/"' '"homeURL": "https://example.invalid/gorhill/x"' "homeURL"
leak "a mangled substitution" _locales/en/messages.json 'Privacy policy' 'ThankMuOrigin/uAssets' "_locales/en"
leak "a link in a data- attribute" dashboard.html 'target="_blank">Inter' 'target="_blank" data-url="https://example.com/ublock">Inter' "data-url> URL"
leak "mark in a form value" dashboard.html 'target="_blank">Inter' 'target="_blank" value="uBO">Inter' "<a value>"
leak "css content string" css/zapper-ui.css 'content: "x"' 'content: "uBO"' "css content"
leak "JS upstream URL" js/report.js 'https://thankmu.com/support' 'https://example.com/uBlockOrigin/uAssets' "URL in JS string"
leak "JS download file name" js/settings.js 'my-thankmu-settings.json' 'my-ubol-settings.json' "download file name"
leak "credit line duplicated" _locales/en/messages.json 'Privacy policy' 'ThankMu is based on uBlock Origin Lite by Raymond Hill and contributors, under GPLv3.' "_locales/en"
leak "lists credit removed" dashboard.html 'Filter lists maintained by the uAssets volunteers and the listed third-party maintainers.' 'x' "lists credit line must appear exactly once"
leak "ruleset id shown raw in the troubleshooting text" js/troubleshooting.js 'enabledRulesets.map(s => s.replace(/[^+-].*$/, id => ({"ublock-filters": "core-filters"})[id] ?? id)).sort()' 'enabledRulesets.sort()' "js/troubleshooting.js"
leak "ruleset id in the export file name" js/ro-dnr-editor.js '${({"ublock-filters": "core-filters"})[this.id] ?? this.id}-dnr' '${this.id}-dnr' "download file name"
leak "display id carrying a mark" js/ro-dnr-editor.js '"core-filters"' '"ubo-filters"' "display"
leak "third-party URL with a mark that is not allow-listed" rulesets/ruleset-details.json 'https://example.invalid/sander85/uBO-et' 'https://example.invalid/someone/uBO-other' "homeURL"
leak "credit line removed" dashboard.html 'ThankMu is based on uBlock Origin Lite by Raymond Hill and contributors, under GPLv3.' 'ThankMu' "exactly once"
leak "upstream store id" _locales/en/messages.json 'Privacy policy' 'ddkjiahejlhfcafbddmgiahcphecmpfh' "_locales/en"
leak "locale placeholder content" _locales/en/messages.json '"message": "Privacy policy"' '"message": "Privacy $X$", "placeholders": {"x": {"content": "uBlock"}}' "placeholders.x"
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["ruleset_display_ids"]={"ublock-other":"core-other"}; json.dump(d,open(sys.argv[2],"w"))' "$FX/thankmu/patch.json" "$TMP/patch-nomap.json"
fresh pm "$TMP/px"; expect_fail "brand scan catches a ruleset id with no display remap" "ruleset id 'ublock-filters'" -- chk_brand "$TMP/pm" "$TMP/patch-nomap.json"
# the scan validates brand.json with the same required-key set as the patch step (one source)
for k in author homepage_url privacy_url icon_source package_name lists_credit; do
  "$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); del d[sys.argv[3]]; json.dump(d,open(sys.argv[2],"w"))' "$FX/thankmu/brand.json" "$TMP/sb-$k.json" "$k"
  expect_fail "brand scan rejects a brand config without $k" "incomplete: '$k'" -- "$PY" -I "$ROOT/scripts/check_package_brand.py" "$TMP/px" brand="$TMP/sb-$k.json"
done
fresh pm "$TMP/px"; printf 'x' > "$TMP/pm/img/ublock-logo.png"
expect_fail "brand scan catches a mark in an image file name" "file name" -- chk_brand "$TMP/pm"
fresh pm "$TMP/px"; printf 'x' > "$TMP/pm/surprise.bin"
expect_fail "brand scan flags an unclassified file type" "unclassified file type" -- chk_brand "$TMP/pm"
# ...and leaves the documented non-visible surfaces alone (ids, classes, identifiers, legal headers, ruleset ids, log)
fresh pm "$TMP/px"; chk_brand "$TMP/pm" >/dev/null 2>&1 && grep -q 'ubolLog' "$TMP/pm/js/background.js" && grep -q 'id="ubol-body"' "$TMP/pm/dashboard.html" && grep -q ublock-filters "$TMP/pm/manifest.json" && ok "scan boundary: ids, JS identifiers, legal headers, DNR ids and log.txt are not flagged" || bad "scan boundary: ids, JS identifiers, legal headers, DNR ids and log.txt are not flagged"
expect_fail "brand scan without a brand config fails loudly" "brand config missing" -- "$PY" -I "$ROOT/scripts/check_package_brand.py" "$TMP/px" brand="$TMP/nope.json"

# blocking-unchanged catches any change to what blocks
bl() { # <name> <file> <old> <new> <expected>
  fresh pm "$TMP/px"; pyedit "$TMP/pm/$2" "$3" "$4"
  expect_fail "blocking check catches: $1" "$5" -- chk_block "$FX/pkg" "$TMP/pm"
}
bl "a changed DNR rule" rulesets/main/ublock-filters.json '"block"' '"allow"' "rulesets/main/ublock-filters.json"
bl "a changed filtering JS file" js/background.js 'uBOL_start();' 'uBOL_start(); evil();' "js/background.js"
bl "an extra change beyond the configured edit in JS" js/settings.js 'my-thankmu-settings.json' 'my-thankmu-settings.json'"'"'+1'"'" "more than the configured edits"
bl "an extra change beyond the configured edit in the troubleshooting JS" js/troubleshooting.js 'return config;' 'return config; // x' "more than the configured edits"
bl "an extra change beyond the configured edit in the export JS" js/ro-dnr-editor.js 'class Ed' 'class Ed2' "more than the configured edits"
bl "a ruleset-details field other than name/homeURL" rulesets/ruleset-details.json '"total": 1' '"total": 0' "changed beyond name/homeURL"
bl "an added script tag in HTML" zapper-ui.html '<aside' '<script src="evil.js"></script><aside' "differs from upstream plus the configured HTML changes"
bl "a changed CSS file" css/zapper-ui.css 'color: red' 'color: blue' "css/zapper-ui.css"
bl "a changed manifest permission" manifest.json '"manifest_version": 3' '"manifest_version": 3, "permissions": ["tabs"]' "manifest.json"
bl "a message with a changed placeholder" _locales/en/messages.json '"description": "uBO store text"' '"description": "other"' "changed beyond its message"
fresh pm "$TMP/px"; rm "$TMP/pm/rulesets/main/ublock-filters.json"
expect_fail "blocking check catches a deleted ruleset" "removed files differ" -- chk_block "$FX/pkg" "$TMP/pm"
fresh pm "$TMP/px"; printf 'x' > "$TMP/pm/js/extra.js"
expect_fail "blocking check catches an added file" "added files differ" -- chk_block "$FX/pkg" "$TMP/pm"
expect_fail "blocking check without a baseline fails" "usage" -- "$PY" -I "$ROOT/scripts/check_blocking_unchanged.py" "$TMP/px"

echo "== ThankMu layer (W-P3 part B): pairing JS logic =="
# node is not on the CI shell runner; the pinned node image is (docker). build_chrome.sh runs these too.
js_tests=(); while IFS= read -r f; do js_tests+=("$f"); done < <(cd "$ROOT" && find thankmu -name '*.test.mjs' | sort)
if [ "${#js_tests[@]}" = 0 ]; then bad "ThankMu JS tests exist"
elif command -v node >/dev/null; then
  ( cd "$ROOT" && node --test "${js_tests[@]}" ) >"$TMP/js.out" 2>&1 && ok "ThankMu JS tests pass (local node $(node -v)): $(grep -E '^# pass|^ℹ pass' "$TMP/js.out" | tr -d '#ℹ')" || bad "ThankMu JS tests pass" "$(tail -30 "$TMP/js.out")"
elif command -v docker >/dev/null; then
  NODE_IMG="node:$(tr -d '[:space:]v' < "$ROOT/.nvmrc")-bookworm"
  docker run --rm -v "$ROOT/thankmu:/w/thankmu:ro" -w /w "$NODE_IMG" node --test "${js_tests[@]}" >"$TMP/js.out" 2>&1 && ok "ThankMu JS tests pass (docker $NODE_IMG): $(grep -E '^# pass|^ℹ pass' "$TMP/js.out" | tr -d '#ℹ')" || bad "ThankMu JS tests pass (docker)" "$(tail -30 "$TMP/js.out")"
else
  bad "ThankMu JS tests pass" "neither node nor docker is available to run them"
fi

echo "== ThankMu layer (W-P3 part B): build targets, manifest, injected files =="
tq() { # <src targets.json> <dst> <python expr on d>: write a modified targets config
  "$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); exec(sys.argv[3]); json.dump(d,open(sys.argv[2],"w"))' "$1" "$2" "$3"
}
chk_cfg() { "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config targets="$1" "${@:2}"; }
RT="$ROOT/thankmu/targets.json"
tq "$RT" "$TMP/t-nodev.json" 'del d["dev"]';                                expect_fail "targets without dev fail loudly" "target 'dev' is missing" -- chk_cfg "$TMP/t-nodev.json"
tq "$RT" "$TMP/t-nostore.json" 'del d["store"]';                            expect_fail "targets without store fail loudly" "target 'store' is missing" -- chk_cfg "$TMP/t-nostore.json"
tq "$RT" "$TMP/t-noorigin.json" 'del d["store"]["app_origin"]';             expect_fail "missing APP_ORIGIN fails loudly" "'store'.app_origin is missing" -- chk_cfg "$TMP/t-noorigin.json"
tq "$RT" "$TMP/t-empty.json" 'd["dev"]["app_origin"]=""';                   expect_fail "empty APP_ORIGIN fails loudly" "'dev'.app_origin is missing" -- chk_cfg "$TMP/t-empty.json"
tq "$RT" "$TMP/t-http.json" 'd["store"]["app_origin"]="http://app.example.invalid"';   expect_fail "http APP_ORIGIN fails loudly" "bare https origin" -- chk_cfg "$TMP/t-http.json"
tq "$RT" "$TMP/t-path.json" 'd["store"]["app_origin"]="https://app.example.invalid/x"'; expect_fail "APP_ORIGIN with a path fails loudly" "bare https origin" -- chk_cfg "$TMP/t-path.json"
tq "$RT" "$TMP/t-slash.json" 'd["dev"]["app_origin"]="https://app.example.invalid/"';  expect_fail "APP_ORIGIN with a trailing slash fails loudly" "bare https origin" -- chk_cfg "$TMP/t-slash.json"
tq "$RT" "$TMP/t-storekey.json" 'd["store"]["manifest_key"]=d["dev"]["manifest_key"]; d["store"]["extension_id"]=d["dev"]["extension_id"]'
expect_fail "store target carrying a manifest key fails loudly" "must not carry manifest_key" -- chk_cfg "$TMP/t-storekey.json"
tq "$RT" "$TMP/t-badid.json" 'd["dev"]["extension_id"]="a"*32';             expect_fail "extension_id that does not match the key fails loudly" "manifest_key gives" -- chk_cfg "$TMP/t-badid.json"
tq "$RT" "$TMP/t-badkey.json" 'd["dev"]["manifest_key"]="not base64!"';     expect_fail "a malformed manifest key fails loudly" "not valid base64" -- chk_cfg "$TMP/t-badkey.json"
tq "$RT" "$TMP/t-extra.json" 'd["dev"]["origin"]="x"';                      expect_fail "an unknown target key fails loudly" "unknown keys" -- chk_cfg "$TMP/t-extra.json"
fresh pt; expect_fail "patch step without target= fails loudly" "target=<alpha|dev|store> is required" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" packageDir="$TMP/pt" brand="$FX/thankmu/brand.json" patch="$FX/thankmu/patch.json" targets="$FX/thankmu/targets.json"
fresh pt; expect_fail "patch step with an unknown target fails loudly" "unknown target 'prod'" -- patch_cmd "$TMP/pt" "" "" prod
# the dev extension id the app allow-lists (PLUGIN_EXTENSION_IDS) is the one the committed key derives, and the docs say so
"$PY" -I - "$ROOT" <<'PYE' && ok "dev extension id derives from targets.json dev.manifest_key and is the one docs/rebrand.md names" || bad "dev extension id derives from the key and is documented"
import base64, hashlib, json, re, sys
root = sys.argv[1]
t = json.load(open(f"{root}/thankmu/targets.json"))
der = base64.b64decode(t["dev"]["manifest_key"], validate=True)
eid = "".join(chr(ord("a") + int(c, 16)) for c in hashlib.sha256(der).hexdigest()[:32])
assert re.fullmatch(r"[a-p]{32}", eid) and eid == t["dev"]["extension_id"], (eid, t["dev"]["extension_id"])
assert eid in open(f"{root}/docs/rebrand.md").read(), f"docs/rebrand.md does not name the dev extension id {eid}"
assert "manifest_key" not in t["store"], "the store build must not carry a key"
assert t["dev"]["app_origin"] != t["store"]["app_origin"]
PYE
# no private key is ever committed
pk="$(git -C "$ROOT" ls-files -z | xargs -0 grep -l -e 'PRIVATE KEY' -- 2>/dev/null | grep -v '^tests/run.sh$' || true)"
[ -z "$pk" ] && ok "no private key in the repo" || bad "no private key in the repo" "$pk"

fresh pdev; patch_cmd "$TMP/pdev" "" "" dev >"$TMP/pdev.out" 2>&1 && ok "patch step runs for target dev" || bad "patch step runs for target dev" "$(cat "$TMP/pdev.out")"
fresh pstore; patch_cmd "$TMP/pstore" "" "" store >"$TMP/pstore.out" 2>&1 && ok "patch step runs for target store" || bad "patch step runs for target store" "$(cat "$TMP/pstore.out")"
grep -q "extension id eflkimobbajiadiplpcnjibpodgbblnb" "$TMP/pdev.out" && grep -q "no manifest key" "$TMP/pstore.out" && ok "patch step reports the target, origin and dev id" || bad "patch step reports the target, origin and dev id" "$(cat "$TMP/pdev.out" "$TMP/pstore.out")"

# The alpha target: the public pre-alpha, released beside the store zip but installed from a file.
# It is the one package that both points at production AND pins its own id, which is the whole reason
# it exists -- the app issues a pairing token only to a listed id, and a keyless zip has no stable one.
"$PY" -I - "$ROOT" <<'PYE' && ok "alpha target: own pinned id, production origin, the store's source offer, its own name" || bad "alpha target is configured as the public pre-alpha"
import base64, hashlib, json, re, sys
root = sys.argv[1]
t = json.load(open(f"{root}/thankmu/targets.json"))
a, s, d = t["alpha"], t["store"], t["dev"]
der = base64.b64decode(a["manifest_key"], validate=True)
eid = "".join(chr(ord("a") + int(c, 16)) for c in hashlib.sha256(der).hexdigest()[:32])
assert re.fullmatch(r"[a-p]{32}", eid) and eid == a["extension_id"], (eid, a["extension_id"])
assert a["extension_id"] != d["extension_id"], "the alpha build must not reuse the dev id"
assert a["app_origin"] == s["app_origin"], (a["app_origin"], s["app_origin"])   # it pairs with production
assert a["source_url"] == s["source_url"]                                       # one publication, both offers
brand = json.load(open(f"{root}/thankmu/brand.json"))
assert a["brand"]["name"] != brand["name"] and a["brand"]["short_name"] != brand["short_name"], a["brand"]
PYE
# Whatever RELEASE_TARGETS names, the real config has to define: a tag builds every one of them, and a release
# that discovers a missing target has already spent the tag.
"$PY" -I - "$ROOT" <<'PYE' && ok "the real config defines every release target" || bad "the real config defines every release target"
import importlib.util, json, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("p", f"{sys.argv[1]}/thankmu/patch_extension.py")
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
t = mod.load_targets(f"{sys.argv[1]}/thankmu/targets.json")
missing = [n for n in mod.RELEASE_TARGETS if n not in t]
assert not missing, f"targets.json defines no {missing}"
for n in mod.RELEASE_TARGETS:
    assert t[n].get("source_url"), f"{n} has no source_url"
PYE
tq "$RT" "$TMP/t-srcsplit.json" 'd["alpha"]["source_url"]="https://other.example.invalid/x"'
expect_fail "release targets offering different source repos fail loudly" "must all declare the same one" -- chk_cfg "$TMP/t-srcsplit.json"
tq "$RT" "$TMP/t-nosrcalpha.json" 'del d["alpha"]["source_url"]'
expect_fail "alpha target without source_url fails at config check" "must carry the GPLv3 source offer" -- chk_cfg "$TMP/t-nosrcalpha.json" target=alpha
tq "$RT" "$TMP/t-alphanokey.json" 'del d["alpha"]["manifest_key"]'
expect_fail "alpha target with an extension_id but no key fails loudly" "without manifest_key" -- chk_cfg "$TMP/t-alphanokey.json"
fresh palpha; patch_cmd "$TMP/palpha" "" "" alpha "$RT" >"$TMP/palpha.out" 2>&1 && ok "patch step runs for target alpha" || bad "patch step runs for target alpha" "$(cat "$TMP/palpha.out")"
"$PY" -I - "$TMP/palpha" "$RT" <<'PYE' && ok "alpha package carries the pinned key and the production origin" || bad "alpha package carries the pinned key and the production origin"
import json, sys
m = json.load(open(f"{sys.argv[1]}/manifest.json")); a = json.load(open(sys.argv[2]))["alpha"]
assert m["key"] == a["manifest_key"], "the alpha package must pin its id"
assert m["externally_connectable"]["matches"] == [a["app_origin"] + "/*"], m["externally_connectable"]
assert m["short_name"] == a["brand"]["short_name"], m["short_name"]
PYE
grep -q "extension id adpddphgffkgjjnibeabbamjlieaofne" "$TMP/palpha.out" && ok "patch step reports the alpha extension id" || bad "patch step reports the alpha extension id" "$(cat "$TMP/palpha.out")"
"$PY" -I - "$TMP/pdev" "$TMP/pstore" "$FX/thankmu/targets.json" "$FX/pkg" <<'PYE' && ok "dev vs store: manifest keys, externally_connectable, unchanged host permissions, key, generated APP_ORIGIN" || bad "dev vs store: manifest keys, externally_connectable, unchanged host permissions, key, generated APP_ORIGIN"
import json, os, sys
dev, store, tp, up = sys.argv[1:5]
T = json.load(open(tp))
U = json.load(open(f"{up}/manifest.json"))
for pkg, name in ((dev, "dev"), (store, "store")):
    m = json.load(open(f"{pkg}/manifest.json"))
    o = T[name]["app_origin"]
    assert m["background"] == {"service_worker": "/js/thankmu-sw.js", "type": "module"}, m["background"]
    assert m["externally_connectable"] == {"matches": [o + "/*"]}, m["externally_connectable"]
    assert m["host_permissions"] == U["host_permissions"], "host permissions stay upstream's (mode-manager derives filtering modes from them)"
    assert m.get("permissions") == U.get("permissions"), "no new permissions"
    cfg = open(f"{pkg}/js/thankmu/config.js").read()
    assert f'export const APP_ORIGIN = "{o}";' in cfg and f'export const BUILD_TARGET = "{name}";' in cfg, cfg
    other = T["store" if name == "dev" else "dev"]["app_origin"]
    for root, _, fs in os.walk(pkg):
        for f in fs:
            p = os.path.join(root, f)
            assert other not in open(p, encoding="utf8", errors="replace").read(), f"{name} package mentions the other target's origin in {p}"
d = json.load(open(f"{dev}/manifest.json")); s = json.load(open(f"{store}/manifest.json"))
assert d["key"] == T["dev"]["manifest_key"], "dev build pins its id with the public key"
assert "key" not in s, "store build must not carry key"
PYE
"$PY" -I - "$TMP/pdev" "$ROOT/thankmu/patch.json" <<'PYE' && ok "injected files: exactly layer.files + config, no tests, brand filled, popup links the account page" || bad "injected files: exactly layer.files + config, no tests, brand filled, popup links the account page"
import json, os, sys
pkg, pp = sys.argv[1:3]
lay = json.load(open(pp))["layer"]
for f in lay["files"] + [lay["config_module"]] + [cm["to"] for cm in lay["css_modules"]]:
    assert os.path.isfile(f"{pkg}/{f}"), f
for root, _, fs in os.walk(pkg):
    for f in fs:
        assert not f.endswith(".test.mjs") and f != "package.json", f"test or tooling file shipped: {f}"
h = open(f"{pkg}/thankmu-account.html", encoding="utf8").read()
assert "{name}" not in h and "<title>ThankMu account</title>" in h, h[:300]
assert '<script src="js/thankmu/account.js" type="module"></script>' in h
pop = open(f"{pkg}/popup.html", encoding="utf8").read()
# W-P6: the D2 popup replaced the old account row (its jobs moved into the account frame).
assert 'thankmuAccount' not in pop and 'thankmu-account.html' not in pop, pop
# D2 naming (E2E-02): the app hop is "Settings"; no "My account" label anywhere in the ThankMu layer.
assert '<button id="myAccount" type="button" hidden>Settings</button>' in h, "account page offers Settings"
import glob as _g
for f in _g.glob(f"{pkg}/thankmu-*.html") + _g.glob(f"{pkg}/js/thankmu/*.js") + [f"{pkg}/popup.html"]:
    assert "My account" not in open(f, encoding="utf8").read(), f"'My account' left in {f}"
w = open(f"{pkg}/js/thankmu-sw.js").read()
i, j = w.index("import './thankmu/sw.js';"), w.index("import './background.js';")
assert i < j, "the ThankMu module must load before upstream's worker (its onMessageExternal must be registered first)"
sw = open(f"{pkg}/js/thankmu/sw.js").read()
assert "onMessageExternal.addListener" in sw and "from './config.js'" in sw
# W-T1 part A: the ad-slot card's content script (top frame, http/https only) and the popup's switch (framed, no script tag).
man = json.load(open(f"{pkg}/manifest.json"))
assert man["content_scripts"] == [{"js": ["js/thankmu/tokens-css.js", "js/thankmu/adslot.js"], "matches": ["http://*/*", "https://*/*"], "run_at": "document_idle", "all_frames": False}], man.get("content_scripts")
assert "web_accessible_resources" not in man or all("thankmu" not in r for e in man["web_accessible_resources"] for r in e["resources"]), "no ThankMu file is exposed to pages"
# W-P6: two frames around upstream's controls: the head frame first in <main>, the account frame last.
head_i = pop.index('<iframe id="thankmuHead" src="thankmu-popup.html?part=head" title="ThankMu"')
acct_i = pop.index('<iframe id="thankmuPrompts" src="thankmu-popup.html" title="ThankMu account"')
main_i, main_j = pop.index("<main>"), pop.index("</main>")
# scripts/check_popup_inventory.py checks every upstream control (the "Popup (W-P6)" section below, and
# verify_chrome_package.sh on every real build).
assert main_i < head_i < pop.index('id="gotoDashboard"') < acct_i < main_j, "upstream's controls sit between the ThankMu frames"
assert pop.count("<iframe") == 2, pop
p2 = open(f"{pkg}/thankmu-popup.html", encoding="utf8").read()
assert '<script src="js/thankmu/popup.js" type="module"></script>' in p2 and "{name}" not in p2
assert "frameElement" in open(f"{pkg}/js/thankmu/popup.js").read() + open(f"{pkg}/js/thankmu/popupfit.js").read(), "the popup switch sizes its own frame"
# W-P6 compact: the hidden-on line stays one line; a long domain is cut with an ellipsis, the whole sentence is its title.
assert "#hiddenDomain { overflow: hidden; text-overflow: ellipsis;" in open(f"{pkg}/css/thankmu-popup.css").read(), "a long domain must not widen or wrap the hidden-on line"
assert "$('hidden').title = hidden ? `Hidden on ${ps.hidden} for today.`" in open(f"{pkg}/js/thankmu/popup.js").read(), "the hidden-on line's title carries the full domain"
assert "import { capHostname, startFitting, ownFrame } from './popupfit.js'" in open(f"{pkg}/js/thankmu/popup.js").read()
# W-P6: every D2 string, character for character (mockups/src/prototype/Popup.tsx).
for s in ("Ads are blocked, free. Sign in to turn on your tip jar.", ">Sign in<", ">Join free<",
          "<b>Finish in the ThankMu tab.</b> Sign in or join there, then click Connect. This popup updates when you're done.",
          ">Open the tab again<", ">Open your feed<", ">Your balance is too low to tip.<", ">Reload to keep tipping<",
          ">Your wallet<", ">Add money<", ">Tip jar<", "A like and tip card in each spot where an ad was blocked", ">Show again<",
          ">Settings<", ">Sign out<", "Ad blocking is free and always on.", ">ads blocked here<", ">likes<"):
    assert s in p2, s
pj = open(f"{pkg}/js/thankmu/popup.js").read()
assert "promotional credit" in pj and "Hidden on " in pj
assert "Help at paywalls" not in p2 + pj, "the paywall switch waits for W-T1 part B (4c)"
assert "import " not in open(f"{pkg}/js/thankmu/adslot.js").read().split("(( ) => {", 1)[1], "a manifest content script cannot import"
PYE
# the JS ThankMu ships names no host itself: APP_ORIGIN comes only from the generated config module
# The one exception is the SVG namespace name (the pill's glyph, adslot.js createElementNS): an identifier, never fetched.
hits="$(grep -rnE 'https?://' "$ROOT/thankmu/ext" --include='*.js' | grep -vE "^[^:]+/adslot\.js:[0-9]+:    const NS = 'http://www\.w3\.org/2000/svg';$" || true)"
[ -z "$hits" ] && ok "no URL literal in the ThankMu extension sources (APP_ORIGIN is build config; the SVG namespace name aside)" || bad "no URL literal in the ThankMu extension sources" "$hits"
chk_brand "$TMP/pdev" >/dev/null 2>"$TMP/e" && ok "brand scan passes on the dev package (key not scanned)" || bad "brand scan passes on the dev package" "$(cat "$TMP/e")"
chk_brand "$TMP/pstore" >/dev/null 2>"$TMP/e" && ok "brand scan passes on the store package" || bad "brand scan passes on the store package" "$(cat "$TMP/e")"
chk_block "$FX/pkg" "$TMP/pdev" target=dev >"$TMP/o" 2>"$TMP/e" && grep -q "target dev" "$TMP/o" && ok "blocking-unchanged passes on the dev package (target dev)" || bad "blocking-unchanged passes on the dev package" "$(cat "$TMP/e")"
chk_block "$FX/pkg" "$TMP/pstore" target=store >"$TMP/o" 2>"$TMP/e" && grep -q "target store" "$TMP/o" && ok "blocking-unchanged passes on the store package (target store)" || bad "blocking-unchanged passes on the store package" "$(cat "$TMP/e")"
chk_block "$FX/pkg" "$TMP/pstore" >"$TMP/o" 2>"$TMP/e" && grep -q "target store" "$TMP/o" && ok "blocking-unchanged infers the target when none is given" || bad "blocking-unchanged infers the target" "$(cat "$TMP/e")"
expect_fail "blocking check: a dev package is not a store package" "ThankMu layer for target store" -- chk_block "$FX/pkg" "$TMP/pdev" target=store
expect_fail "blocking check: a store package is not a dev package" "ThankMu layer for target dev" -- chk_block "$FX/pkg" "$TMP/pstore" target=dev
expect_fail "blocking check rejects an unknown target" "unknown target" -- chk_block "$FX/pkg" "$TMP/pstore" target=prod
lb() { # <name> <file> <old> <new> <expected> : a layer-surface change the checker must catch
  fresh pm "$TMP/pstore"; pyedit "$TMP/pm/$2" "$3" "$4"
  expect_fail "blocking check catches: $1" "$5" -- chk_block "$FX/pkg" "$TMP/pm"
}
lb "a second externally_connectable origin" manifest.json '"https://app.example.invalid/*"
    ]
  }' '"https://app.example.invalid/*", "https://evil.example.invalid/*"
    ]
  }' "manifest.json"
lb "a key in the store build" manifest.json '"manifest_version": 3' '"key": "QUJD", "manifest_version": 3' "manifest.json"
lb "an extra host permission" manifest.json '"<all_urls>"' '"<all_urls>", "https://app.example.invalid/*"' "manifest.json"
lb "a content script not in the layer config" manifest.json '"all_frames": false' '"all_frames": true' "manifest.json"
lb "an injected file that differs from its source" js/thankmu/pairing.js "export const PAIR_VERSION = 1;" "export const PAIR_VERSION = 2;" "js/thankmu/pairing.js: ThankMu layer file differs"
lb "a generated APP_ORIGIN that is not the target's" js/thankmu/config.js 'https://app.example.invalid' 'https://evil.example.invalid' "js/thankmu/config.js"
fresh pm "$TMP/pstore"; printf 'x' > "$TMP/pm/js/thankmu/extra.js"
expect_fail "blocking check catches an injected file outside layer.files" "added files differ" -- chk_block "$FX/pkg" "$TMP/pm"
# drift: upstream moves things the layer hooks into
fresh pd; pyedit "$TMP/pd/manifest.json" '"/js/background.js"' '"/js/sw.js"'
expect_fail "patch fails when upstream's service worker path changes" "background.service_worker is not" -- patch_cmd "$TMP/pd"
fresh pd; pyedit "$TMP/pd/manifest.json" '"type": "module"' '"type": "classic"'
expect_fail "patch fails when upstream's worker is no longer a module" "background.type is not 'module'" -- patch_cmd "$TMP/pd"
fresh pd; pyedit "$TMP/pd/manifest.json" '"manifest_version": 3' '"externally_connectable": {"matches": []}, "manifest_version": 3'
expect_fail "patch fails when upstream sets externally_connectable itself" "upstream now sets 'externally_connectable'" -- patch_cmd "$TMP/pd"
fresh pd; mkdir -p "$TMP/pd/js/thankmu" && printf 'x' > "$TMP/pd/js/thankmu/pairing.js"
expect_fail "patch never overwrites an existing package file" "only adds files" -- patch_cmd "$TMP/pd"
fresh pd; pyedit "$TMP/pd/popup.html" '</main>' '</div>'
expect_fail "patch fails when the popup hook point vanishes upstream" "popup.html: edit" -- patch_cmd "$TMP/pd"
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["layer"]["files"].append("js/thankmu/pairing.test.mjs"); json.dump(d,open(sys.argv[2],"w"))' "$ROOT/thankmu/patch.json" "$TMP/patch-shiptest.json"
expect_fail "a test file can never be listed for shipping" "never a test" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config patch="$TMP/patch-shiptest.json"
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["layer"]["content_scripts"][0]["all_frames"]=True; json.dump(d,open(sys.argv[2],"w"))' "$ROOT/thankmu/patch.json" "$TMP/patch-cs-frames.json"
expect_fail "the card's content script must stay top-frame only" "all_frames false" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config patch="$TMP/patch-cs-frames.json"
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["layer"]["content_scripts"][0]["js"]=["js/elsewhere.js"]; json.dump(d,open(sys.argv[2],"w"))' "$ROOT/thankmu/patch.json" "$TMP/patch-cs-file.json"
expect_fail "a content script must be a layer file" "must list files from layer.files" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config patch="$TMP/patch-cs-file.json"
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["layer"]["content_scripts"][0]["matches"]=["<all_urls>"]; json.dump(d,open(sys.argv[2],"w"))' "$ROOT/thankmu/patch.json" "$TMP/patch-cs-match.json"
expect_fail "the card's content script runs on http(s) pages only" "http(s) match patterns" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config patch="$TMP/patch-cs-match.json"
( cd "$ROOT" && "$PY" -I - ".gitlab-ci.yml" <<'PYE' ) && ok "CI verifies MR builds as target dev and release builds every release target" || bad "CI verifies MR builds as target dev and release builds every release target"
import importlib.util, sys
ci = open(sys.argv[1]).read()
mr = ci[ci.index("build_chrome_mr:"):ci.index("release_chrome:")]
rel = ci[ci.index("release_chrome:"):ci.index("refresh_mirrors:")]
assert "verify_chrome_package.sh --target dev" in mr, mr
assert "scripts/ci/release_chrome.sh" in rel, rel
# The release script verifies whatever it builds, and it builds the one list of release targets rather
# than a copy of it: it reads RELEASE_TARGETS, and verifies each entry rather than a hard-coded name.
rel_sh = open("scripts/ci/release_chrome.sh").read()
assert "RELEASE_TARGETS" in rel_sh, "release_chrome.sh must take its target list from patch_extension.py"
assert 'verify_chrome_package.sh" --target "$t"' in rel_sh, rel_sh
assert 'check_store_zip.py" "$zip"' in rel_sh, rel_sh
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("p", "thankmu/patch_extension.py")
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
assert mod.RELEASE_TARGETS == ("store", "alpha"), mod.RELEASE_TARGETS
# Both packages a tag builds must survive as artifacts, so the glob has to catch the alpha zip too.
assert "thankmu_chromium_*.zip" in rel, rel
PYE

echo "== Popup (W-P6): upstream's controls survive the D2 popup =="
# Real upstream popup.html and js/popup.js (the subtree source), patched with the real patch.json popup edits.
UPX="$ROOT/$(. "$ROOT/scripts/lib.sh"; echo "$UBO_PREFIX")/platform/mv3/extension"
popinv() { # <name> : $TMP/<name>/{unpatched,patched} from upstream's popup plus the real edits
  rm -rf "$TMP/$1"; mkdir -p "$TMP/$1/unpatched/js" "$TMP/$1/patched/js"
  cp "$UPX/popup.html" "$TMP/$1/unpatched/"; cp "$UPX/js/popup.js" "$TMP/$1/unpatched/js/"; cp "$UPX/js/popup.js" "$TMP/$1/patched/js/"
  cp -R "$FX/pkg/css" "$TMP/$1/unpatched/css"; cp -R "$FX/pkg/css" "$TMP/$1/patched/css"   # the stylesheets popup.html links
  "$PY" -I - "$UPX/popup.html" "$ROOT/thankmu/patch.json" "$TMP/$1/patched/popup.html" <<'PYE'
import json, re, sys
src, pj, out = sys.argv[1:4]
t = open(src, encoding="utf8").read()
for e in json.load(open(pj))["edits"]:
    if e["file"] == "popup.html":
        assert len(re.findall(e["pattern"], t)) == e["count"], e["pattern"]
        t = re.sub(e["pattern"], lambda m: m.expand(e["new"].replace("{name}", "ThankMu")), t)
open(out, "w", encoding="utf8").write(t)
PYE
}
inv() { "$PY" -I "$ROOT/scripts/check_popup_inventory.py" "$TMP/$1/unpatched" "$TMP/$1/patched"; }
popinv pi; inv pi >"$TMP/o" 2>&1 && grep -q "all 14 upstream controls" "$TMP/o" && ok "popup inventory passes on upstream's popup plus the real edits" || bad "popup inventory passes on upstream's popup plus the real edits" "$(cat "$TMP/o")"
pib() { # <name> <file under patched|unpatched> <old> <new> <expected>
  popinv pib; pyedit "$TMP/pib/$2" "$3" "$4"
  expect_fail "popup inventory catches: $1" "$5" -- inv pib
}
pib "an upstream control dropped" patched/popup.html '<span id="gotoReport" class="tool enabled" tabindex="0">' '<span class="tool enabled">' "Report an issue"
pib "a control moved above the head frame" patched/popup.html '<div id="hostname"><span></span>&shy;<span></span></div>' '' "hostname of the current site"
pib "a new upstream control nobody inventoried" unpatched/popup.html '<span id="gotoReport"' '<span id="gotoLogger" tabindex="0"></span><span id="gotoReport"' "not in the inventory: <span id=\"gotoLogger\""
pib "upstream's popup.js changed" patched/js/popup.js "dom.on('#gotoReport'" "dom.on('#gotoNothing'" "js/popup.js differs from upstream"
pib "a script tag added to the popup" patched/popup.html '</body>' '<script src="js/evil.js"></script></body>' "script tags changed"
# Review W-P6 (MR !15): hiding, restyling or covering an upstream control through patch.json must fail too.
pib "an upstream tool hidden (hidden attribute)" patched/popup.html '<span id="gotoReport" class="tool enabled" tabindex="0">' '<span id="gotoReport" class="tool enabled" tabindex="0" hidden>' "byte for byte"
pib "the slider hidden by an inline style" patched/popup.html '<div class="filteringModeSlider">' '<div class="filteringModeSlider" style="display:none">' "byte for byte"
pib "the local tools block hidden" patched/popup.html '<div class="toolMenu localTools needHTTP">' '<div class="toolMenu localTools needHTTP" hidden>' "byte for byte"
pib "a full-size overlay iframe" patched/popup.html '</main>' '<iframe src="thankmu-popup.html" style="position: fixed; inset: 0; width: 100%; height: 100%; border: 0"></iframe>
</main>' "allowed shape"
pib "a ThankMu frame restyled into an overlay" patched/popup.html 'style="display: block; width: 100%; min-width: 32.5rem; height: 44px; border: 0"' 'style="position: fixed; inset: 0; width: 100%; height: 100%; border: 0"' "allowed shape"
pib "an upstream popup stylesheet changed" patched/css/popup.css '*/' '*/ #gotoReport { display: none; }' "css/popup.css differs from upstream"
pib "the account frame removed" patched/popup.html '<iframe id="thankmuPrompts" ' '<iframe id="other" ' "head and account frames exactly once"
"$PY" -I - "$ROOT/docs/rebrand.md" "$ROOT/scripts/check_popup_inventory.py" <<'PYE' && ok "every inventoried control has a row in docs/rebrand.md" || bad "every inventoried control has a row in docs/rebrand.md"
import importlib.util, sys
doc = open(sys.argv[1], encoding="utf8").read()
spec = importlib.util.spec_from_file_location("inv", sys.argv[2]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
sec = doc[doc.index("## Popup (W-P6)"):]
for what, marker, _ in m.INVENTORY:
    assert f"| {what} |" in sec, what
PYE

echo "== About pane (W-P4): GPLv3 notice and source offer =="
FT="$FX/thankmu/targets.json"
SRC="$("$PY" -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["store"]["source_url"])' "$FT")"
tq "$FT" "$TMP/t-nosrc.json" 'del d["store"]["source_url"]'
# the real config: today the founder has no public source repo, so a store build must refuse; once source_url is set it must pass
if "$PY" -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["store"].get("source_url") else 1)' "$RT"; then
  "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config target=store >/dev/null 2>&1 && ok "real config: store target has a source_url and validates" || bad "real config: store target has a source_url and validates"
else
  expect_fail "real config: a store build refuses without store.source_url (no public source repo yet)" "has no source_url" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config target=store
fi
"$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config target=dev >/dev/null 2>&1 && ok "real config: dev target validates without a source_url" || bad "real config: dev target validates without a source_url"
expect_fail "store target without source_url fails at config check" "must carry the GPLv3 source offer" -- chk_cfg "$TMP/t-nosrc.json" target=store
fresh pt; expect_fail "patch step refuses a store target without source_url" "has no source_url" -- patch_cmd "$TMP/pt" "" "" store "$TMP/t-nosrc.json"
tq "$FT" "$TMP/t-srchttp.json" 'd["store"]["source_url"]="http://source.example.invalid/x"';   expect_fail "http source_url fails loudly" "source_url must be an https URL" -- chk_cfg "$TMP/t-srchttp.json"
tq "$FT" "$TMP/t-srcbare.json" 'd["store"]["source_url"]="https://source.example.invalid"';    expect_fail "source_url without a path fails loudly" "source_url must be an https URL" -- chk_cfg "$TMP/t-srcbare.json"
tq "$FT" "$TMP/t-srcslash.json" 'd["store"]["source_url"]="https://source.example.invalid/"'; expect_fail "source_url that is only a slash fails loudly" "source_url must be an https URL" -- chk_cfg "$TMP/t-srcslash.json"
tq "$FT" "$TMP/t-srcq.json" 'd["store"]["source_url"]="https://source.example.invalid/x?y=1"'; expect_fail "source_url with a query fails loudly" "source_url must be an https URL" -- chk_cfg "$TMP/t-srcq.json"
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); del d["about_license"]; json.dump(d,open(sys.argv[2],"w"))' "$ROOT/thankmu/patch.json" "$TMP/patch-noal.json"
expect_fail "patch config without about_license fails loudly" "incomplete: 'about_license'" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config patch="$TMP/patch-noal.json"
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["about_license"]["with_source"]=d["about_license"]["without_source"]; json.dump(d,open(sys.argv[2],"w"))' "$ROOT/thankmu/patch.json" "$TMP/patch-alnourl.json"
expect_fail "about_license that would not show the source URL fails loudly" "must show {source_url}" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config patch="$TMP/patch-alnourl.json"
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); a=d["about_license"]; a["without_source"]=a["without_source"].replace("LICENSE.txt","COPYING"); json.dump(d,open(sys.argv[2],"w"))' "$ROOT/thankmu/patch.json" "$TMP/patch-allic.json"
expect_fail "about_license rows that do not link license_file fail loudly" "license_file" -- "$PY" -I "$ROOT/thankmu/patch_extension.py" --check-config patch="$TMP/patch-allic.json"
fresh pd; rm "$TMP/pd/LICENSE.txt"
expect_fail "patch fails when the linked licence text is not in the package" "LICENSE.txt" -- patch_cmd "$TMP/pd"
fresh pd; pyedit "$TMP/pd/dashboard.html" 'Copyright (c) Raymond Hill 2014-present' 'Copyright Raymond Hill'
expect_fail "patch fails when the credit rows the notice anchors on are gone" "matched 0 time" -- patch_cmd "$TMP/pd"
"$PY" -I - "$TMP/pdev" "$TMP/pstore" "$FX/thankmu/brand.json" "$SRC" <<'PYE' && ok "About pane: notice + source offer (store), notice + dev note (dev), licence text linked" || bad "About pane: notice + source offer (store), notice + dev note (dev), licence text linked"
import json, sys
dev, store, bp, src = sys.argv[1:5]
b = json.load(open(bp))
d = open(f"{dev}/dashboard.html", encoding="utf8").read()
s = open(f"{store}/dashboard.html", encoding="utf8").read()
lic = f'<div class="li" id="thankmuLicense">{b["license_notice"]} <a href="LICENSE.txt" target="_blank">{b["license_link_text"]}</a></div>'
offer = f'<div class="li" id="thankmuSourceOffer">{b["source_offer"]} <a href="{src}" target="_blank">{src}</a></div>'
mod = f'<div class="li" id="thankmuModified">{b["modification_notice"]}</div>'
note = f'<div class="li" id="thankmuSourceOffer">{b["source_offer_dev"]}</div>'
assert s.count(lic) == 1 and s.count(offer) == 1 and b["source_offer_dev"] not in s, s[s.index("about"):][:1500]
assert d.count(lic) == 1 and d.count(note) == 1 and b["source_offer"] not in d and src not in d, d
assert d.count(mod) == 1 and s.count(mod) == 1, "modification notice (GPLv3 5(a)) once in both"
for h in (d, s):  # right under the credit rows, inside the About pane
    a, c, l = h.index('data-pane="about"'), h.index(b["lists_credit"]), h.index('id="thankmuLicense"')
    assert a < c < l, "licence rows follow the credit rows in About"
PYE
chk_brand "$TMP/pstore" >"$TMP/o" 2>"$TMP/e" && grep -q "source offer for target store" "$TMP/o" && ok "brand scan infers the store target from config.js and finds the source offer" || bad "brand scan infers the store target" "$(cat "$TMP/o" "$TMP/e")"
chk_brand "$TMP/pdev" >"$TMP/o" 2>"$TMP/e" && grep -q "dev-only source note for target dev" "$TMP/o" && ok "brand scan accepts the dev-only note on a dev package" || bad "brand scan accepts the dev-only note on a dev package" "$(cat "$TMP/o" "$TMP/e")"
expect_fail "brand scan: a store package is refused when store has no source_url" "has no source_url" -- chk_brand "$TMP/pstore" "" "$TMP/t-nosrc.json" target=store
expect_fail "brand scan: a dev package is not a store package" "must appear exactly once" -- chk_brand "$TMP/pdev" "" "" target=store
al() { # <name> <file> <old> <new> <expected> : a store About pane the scan and the blocking check must both refuse
  fresh pm "$TMP/pstore"; pyedit "$TMP/pm/$2" "$3" "$4"
  expect_fail "brand scan catches: $1" "$5" -- chk_brand "$TMP/pm"
  expect_fail "blocking check catches: $1" "$5" -- chk_block "$FX/pkg" "$TMP/pm" target=store
}
al "store source offer link removed" dashboard.html " <a href=\"$SRC\" target=\"_blank\">$SRC</a>" "" "must appear exactly once"
al "GPLv3 notice removed" dashboard.html 'ThankMu is free software: you can redistribute it' 'ThankMu is software' "must appear exactly once"
fresh pm "$TMP/pstore"; "$PY" -I -c 'import re,sys; p=sys.argv[1]; h=open(p,encoding="utf8").read(); m=re.search(r"\n[ ]*<div class=\"li\" id=\"thankmuModified\">.*?\n[ ]*<div class=\"li\" id=\"thankmuSourceOffer\">.*?</div>", h, re.S); open(p,"w",encoding="utf8").write(h[:m.end()] + m.group(0) + h[m.end():])' "$TMP/pm/dashboard.html"
expect_fail "brand scan catches: store notice and offer duplicated" "found 2" -- chk_brand "$TMP/pm"
expect_fail "blocking check catches: store notice and offer duplicated" "found 2" -- chk_block "$FX/pkg" "$TMP/pm" target=store
al "store source offer pointing elsewhere" dashboard.html "href=\"$SRC\"" 'href="https://other.example.invalid/x"' "must appear exactly once"
al "dev note shown in a store build" dashboard.html '<div class="li" id="thankmuLicense">' '<div class="li">Development build: no public source location is configured. Store builds cannot be made without one.</div><div class="li" id="thankmuLicense">' "dev-only source note"
fresh pm "$TMP/pstore"; rm "$TMP/pm/LICENSE.txt"
expect_fail "brand scan: the linked LICENSE.txt is missing from the package" "LICENSE.txt" -- chk_brand "$TMP/pm"
expect_fail "blocking check: the linked LICENSE.txt is missing from the package" "LICENSE.txt" -- chk_block "$FX/pkg" "$TMP/pm" target=store
# HTML is replayed like JS: upstream + the configured text/link/edit changes + the About rows, byte for byte
lb "an inline on* handler in HTML" dashboard.html 'data-i18n="aboutPrivacyPolicy"' 'data-i18n="aboutPrivacyPolicy" onclick="steal()"' "dashboard.html: differs from upstream plus the configured HTML changes"
lb "a javascript: src in HTML" popup.html 'src="thankmu-popup.html"' 'src="javascript:alert(1)"' "popup.html: differs from upstream plus the configured HTML changes"
lb "an extra iframe in HTML" popup.html '</main>' '<iframe src="https://evil.example.invalid/"></iframe></main>' "popup.html: differs from upstream plus the configured HTML changes"
lb "an extra form in HTML" dashboard.html '</section>' '<form action="https://evil.example.invalid/"><input name="q"></form></section>' "dashboard.html: differs from upstream plus the configured HTML changes"
lb "a changed visible HTML text" zapper-ui.html 'ThankMu Zapper' 'ThankMu Zapper!' "zapper-ui.html: differs from upstream plus the configured HTML changes"
# ...and, independent of patch.json, no HTML file may gain or change a <script> (src, type, inline content): a config
# edit that adds one passes the replay (it IS upstream + config) but must still fail
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); e=[x for x in d["edits"] if x["file"]=="popup.html"][0]; e["new"]=e["new"].replace("</iframe>", "</iframe><script src=\"js/evil.js\"></script>", 1); json.dump(d,open(sys.argv[2],"w"))' "$FX/thankmu/patch.json" "$TMP/patch-script.json"
fresh pscr; patch_cmd "$TMP/pscr" "" "$TMP/patch-script.json" store >/dev/null 2>&1 && grep -q 'js/evil.js' "$TMP/pscr/popup.html" && ok "a config edit can put a script tag into the patched popup (fixture for the next check)" || bad "a config edit can put a script tag into the patched popup"
out="$("$PY" -I "$ROOT/scripts/check_blocking_unchanged.py" "$FX/pkg" "$TMP/pscr" brand="$FX/thankmu/brand.json" patch="$TMP/patch-script.json" targets="$FX/thankmu/targets.json" target=store 2>&1)"
if [ $? -eq 0 ]; then bad "blocking check refuses a script tag added through patch.json" "passed: $out"
elif ! grep -q "popup.html: script tags differ" <<<"$out"; then bad "blocking check refuses a script tag added through patch.json" "$out"
elif grep -q "popup.html: differs from upstream plus" <<<"$out"; then bad "blocking check: the replay itself accepts the config's script (only the script rule refuses it)" "$out"
else ok "blocking check refuses a script tag added through patch.json (replay passes it, the script-tag rule does not)"; fi
lb "a changed inline script" zapper-ui.html '<aside' '<script>x()</script><aside' "zapper-ui.html: script tags differ"
fresh pm "$TMP/pstore"; rm "$TMP/pm/js/thankmu/config.js"
expect_fail "brand scan without a target and no config.js fails loudly" "no BUILD_TARGET" -- chk_brand "$TMP/pm"
expect_fail "blocking check refuses a store package when store has no source_url" "has no source_url" -- "$PY" -I "$ROOT/scripts/check_blocking_unchanged.py" "$FX/pkg" "$TMP/pstore" brand="$FX/thankmu/brand.json" patch="$FX/thankmu/patch.json" targets="$TMP/t-nosrc.json" target=store

echo "== build_chrome.sh =="
mkdir -p "$TMP/nosub/scripts" && cp "$ROOT"/scripts/*.sh "$TMP/nosub/scripts/"
expect_fail "build refuses without subtree" "subtree" -- "$TMP/nosub/scripts/build_chrome.sh"
# Hermetic: the CI host has no node, jq, zip or rsvg-convert (only the docker image does), so stub them.
# The stub node reports $FAKE_NODE_MAJOR. A throwaway tree holds scripts + the subtree marker files
# + a stub make-mv3.sh that "builds" the fixture package + the ThankMu layer (real patch step, fixture config),
# so a build that clears the node floor runs the whole pipeline: patch, verify, package.
. "$ROOT/scripts/lib.sh"
mkdir -p "$TMP/fakebin" && printf '#!/bin/sh\necho "${FAKE_NODE_MAJOR:?}"\n' > "$TMP/fakebin/node"
printf '#!/bin/sh\nexit 0\n' > "$TMP/fakebin/jq"
printf '#!/bin/sh\n# stub zip: zip -qr <out> ./*  -> record the file list of the cwd as the archive\nout="$2"; ls -R . > "$out"\n' > "$TMP/fakebin/zip"
cp "$TMP/rsvgbin/rsvg-convert" "$TMP/fakebin/rsvg-convert"
chmod +x "$TMP/fakebin/node" "$TMP/fakebin/jq" "$TMP/fakebin/zip"
BT="$TMP/bt"; mkdir -p "$BT/scripts" "$BT/thankmu" "$BT/$UBO_PREFIX/tools" "$BT/$CODEMIRROR_PREFIX/dist" "$BT/$S14E_PREFIX"
cp "$ROOT"/scripts/*.sh "$ROOT"/scripts/*.py "$BT/scripts/"
cp "$ROOT/thankmu/patch_extension.py" "$ROOT/thankmu/icon.svg" "$BT/thankmu/"
cp -R "$ROOT/thankmu/ext" "$BT/thankmu/ext"
for t in dev store alpha; do mkdir -p "$BT/tests/fixtures/icons/$t"; for f in icon_16 icon_16_off icon_512; do printf PNGSTUB > "$BT/tests/fixtures/icons/$t/$f.png"; done; done   # the stub rasterizer writes PNGSTUB
cp "$FX/thankmu/brand.json" "$FX/thankmu/patch.json" "$FX/thankmu/targets.json" "$BT/thankmu/"
printf '#!/bin/sh\nrm -rf dist/build/uBOLite.chromium; mkdir -p dist/build; cp -R "%s" dist/build/uBOLite.chromium\nfor a in "$@"; do case "$a" in [0-9]*.[0-9]*.[0-9]*) echo upstream-unpatched > "dist/build/uBOLite_$a.chromium.zip";; esac; done\n' "$FX/pkg" > "$BT/$UBO_PREFIX/tools/make-mv3.sh"
chmod +x "$BT/$UBO_PREFIX/tools/make-mv3.sh"
: > "$BT/$CODEMIRROR_PREFIX/dist/cm6.bundle.ubol.min.js"; : > "$BT/$S14E_PREFIX/s14e-serializer.js"
build_with() { # <node-major>: run the build in $BT with the stubs; .nvmrc is whatever the caller put there
  env -u CI -u BUILDS_KEEP PATH="$TMP/fakebin:$PATH" FAKE_NODE_MAJOR="$1" BUILD_SHORTSHA=abc1234 "$BT/scripts/build_chrome.sh"
}
nvmrc() { printf '%s' "$1" > "$BT/.nvmrc"; }
nvmrc $'99\n';      expect_fail ".nvmrc 99 fails and names 99" "node >= 99 required by .nvmrc" -- build_with 22
nvmrc $'22\n';      expect_fail ".nvmrc 22 rejects node 21" "node >= 22 required by .nvmrc" -- build_with 21
nvmrc $'v22\n';     expect_fail ".nvmrc v22 normalizes to 22 (rejects node 21)" "node >= 22 required by .nvmrc" -- build_with 21
nvmrc $'22.11.0\n'; expect_fail ".nvmrc 22.11.0 normalizes to 22 (rejects node 21)" "node >= 22 required by .nvmrc" -- build_with 21
nvmrc $'v22\n';     build_with 22 >/dev/null 2>&1 && ok ".nvmrc v22 accepts node 22" || bad ".nvmrc v22 accepts node 22"
nvmrc $'22.11.0\n'; build_with 23 >/dev/null 2>&1 && ok ".nvmrc 22.11.0 accepts node 23" || bad ".nvmrc 22.11.0 accepts node 23"
nvmrc $'22\n'
build_with 22 >"$TMP/b.out" 2>&1 && ok "dev build runs make-mv3 -> patch -> verify end to end" || bad "dev build runs make-mv3 -> patch -> verify end to end" "$(tail -5 "$TMP/b.out")"
grep -q "brand scan ok" "$TMP/b.out" && grep -q "blocking unchanged" "$TMP/b.out" && ok "build runs both package checks" || bad "build runs both package checks"
grep -q '"short_name": "ThankMu"' "$BT/$UBO_PREFIX/dist/build/uBOLite.chromium/manifest.json" && grep -q '"short_name": "uBO Lite"' "$BT/$UBO_PREFIX/dist/build/uBOLite.chromium.unpatched/manifest.json" && ok "build keeps the pristine upstream output next to the patched one" || bad "build keeps the pristine upstream output next to the patched one"
"$PY" -I -c 'import json,sys; m=json.load(open(sys.argv[1])); t=json.load(open(sys.argv[2]))["dev"]; assert m["key"]==t["manifest_key"] and m["externally_connectable"]["matches"]==[t["app_origin"]+"/*"]' "$BT/$UBO_PREFIX/dist/build/uBOLite.chromium/manifest.json" "$BT/thankmu/targets.json" && grep -q "target dev" "$TMP/b.out" && ok "build without a version is the dev target (dev origin, pinned key)" || bad "build without a version is the dev target"
env -u CI -u BUILDS_KEEP PATH="$TMP/fakebin:$PATH" FAKE_NODE_MAJOR=22 BUILD_SHORTSHA=abc1234 "$BT/scripts/build_chrome.sh" 1.2.3 >"$TMP/b.out" 2>&1 && ok "release build succeeds" || bad "release build succeeds" "$(tail -5 "$TMP/b.out")"
[ -s "$BT/$UBO_PREFIX/dist/build/thankmu_chromium_1.2.3.zip" ] && ok "release artifact is thankmu_chromium_<version>.zip" || bad "release artifact is thankmu_chromium_<version>.zip"
[ ! -e "$BT/$UBO_PREFIX/dist/build/uBOLite_1.2.3.chromium.zip" ] && ok "upstream's unpatched zip is removed from the release output" || bad "upstream's unpatched zip is removed from the release output"
grep -q 'thankmu.svg' "$BT/$UBO_PREFIX/dist/build/thankmu_chromium_1.2.3.zip" && ! grep -q 'log.txt\|ublock.svg' "$BT/$UBO_PREFIX/dist/build/thankmu_chromium_1.2.3.zip" && ok "release zip is built from the patched tree without log.txt" || bad "release zip is built from the patched tree without log.txt"
grep -q "thankmu_chromium_1.2.3.zip" "$TMP/b.out" && ok "release build reports the renamed artifact" || bad "release build reports the renamed artifact"
"$PY" -I -c 'import json,sys; m=json.load(open(sys.argv[1])); t=json.load(open(sys.argv[2]))["store"]; assert "key" not in m and m["externally_connectable"]["matches"]==[t["app_origin"]+"/*"]' "$BT/$UBO_PREFIX/dist/build/uBOLite.chromium/manifest.json" "$BT/thankmu/targets.json" && grep -q "target store" "$TMP/b.out" && ok "release build is the store target (prod origin, no key)" || bad "release build is the store target"
grep -q 'thankmu-sw.js' "$BT/$UBO_PREFIX/dist/build/thankmu_chromium_1.2.3.zip" && ! grep -q 'test.mjs\|package.json' "$BT/$UBO_PREFIX/dist/build/thankmu_chromium_1.2.3.zip" && ok "release zip carries the ThankMu layer and no tests" || bad "release zip carries the ThankMu layer and no tests"

# Several release targets from ONE upstream build. The count matters, not just the output: filter lists are
# downloaded while make-mv3.sh runs, so a second upstream build would give the second package a different
# filter-list snapshot under the same version number.
cp "$BT/thankmu/targets.json" "$TMP/targets-1t.keep"
"$PY" -I -c 'import json,sys
d=json.load(open(sys.argv[1]))
d["alpha"]={"app_origin": d["store"]["app_origin"], "manifest_key": d["dev"]["manifest_key"],
            "extension_id": d["dev"]["extension_id"], "source_url": d["store"]["source_url"],
            "brand": {"name": "Fixture Alpha", "short_name": "Fixture Alpha"}}
json.dump(d,open(sys.argv[1],"w"))' "$BT/thankmu/targets.json"
MVRUNS="$TMP/mvruns"; : > "$MVRUNS"
cp "$BT/$UBO_PREFIX/tools/make-mv3.sh" "$TMP/mk-1t.keep"
printf '#!/bin/sh\necho run >> "%s"\nrm -rf dist/build/uBOLite.chromium; mkdir -p dist/build; cp -R "%s" dist/build/uBOLite.chromium\nfor a in "$@"; do case "$a" in [0-9]*.[0-9]*.[0-9]*) echo upstream-unpatched > "dist/build/uBOLite_$a.chromium.zip";; esac; done\n' "$MVRUNS" "$FX/pkg" > "$BT/$UBO_PREFIX/tools/make-mv3.sh"
chmod +x "$BT/$UBO_PREFIX/tools/make-mv3.sh"
env -u CI -u BUILDS_KEEP PATH="$TMP/fakebin:$PATH" FAKE_NODE_MAJOR=22 BUILD_SHORTSHA=abc1234 "$BT/scripts/build_chrome.sh" 1.2.4 store alpha >"$TMP/b2.out" 2>&1 && ok "release build of two targets succeeds" || bad "release build of two targets succeeds" "$(tail -8 "$TMP/b2.out")"
[ "$(wc -l < "$MVRUNS")" = 1 ] && ok "two release targets share one upstream build" || bad "two release targets share one upstream build" "$(wc -l < "$MVRUNS") upstream build(s)"
[ -s "$BT/$UBO_PREFIX/dist/build/thankmu_chromium_1.2.4.zip" ] && [ -s "$BT/$UBO_PREFIX/dist/build/thankmu_chromium_alpha_1.2.4.zip" ] && ok "store keeps the plain zip name and another target names itself" || bad "store keeps the plain zip name and another target names itself" "$(ls "$BT/$UBO_PREFIX/dist/build/")"
"$PY" -I - "$BT/$UBO_PREFIX/dist/build" "$BT/thankmu/targets.json" <<'PYE' && ok "each release target gets its own package, patched from the same pristine output" || bad "each release target gets its own package, patched from the same pristine output"
import json, sys
b, t = sys.argv[1], json.load(open(sys.argv[2]))
st = json.load(open(f"{b}/uBOLite.chromium.store/manifest.json"))
al = json.load(open(f"{b}/uBOLite.chromium.alpha/manifest.json"))
assert "key" not in st, "the store package must not pin an id"
assert al["key"] == t["alpha"]["manifest_key"], "the alpha package must pin its id"
assert st["externally_connectable"]["matches"] == [t["store"]["app_origin"] + "/*"], st["externally_connectable"]
assert al["externally_connectable"]["matches"] == [t["alpha"]["app_origin"] + "/*"], al["externally_connectable"]
assert al["short_name"] == t["alpha"]["brand"]["short_name"], al["short_name"]
# The canonical build output still holds the first target's package, which is what a store submission reads.
assert "key" not in json.load(open(f"{b}/uBOLite.chromium/manifest.json"))
# The pristine baseline is untouched by either patch.
assert json.load(open(f"{b}/uBOLite.chromium.unpatched/manifest.json"))["short_name"] == "uBO Lite"
PYE
grep -q "target store" "$TMP/b2.out" && grep -q "target alpha" "$TMP/b2.out" && ok "a two-target release build reports both targets" || bad "a two-target release build reports both targets" "$(tail -8 "$TMP/b2.out")"
# Every requested target's config is checked before the (slow) upstream build, not just the first one, so a
# release that could not build its second package fails before the first zip exists.
: > "$MVRUNS"
expect_fail "an unknown release target fails before the upstream build" "unknown target 'nope'" -- env -u CI -u BUILDS_KEEP PATH="$TMP/fakebin:$PATH" FAKE_NODE_MAJOR=22 BUILD_SHORTSHA=abc1234 "$BT/scripts/build_chrome.sh" 1.2.5 store nope
[ ! -s "$MVRUNS" ] && ok "a bad second target stops the build before any upstream build runs" || bad "a bad second target stops the build before any upstream build runs" "$(wc -l < "$MVRUNS") upstream build(s)"
cp "$TMP/mk-1t.keep" "$BT/$UBO_PREFIX/tools/make-mv3.sh"; cp "$TMP/targets-1t.keep" "$BT/thankmu/targets.json"
cp "$BT/thankmu/brand.json" "$TMP/brand.keep"; rm "$BT/thankmu/brand.json"
expect_fail "build fails loudly without thankmu/brand.json" "ThankMu layer file missing" -- build_with 22
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); del d["name"]; json.dump(d,open(sys.argv[2],"w"))' "$TMP/brand.keep" "$BT/thankmu/brand.json"
expect_fail "build fails loudly on an incomplete brand config, before the upstream build" "incomplete: 'name'" -- build_with 22
cp "$TMP/brand.keep" "$BT/thankmu/brand.json"
cp "$BT/thankmu/targets.json" "$TMP/targets.keep"; rm "$BT/thankmu/targets.json"
expect_fail "build fails loudly without thankmu/targets.json" "ThankMu layer file missing: thankmu/targets.json" -- build_with 22
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); del d["dev"]["app_origin"]; json.dump(d,open(sys.argv[2],"w"))' "$TMP/targets.keep" "$BT/thankmu/targets.json"
expect_fail "build fails loudly without an APP_ORIGIN, before the upstream build" "'dev'.app_origin is missing" -- build_with 22
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["store"]["app_origin"]="http://app.example.invalid"; json.dump(d,open(sys.argv[2],"w"))' "$TMP/targets.keep" "$BT/thankmu/targets.json"
expect_fail "build fails loudly on a non-https APP_ORIGIN" "bare https origin" -- build_with 22
cp "$TMP/targets.keep" "$BT/thankmu/targets.json"
expect_fail "verify step fails when a package still carries upstream marks" "BRAND SCAN FAILED" -- "$BT/scripts/verify_chrome_package.sh" "$FX/pkg" "$FX/pkg"
expect_fail "verify step fails without the unpatched baseline" "unpatched baseline not found" -- "$BT/scripts/verify_chrome_package.sh" "$TMP/none" "$FX/pkg"
nvmrc '';            expect_fail ".nvmrc empty fails loudly" "does not start with a node major version" -- build_with 22
nvmrc $'abc\n';     expect_fail ".nvmrc abc fails loudly" "does not start with a node major version" -- build_with 22
rm -f "$BT/.nvmrc";  expect_fail ".nvmrc missing fails loudly" ".nvmrc missing" -- build_with 22
expect_fail "build rejects bad version" "version" -- "$ROOT/scripts/build_chrome.sh" notaversion
expect_fail "build rejects a target named without a version" "a target can only be named for a release build" -- "$ROOT/scripts/build_chrome.sh" "" alpha
expect_fail "build rejects a target named twice" "named twice" -- "$ROOT/scripts/build_chrome.sh" 1.2.3 store store

echo "== release path (scripts/ci/release_chrome.sh, check_store_zip.py, CI jobs) =="
# The real release script against the build tree above, with the docker step replaced by a stub that runs
# build_chrome.sh directly. The zip stub writes a real zip with python (the CI host has no zip binary).
mkdir -p "$BT/scripts/ci" "$TMP/relbin"
cp "$ROOT/scripts/ci/release_chrome.sh" "$BT/scripts/ci/"
printf '#!/bin/sh\nexec "%s/scripts/build_chrome.sh" "$@"\n' "$BT" > "$BT/scripts/ci/docker_build_chrome.sh"
printf '#!/bin/sh\n# stub zip: zip -qr <out> ./*  -> a real zip of the cwd\nexec python3 -I -c "import sys,os,zipfile\nz=zipfile.ZipFile(sys.argv[1],\\"w\\")\n[z.write(os.path.join(d,f),os.path.relpath(os.path.join(d,f),\\".\\")) for d,_,fs in os.walk(\\".\\") for f in fs]\nz.close()" "$2"\n' > "$TMP/relbin/zip"
chmod +x "$BT/scripts/ci/"*.sh "$TMP/relbin/zip"
nvmrc $'22\n'
# Upstream's make-mv3.sh stamps the requested version into the manifest; the fixture stub does not, so for this
# section a copy of the stub does. The original is restored at the end of the section.
MK="$BT/$UBO_PREFIX/tools/make-mv3.sh"; cp "$MK" "$TMP/make-mv3.keep"
printf '\nfor a in "$@"; do case "$a" in [0-9]*.[0-9]*.[0-9]*) python3 -I -c "import json,sys;p=sys.argv[1];m=json.load(open(p));m[\\"version\\"]=sys.argv[2];json.dump(m,open(p,\\"w\\"))" dist/build/uBOLite.chromium/manifest.json "$a";; esac; done\n' >> "$MK"
release() { env -u CI -u BUILDS_KEEP PATH="$TMP/relbin:$TMP/fakebin:$PATH" FAKE_NODE_MAJOR=22 BUILD_SHORTSHA=abc1234 "$BT/scripts/ci/release_chrome.sh" "$@"; }
expect_fail "release script requires a version" "usage: release_chrome.sh X.Y.Z" -- release
expect_fail "release script rejects a tag-shaped version" "usage: release_chrome.sh X.Y.Z" -- release chrome-v1.2.3
expect_fail "release script rejects a non-semver version" "usage: release_chrome.sh X.Y.Z" -- release 1.2
release 1.2.3 >"$TMP/r.out" 2>&1 && ok "release script runs build, verify and zip check end to end" || bad "release script runs build, verify and zip check end to end" "$(tail -8 "$TMP/r.out")"
grep -q "brand scan ok" "$TMP/r.out" && grep -q "blocking unchanged" "$TMP/r.out" && grep -q "store zip ok" "$TMP/r.out" && grep -q "Release path ok for 1.2.3" "$TMP/r.out" && ok "release script reports verify and zip-check results" || bad "release script reports verify and zip-check results" "$(tail -8 "$TMP/r.out")"
# One tag, both packages: the release script checks the alpha zip the same way and reports it too.
grep -q "alpha zip ok" "$TMP/r.out" && ok "release script checks the alpha zip as well as the store zip" || bad "release script checks the alpha zip as well as the store zip" "$(tail -8 "$TMP/r.out")"
[ -s "$BT/$UBO_PREFIX/dist/build/thankmu_chromium_alpha_1.2.3.zip" ] && ok "release script leaves the alpha zip beside the store zip" || bad "release script leaves the alpha zip beside the store zip" "$(ls "$BT/$UBO_PREFIX/dist/build/")"
grep -q "extension id adpddphgffkgjjnibeabbamjlieaofne\|extension id $("$PY" -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["alpha"]["extension_id"])' "$BT/thankmu/targets.json")" "$TMP/r.out" \
  && ok "release log records the alpha extension id (the one PLUGIN_EXTENSION_IDS must list)" || bad "release log records the alpha extension id" "$(tail -8 "$TMP/r.out")"
RZ="$BT/$UBO_PREFIX/dist/build/thankmu_chromium_1.2.3.zip"
RZA="$BT/$UBO_PREFIX/dist/build/thankmu_chromium_alpha_1.2.3.zip"
CSZ="$ROOT/scripts/check_store_zip.py"
[ -s "$RZ" ] && "$PY" -I -c 'import zipfile,sys; assert zipfile.ZipFile(sys.argv[1]).testzip() is None' "$RZ" && ok "release script leaves a readable store zip" || bad "release script leaves a readable store zip"
# check_store_zip.py on crafted zips: take the good manifest and break one thing at a time.
mkzip() { # <out> <jq-less python expr mutating dict m> [extra member name]; source zip is $SRCZ (the store zip)
  "$PY" -I - "${SRCZ:-$RZ}" "$1" "$2" "${3:-}" <<'PYEOF'
import json, sys, zipfile
src, out, mut, extra = sys.argv[1:5]
zi = zipfile.ZipFile(src); zo = zipfile.ZipFile(out, "w")
for n in zi.namelist():
    d = zi.read(n)
    if n == "manifest.json":
        m = json.loads(d); exec(mut); d = json.dumps(m).encode()
    zo.writestr(n, d)
if extra:
    zo.writestr(extra, "x")
zo.close()
PYEOF
}
TG="$BT/thankmu/targets.json"
mkzip "$TMP/good.zip" "pass";                                    "$PY" -I "$CSZ" "$TMP/good.zip" "$TG" 1.2.3 >/dev/null 2>&1 && ok "store zip check accepts the built zip" || bad "store zip check accepts the built zip"
mkzip "$TMP/key.zip" "m['key']='AAAA'";                          expect_fail "store zip check rejects a manifest key" "carries a 'key'" -- "$PY" -I "$CSZ" "$TMP/key.zip" "$TG" 1.2.3
mkzip "$TMP/ec1.zip" "m['externally_connectable']['matches'].append('https://app.dev.thankmu.com/*')"
expect_fail "store zip check rejects a second externally_connectable origin" "externally_connectable is" -- "$PY" -I "$CSZ" "$TMP/ec1.zip" "$TG" 1.2.3
mkzip "$TMP/ec2.zip" "m['externally_connectable']['ids']=['*']"
expect_fail "store zip check rejects extra externally_connectable keys" "externally_connectable is" -- "$PY" -I "$CSZ" "$TMP/ec2.zip" "$TG" 1.2.3
mkzip "$TMP/ec3.zip" "del m['externally_connectable']"
expect_fail "store zip check rejects a missing externally_connectable" "externally_connectable is" -- "$PY" -I "$CSZ" "$TMP/ec3.zip" "$TG" 1.2.3
expect_fail "store zip check rejects a version mismatch" "manifest version is" -- "$PY" -I "$CSZ" "$TMP/good.zip" "$TG" 9.9.9
mkzip "$TMP/log.zip" "pass" "log.txt";                           expect_fail "store zip check rejects a build log in the package" "build log" -- "$PY" -I "$CSZ" "$TMP/log.zip" "$TG" 1.2.3
mkzip "$TMP/prov.zip" "pass"; "$PY" -I -c 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"a"); z.writestr("dashboard.html","<a href=\"https://source.example.invalid/thankmu/thankmu-plugin\">source</a>"); z.close()' "$TMP/prov.zip"
expect_fail "store zip check rejects a provisional zip (placeholder source URL)" "placeholder source URL" -- "$PY" -I "$CSZ" "$TMP/prov.zip" "$TG" 1.2.3
printf 'not a zip' > "$TMP/bad.zip";                             expect_fail "store zip check rejects a file that is not a zip" "not a readable zip" -- "$PY" -I "$CSZ" "$TMP/bad.zip" "$TG" 1.2.3
"$PY" -I -c 'import zipfile,sys; zipfile.ZipFile(sys.argv[1],"w").writestr("sub/manifest.json","{}")' "$TMP/nested.zip"
expect_fail "store zip check rejects a manifest not at the root" "not at the zip root" -- "$PY" -I "$CSZ" "$TMP/nested.zip" "$TG" 1.2.3
"$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["store"]["manifest_key"]="AAAA"; json.dump(d,open(sys.argv[2],"w"))' "$TG" "$TMP/tg-key.json"
expect_fail "store zip check rejects a store target that pins a key" "manifest_key" -- "$PY" -I "$CSZ" "$TMP/good.zip" "$TMP/tg-key.json" 1.2.3
# The alpha zip gets the same checks with the id requirement inverted: it MUST carry the pinned key, because it
# is installed from a file and an unpinned build gets a fresh id per machine and can never pair.
"$PY" -I "$CSZ" "$RZA" "$TG" 1.2.3 alpha >/dev/null 2>&1 && ok "alpha zip check accepts the built alpha zip" || bad "alpha zip check accepts the built alpha zip" "$("$PY" -I "$CSZ" "$RZA" "$TG" 1.2.3 alpha 2>&1 | tail -3)"
SRCZ="$RZA"
mkzip "$TMP/a-nokey.zip" "del m['key']"
expect_fail "alpha zip check rejects a zip with no pinned key" "carries no 'key'" -- "$PY" -I "$CSZ" "$TMP/a-nokey.zip" "$TG" 1.2.3 alpha
mkzip "$TMP/a-wrongkey.zip" "m['key']='AAAA'"
expect_fail "alpha zip check rejects a zip pinning the wrong key" "is not targets.json alpha.manifest_key" -- "$PY" -I "$CSZ" "$TMP/a-wrongkey.zip" "$TG" 1.2.3 alpha
SRCZ="$RZ"
# The two packages of one release are not interchangeable, in either direction.
expect_fail "the store zip is refused as an alpha zip (no pinned key)" "carries no 'key'" -- "$PY" -I "$CSZ" "$RZ" "$TG" 1.2.3 alpha
expect_fail "the alpha zip is refused as a store zip (it pins a key)" "carries a 'key'" -- "$PY" -I "$CSZ" "$RZA" "$TG" 1.2.3
expect_fail "zip check rejects an unknown target" "unknown target" -- "$PY" -I "$CSZ" "$RZ" "$TG" 1.2.3 nope
# A failing verify step must fail the release script (the store zip would otherwise ship unchecked).
cp "$BT/scripts/verify_chrome_package.sh" "$TMP/verify.keep"; printf '#!/bin/sh\necho verify-boom >&2\nexit 1\n' > "$BT/scripts/verify_chrome_package.sh"
expect_fail "a build whose verification fails fails the release" "verify-boom" -- release 1.2.4
cp "$TMP/verify.keep" "$BT/scripts/verify_chrome_package.sh"; chmod +x "$BT/scripts/verify_chrome_package.sh"
# CI wiring: both jobs run the one script; the dry run is manual-source only, never a tag, short expiry.
CI_YML="$ROOT/.gitlab-ci.yml"
"$PY" -I - "$CI_YML" <<'PYEOF' && ok "CI: release and dry-run jobs share scripts/ci/release_chrome.sh" || bad "CI: release and dry-run jobs share scripts/ci/release_chrome.sh"
import re, sys
t = open(sys.argv[1]).read()
def job(name):
    m = re.search(r"^%s:\n((?:[ ].*\n|\n)*)" % name, t, re.M)
    assert m, name
    return m.group(1)
rel, dry = job("release_chrome"), job("release_chrome_dry_run")
assert './scripts/ci/release_chrome.sh "${CI_COMMIT_TAG#chrome-v}"' in rel
assert './scripts/ci/release_chrome.sh "$RELEASE_DRY_RUN_VERSION"' in dry
assert "docker_build_chrome.sh" not in rel and "docker_build_chrome.sh" not in dry
PYEOF
# W-P4 item 10 (GPLv3, ADR-013): the release job publishes the released source in the same job, after the zip
# checks, so a failed publish keeps no artifact. The rehearsal runs the same script with --dry-run, and never pushes.
"$PY" -I - "$CI_YML" <<'PYEOF' && ok "CI: the release job publishes the source snapshot, the dry run only rehearses it" || bad "CI: the release job publishes the source snapshot, the dry run only rehearses it"
import re, sys
t = open(sys.argv[1]).read()
def job(name):
    m = re.search(r"^%s:\n((?:[ ].*\n|\n)*)" % name, t, re.M)
    assert m, name
    return m.group(1)
rel, dry = job("release_chrome"), job("release_chrome_dry_run")
assert './scripts/ci/publish_source_snapshot.sh "${CI_COMMIT_TAG#chrome-v}"' in rel, "release job does not publish"
assert "--dry-run" not in rel, "the release job must really publish"
assert './scripts/ci/publish_source_snapshot.sh "$RELEASE_DRY_RUN_VERSION" --dry-run' in dry, "dry run does not rehearse"
# Order inside the release job. Publishing comes after the release script: the zip has passed its
# checks by then, which is the coupling. The publish step's *configuration* is checked before the
# build instead, because a refusal after the zip exists discards the artifact and spends the tag.
cmds = [l.strip()[2:].strip() for l in rel.splitlines() if l.strip().startswith("- ")]
pub = './scripts/ci/publish_source_snapshot.sh "${CI_COMMIT_TAG#chrome-v}"'
build = './scripts/ci/release_chrome.sh "${CI_COMMIT_TAG#chrome-v}"'
assert pub in cmds, "the release job must publish with no flag"
assert f"{pub} --preflight" in cmds, "the release job must preflight the publish configuration"
assert cmds.index(f"{pub} --preflight") < cmds.index(build) < cmds.index(pub), \
    "preflight must run before the build, and the real publish after it"
# Both variables the publish needs are documented in the file's header, so nobody has to read the script to set them.
assert "SNAPSHOT_REPO_URL" in t and "SNAPSHOT_PUSH_TOKEN" in t
PYEOF
"$PY" -I - "$CI_YML" <<'PYEOF' && ok "CI: dry run is manual-source only, never a tag, short expiry, not a release artifact name" || bad "CI: dry run is manual-source only, never a tag, short expiry, not a release artifact name"
import re, sys
t = open(sys.argv[1]).read()
dry = re.search(r"^release_chrome_dry_run:\n((?:[ ].*\n|\n)*)", t, re.M).group(1)
assert "$RELEASE_DRY_RUN_VERSION" in dry and "api|web|trigger" in dry and "$CI_COMMIT_TAG == null" in dry
assert "expire_in: 1 day" in dry and "chrome-dry-run-" in dry
rel = re.search(r"^release_chrome:\n((?:[ ].*\n|\n)*)", t, re.M).group(1)
assert "RELEASE_DRY_RUN_VERSION" not in rel and "expire_in: never" in rel
# the workflow admits the dry-run pipeline, and only with the same guard
wf = re.search(r"^workflow:\n((?:[ ].*\n)*)", t, re.M).group(1)
assert "$RELEASE_DRY_RUN_VERSION && $CI_PIPELINE_SOURCE =~ /^(api|web|trigger)$/" in wf
PYEOF
# W-P4 items 4/9/U3: the screenshot job runs the two commands a person would run, and only by hand.
# "Manual" is the whole safety property -- it drives a real browser and its output is committed by a
# person -- so it is asserted here rather than left to whoever next edits the rules.
"$PY" -I - "$CI_YML" <<'PYEOF' && ok "CI: the screenshot job is manual only, never automatic, and keeps the PNGs" || bad "CI: the screenshot job is manual only, never automatic, and keeps the PNGs"
import re, sys
t = open(sys.argv[1]).read()
shots = re.search(r"^screenshots:\n((?:[ ].*\n|\n)*)", t, re.M).group(1)
cmds = [l.strip()[2:].strip() for l in shots.splitlines() if l.strip().startswith("- ./")]
assert cmds == ["./scripts/ci/docker_build_chrome.sh", "./store/screenshots/generate.sh"], cmds
rules = shots[shots.index("rules:"):shots.index("script:")]
# Every arm either refuses the pipeline or waits for a person. One arm that forgot "when:" would
# default to on_success, which is this job running on every push to main.
arms = [l.strip() for l in rules.splitlines() if l.strip().startswith("when:")]
assert arms and all(a in ("when: never", "when: manual") for a in arms), arms
assert len([l for l in rules.splitlines() if l.strip().startswith("- if:")]) == len(arms), rules
assert "when: manual" in rules and "allow_failure: true" in shots
# A release must not be able to reach it: not on a tag, not on a rehearsal, and not on a schedule.
for guard in ("$CI_COMMIT_TAG", "$CI_PIPELINE_SOURCE == \"schedule\"", "$RELEASE_DRY_RUN_VERSION"):
    arm = re.search(r"- if: %s\n\s+when: (\w+)" % re.escape(guard), rules)
    assert arm and arm.group(1) == "never", guard
assert "store/screenshots/*.png" in shots and "expire_in" in shots
PYEOF
# W-P4: the real release path stops at the About source-offer gate, before the upstream build, without store.source_url.
cp "$BT/thankmu/targets.json" "$TMP/targets.rel.keep"; "$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); del d["store"]["source_url"]; json.dump(d,open(sys.argv[1],"w"))' "$BT/thankmu/targets.json"
rm -rf "$BT/$UBO_PREFIX/dist/build/uBOLite.chromium"
expect_fail "release refuses a store build without store.source_url (GPLv3 source offer)" "has no source_url" -- release 1.2.5
[ ! -e "$BT/$UBO_PREFIX/dist/build/uBOLite.chromium" ] && ok "the source-offer gate fires before the upstream build" || bad "the source-offer gate fires before the upstream build"
cp "$TMP/targets.rel.keep" "$BT/thankmu/targets.json"

cp "$TMP/make-mv3.keep" "$MK"; chmod +x "$MK"

echo "== released source snapshot (scripts/ci/publish_source_snapshot.sh, W-P4 item 10) =="
# ADR-013 / EX-002 (a): one squashed commit of the released tree, tagged with the release version, pushed to the
# public source repo by the release job. Arguments and configuration first.
PS="$ROOT/scripts/ci/publish_source_snapshot.sh"
expect_fail "publish needs a version" "usage: publish_source_snapshot.sh" -- "$PS"
expect_fail "publish rejects a non-semver version" "usage: publish_source_snapshot.sh" -- "$PS" 1.2
expect_fail "publish rejects a tag-shaped version" "usage: publish_source_snapshot.sh" -- "$PS" chrome-v1.2.3
expect_fail "publish rejects two versions" "two versions given" -- "$PS" 1.2.3 1.2.4
expect_fail "publish rejects an unknown option" "unknown option" -- "$PS" --wet-run 1.2.3
for v in SNAPSHOT_REPO_URL SNAPSHOT_PUSH_TOKEN; do
  e=(SNAPSHOT_REPO_URL=https://h.test/s.git SNAPSHOT_PUSH_TOKEN=x)
  rest=(); for x in "${e[@]}"; do [ "${x%%=*}" = "$v" ] || rest+=("$x"); done
  expect_fail "publish fails without $v" "$v" -- env -u "$v" "${rest[@]}" "$PS" 1.2.3
done
expect_fail "publish refuses a non-https snapshot URL" "must be an https URL" -- \
  env SNAPSHOT_REPO_URL=http://elsewhere.test/s.git SNAPSHOT_PUSH_TOKEN=x "$PS" 1.2.3

# W-P4 item 10: the repo CI pushes to (SNAPSHOT_REPO_URL, a CI variable) and the repo the shipped
# package offers the source at (store.source_url) must be one repo. Nothing compared them before, and
# neither half can see the other, so a disagreement published the source where no reader is ever sent.
CS="$ROOT/scripts/check_snapshot_repo_url.py"
stu() { "$PY" -I -c 'import json,sys; json.dump({"store":{"source_url":sys.argv[1]}} if sys.argv[1] else {"store":{}}, open(sys.argv[2],"w"))' "$1" "$TMP/snap-t.json"; }
cs() { env SNAPSHOT_REPO_URL="$1" "$PY" -I "$CS" "$TMP/snap-t.json"; }
# One repo, spelled every way the two sides legitimately differ: the push URL carries ".git", the
# offer does not; either may carry a trailing slash; host case and "www." never change the repo.
# These must all pass, because a false alarm here fails the release job after the zip is built.
stu "https://src.test/thankmu/source"
for u in https://src.test/thankmu/source.git https://src.test/thankmu/source \
         https://src.test/thankmu/source/ https://SRC.test/thankmu/Source.git \
         https://www.src.test/thankmu/source.git http://src.test/thankmu/source.git; do
  cs "$u" >/dev/null && ok "snapshot target: '$u' is the same repo as the offer" \
    || bad "snapshot target: '$u' is the same repo as the offer" "$(cs "$u" 2>&1)"
done
# A genuinely different repo is the whole point, and the message has to name both sides.
expect_fail "snapshot target: another repo on the same host is refused" "source offer does not point" -- \
  env SNAPSHOT_REPO_URL=https://src.test/thankmu/other.git "$PY" -I "$CS" "$TMP/snap-t.json"
expect_fail "snapshot target: another host is refused" "source offer does not point" -- \
  env SNAPSHOT_REPO_URL=https://elsewhere.test/thankmu/source.git "$PY" -I "$CS" "$TMP/snap-t.json"
expect_fail "snapshot target: another owner on the same host is refused" "source offer does not point" -- \
  env SNAPSHOT_REPO_URL=https://src.test/someone-else/source.git "$PY" -I "$CS" "$TMP/snap-t.json"
expect_fail "snapshot target: a URL naming a host but no repo is refused" "no repository" -- \
  env SNAPSHOT_REPO_URL=https://src.test/ "$PY" -I "$CS" "$TMP/snap-t.json"
expect_fail "snapshot target: an unset variable is refused" "is not set" -- \
  env -u SNAPSHOT_REPO_URL "$PY" -I "$CS" "$TMP/snap-t.json"
# No offer to check against: a store release cannot happen without one, so this is an error, never a skip.
stu ""
expect_fail "snapshot target: a targets.json with no store.source_url is refused" "no store.source_url" -- \
  env SNAPSHOT_REPO_URL=https://src.test/thankmu/source.git "$PY" -I "$CS" "$TMP/snap-t.json"
printf '{"store": {"source_url": "https://src.test/x"' > "$TMP/snap-t.json"
expect_fail "snapshot target: a targets.json that is not valid JSON is refused" "not valid JSON" -- \
  env SNAPSHOT_REPO_URL=https://src.test/x.git "$PY" -I "$CS" "$TMP/snap-t.json"
# A credential accidentally left in SNAPSHOT_REPO_URL is tolerated by the comparison -- userinfo is
# ignored, so it cannot cause a false alarm -- and must therefore never be printed. The variable is
# Protected but not masked, and every message here goes to the job log, which outlives the job. Each
# failure path that prints a URL is covered, because the one that leaks is whichever was forgotten.
stu "https://src.test/thankmu/source"
for case in \
  "a mismatch|https://user:secret@src.test/thankmu/other.git" \
  "a host with no repo|https://user:secret@src.test/" \
  "an unusable port|https://user:secret@src.test:notaport/thankmu/other.git" \
  "a URL with no scheme|user:secret@src.test/thankmu/other.git" \
  "a URL urlsplit rejects|https://[user:secret@src.test/x.git"; do
  name="snapshot target: ${case%%|*} is refused without printing the credential"
  out="$(cs "${case#*|}" 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then bad "$name" "expected failure, got success"
  elif grep -q "secret" <<<"$out"; then bad "$name" "the credential reached the output"
  elif ! grep -q '[*][*][*]@src[.]test' <<<"$out"; then bad "$name" "the message does not name the host: $out"
  else ok "$name"; fi
done
# ...and it must not turn an otherwise-correct pair into a failure at the end of the release job.
cs "https://oauth2:secret@src.test/thankmu/source.git" >/dev/null 2>&1 \
  && ok "snapshot target: userinfo in the variable is not itself a mismatch" \
  || bad "snapshot target: userinfo in the variable is not itself a mismatch" "refused a matching pair"

# The real pair, as configured: whatever the CI variable says, it must agree with the tracked field.
# Checked here against the repo's own targets.json so a mismatch cannot reach a tag.
cs_real() { env SNAPSHOT_REPO_URL="$1" "$PY" -I "$CS" "$ROOT/thankmu/targets.json"; }
RSRC="$("$PY" -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["store"].get("source_url") or "")' "$RT")"
if [ -n "$RSRC" ]; then
  cs_real "$RSRC.git" >/dev/null && ok "snapshot target: the real store.source_url matches its own push URL spelling" \
    || bad "snapshot target: the real store.source_url matches its own push URL spelling" "$(cs_real "$RSRC.git" 2>&1)"
else
  ok "snapshot target: the real config has no source_url yet (nothing to compare)"
fi

# --preflight: these same checks, run before the build instead of after it. Every one of them would
# otherwise first be reached at the end of the release job, with the zip already built, where a
# refusal discards the artifact and spends the tag. It must touch no git repository.
if [ -n "$RSRC" ]; then
  out="$(env SNAPSHOT_REPO_URL="$RSRC.git" SNAPSHOT_PUSH_TOKEN=x "$PS" 1.2.3 --preflight 2>&1)" \
    && grep -q "preflight ok" <<<"$out" && ok "preflight passes on the real configuration" \
    || bad "preflight passes on the real configuration" "$out"
  grep -qE "^>> source snapshot of" <<<"$out" && bad "preflight builds nothing and publishes nothing" "$out" \
    || ok "preflight builds nothing and publishes nothing"
  expect_fail "preflight fails without the push token, before any build" "SNAPSHOT_PUSH_TOKEN" -- \
    env -u SNAPSHOT_PUSH_TOKEN SNAPSHOT_REPO_URL="$RSRC.git" "$PS" 1.2.3 --preflight
  expect_fail "preflight fails when the snapshot target disagrees with the offer" "source offer does not point" -- \
    env SNAPSHOT_REPO_URL=https://elsewhere.test/someone/source.git SNAPSHOT_PUSH_TOKEN=x "$PS" 1.2.3 --preflight
fi
expect_fail "preflight and dry-run cannot be combined" "mutually exclusive" -- "$PS" 1.2.3 --preflight --dry-run
# A rehearsal that has the variable checks the agreement too, and refuses before building the tree:
# with no tag in existence yet, that is the cheapest place a mismatch can possibly be caught.
expect_fail "a dry run with a disagreeing snapshot target fails" "source offer does not point" -- \
  env SNAPSHOT_REPO_URL=https://elsewhere.test/someone/source.git "$PS" 1.2.3 --dry-run

# A dry run over this very repo: no credential, no network, and it names the tree it would publish. This is what
# the release_chrome_dry_run job rehearses, so the real tree is exercised on every rehearsal.
out="$(env -u SNAPSHOT_REPO_URL -u SNAPSHOT_PUSH_TOKEN "$PS" 9.9.9 --dry-run 2>&1)" \
  && grep -q "Nothing was pushed" <<<"$out" && ok "a dry run over this repo needs no credential and pushes nothing" \
  || bad "a dry run over this repo needs no credential and pushes nothing" "$out"
# With no variable there is nothing to compare the offer against. It says so, rather than passing in
# silence: a skipped check that reads like a passed one is how the mismatch stayed invisible.
grep -q "SNAPSHOT_REPO_URL is not set, so the source offer was not checked" <<<"$out" \
  && ok "a dry run without the variable says the offer was not checked against it" \
  || bad "a dry run without the variable says the offer was not checked against it" "$out"
SNAP_TREE="$(sed -n 's/^>> tree \([0-9a-f]\{40\}\):.*/\1/p' <<<"$out")"
if [ -z "$SNAP_TREE" ]; then bad "the dry run names the tree it would publish" "$out"; else
  ok "the dry run names the tree it would publish"
  snap_paths="$(git -C "$ROOT" ls-tree -r --name-only "$SNAP_TREE")"
  grep -qE '^(docs|store|builds)/' <<<"$snap_paths" \
    && bad "the snapshot holds back docs/, store/ and builds/ (our reasoning and store paperwork)" \
    || ok "the snapshot holds back docs/, store/ and builds/ (our reasoning and store paperwork)"
  miss=""
  for p in NOTICE .nvmrc .gitlab-ci.yml chrome_plugin/LICENSE.txt chrome_plugin/platform/mv3/chromium/manifest.json \
           scripts/build_chrome.sh thankmu/patch_extension.py thankmu/targets.json thankmu/ext/js/thankmu/sw.js; do
    grep -qxF "$p" <<<"$snap_paths" || miss="$miss $p"
  done
  [ -z "$miss" ] && ok "the snapshot carries the licence, the ThankMu layer and the build scripts" \
    || bad "the snapshot carries the licence, the ThankMu layer and the build scripts" "missing:$miss"
  git -C "$ROOT" show "$SNAP_TREE:README.md" > "$TMP/snap-readme.md" 2>/dev/null
  [ "$(git -C "$ROOT" rev-parse "$SNAP_TREE:README.md")" != "$(git -C "$ROOT" rev-parse "HEAD:README.md")" ] \
    && ok "the published README is the generated one, not the development README" \
    || bad "the published README is the generated one, not the development README"
  grep -q "9\.9\.9" "$TMP/snap-readme.md" && grep -q "chrome-v9.9.9" "$TMP/snap-readme.md" \
    && grep -q "developed privately" "$TMP/snap-readme.md" \
    && ok "the generated README names the release and says development happens elsewhere" \
    || bad "the generated README names the release and says development happens elsewhere" "$(cat "$TMP/snap-readme.md")"
  grep -qiE "premium-ab|minorrepo|majorrepo|git\.draglabs\.com" "$TMP/snap-readme.md" \
    && bad "the generated README names no private repo or host" \
    || ok "the generated README names no private repo or host"
  # One tag publishes this source once, and it is the corresponding source of every package that tag
  # builds. The front page has to say so, or the alpha zip carries a licence offer pointing at a page
  # that only admits to the store zip.
  SNAP_PKG="$("$PY" -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["package_name"])' "$ROOT/thankmu/brand.json")"
  snap_missing=""
  for z in "${SNAP_PKG}_9.9.9.zip" "${SNAP_PKG}_alpha_9.9.9.zip"; do
    grep -qF "$z" "$TMP/snap-readme.md" || snap_missing="$snap_missing $z"
  done
  [ -z "$snap_missing" ] && ok "the generated README names every package the tag builds" \
    || bad "the generated README names every package the tag builds" "missing:$snap_missing"
fi

# The push itself, against the same fake authenticated git server the mirror job uses, from a small fixture release
# tree: real refs on a real remote, and the guards are reachable without pushing a thousand upstream files per case.
SFX="$TMP/snapfix"
mkdir -p "$SFX/scripts/ci" "$SFX/chrome_plugin/platform/mv3/chromium" "$SFX/thankmu" "$SFX/docs" "$SFX/store" "$SFX/builds"
cp "$ROOT/scripts/lib.sh" "$SFX/scripts/"
cp "$ROOT/scripts/ci/publish_source_snapshot.sh" "$SFX/scripts/ci/"
# The publish script calls this one to compare the push URL with the shipped source offer, so the
# fixture release tree needs it too (it resolves it under its own root, not this repo's).
cp "$ROOT/scripts/check_snapshot_repo_url.py" "$SFX/scripts/"
# The generated README names every package the tag builds, and reads that list from the one place it
# is defined, so the fixture needs the real module and not a stub of it.
cp "$ROOT/thankmu/patch_extension.py" "$SFX/thankmu/"
cp "$ROOT/thankmu/brand.json" "$SFX/thankmu/"
chmod +x "$SFX/scripts/ci/publish_source_snapshot.sh"
for f in scripts/build_chrome.sh scripts/verify_chrome_package.sh scripts/ci/docker_build_chrome.sh \
         scripts/ci/Dockerfile.chrome-build thankmu/patch.json thankmu/targets.json \
         chrome_plugin/LICENSE.txt chrome_plugin/platform/mv3/chromium/manifest.json NOTICE .nvmrc .gitlab-ci.yml; do
  printf 'stub: %s\n' "$f" > "$SFX/$f"
done
printf 'how we decided it (private)\n' > "$SFX/docs/rebrand.md"
printf 'store listing draft (private)\n' > "$SFX/store/chrome-web-store.md"
printf 'local build landing\n' > "$SFX/builds/README.md"
printf 'development readme, links into the tracking parent\n' > "$SFX/README.md"
git init -q "$SFX" && git -C "$SFX" add -A && gq -C "$SFX" commit -qm "release tree"
git init -q --bare "$TMP/srv/snapshot.git"
T_SNAP=tok-snap-eee
"$PY" "$ROOT/tests/fake_git_http.py" "$TMP/srv" "$TMP/port2" "$TMP/srv2.log" snapshot.git=$T_SNAP & SRV2=$!
trap 'kill $SRV $SRV2 2>/dev/null; rm -rf "$TMP"' EXIT
for _ in $(seq 50); do [ -s "$TMP/port2" ] && break; sleep 0.1; done
SNAP_URL="http://127.0.0.1:$(cat "$TMP/port2")/snapshot.git"
SR="$TMP/srv/snapshot.git"
# The publish step now checks SNAPSHOT_REPO_URL against store.source_url, so the fixture needs a real
# targets.json naming this server. It is written the way the *field* is spelled, not the way the
# *variable* is -- no ".git", with a trailing slash -- so every push below also exercises the
# normalisation that lets one repo be spelled two ways (the real pair differs exactly like this).
snap_targets() { # $1 = marker, so a later release has a different tree; $2 = source_url override
  "$PY" -I -c 'import json,sys; json.dump({"_fixture": sys.argv[2], "store": {"source_url": sys.argv[1]}}, open(sys.argv[3], "w"))' \
    "${2:-${SNAP_URL%.git}/}" "$1" "$SFX/thankmu/targets.json"
}
snap_targets "release one"
( cd "$SFX" && git add -A && gq commit -qm "targets for the snapshot fixture" )
publish() { # <token> <args...>
  local tok="$1"; shift
  env -i PATH="$PATH" HOME="$TMP" SNAPSHOT_REPO_URL="$SNAP_URL" SNAPSHOT_PUSH_TOKEN="$tok" \
    "$SFX/scripts/ci/publish_source_snapshot.sh" "$@" 2>&1
}

out="$(publish wrong-token 1.0.0)" && bad "publish with a wrong token fails" \
  || { grep -q "cannot read the public source repo" <<<"$out" && ok "publish with a wrong token fails, and says which credential to check" \
       || bad "publish with a wrong token fails, and says which credential to check" "$out"; }
# The first release goes into an empty public repo: there is no branch to be the parent yet.
[ -z "$(git -C "$SR" for-each-ref)" ] && ok "the public repo starts empty" || bad "the public repo starts empty"
out="$(publish $T_SNAP 1.0.0)" || bad "publishing 1.0.0 succeeds" "$out"
grep -q "published chrome-v1.0.0" <<<"$out" && ok "publishing 1.0.0 reports the tag it published" \
  || bad "publishing 1.0.0 reports the tag it published" "$out"
[ "$(git -C "$SR" rev-list --count refs/heads/main)" = 1 ] && ok "the public repo holds exactly one commit" \
  || bad "the public repo holds exactly one commit" "$(git -C "$SR" rev-list --count refs/heads/main 2>&1)"
[ "$(git -C "$SR" rev-parse refs/tags/chrome-v1.0.0)" = "$(git -C "$SR" rev-parse refs/heads/main)" ] \
  && ok "chrome-v1.0.0 tags that commit" || bad "chrome-v1.0.0 tags that commit"
[ "$(git -C "$SR" log -1 --format=%an refs/heads/main)" = "ThankMu release" ] \
  && ok "the snapshot commit is by the release identity, not a developer" \
  || bad "the snapshot commit is by the release identity, not a developer" "$(git -C "$SR" log -1 --format=%an refs/heads/main)"
pub_paths="$(git -C "$SR" ls-tree -r --name-only refs/heads/main)"
grep -qE '^(docs|store|builds)/' <<<"$pub_paths" && bad "the published tree holds back the private paths" "$pub_paths" \
  || ok "the published tree holds back the private paths"
grep -qxF chrome_plugin/LICENSE.txt <<<"$pub_paths" && grep -qxF thankmu/patch_extension.py <<<"$pub_paths" \
  && ok "the published tree carries the licence and the layer" || bad "the published tree carries the licence and the layer" "$pub_paths"
git -C "$SR" show refs/heads/main:README.md | grep -q "1\.0\.0" \
  && ok "the published README names the release" || bad "the published README names the release"
# Re-running the job (a CI retry) must not add a commit or move anything.
out="$(publish $T_SNAP 1.0.0)" || bad "re-publishing the same release succeeds"
grep -q "already published" <<<"$out" && [ "$(git -C "$SR" rev-list --count refs/heads/main)" = 1 ] \
  && ok "re-publishing the same release is a no-op" || bad "re-publishing the same release is a no-op" "$out"
# A dry run never pushes, even with the credential in the environment.
before="$(git -C "$SR" rev-parse refs/heads/main)"
out="$(publish $T_SNAP 1.3.0 --dry-run)" || bad "a dry run with the credential present succeeds" "$out"
[ "$(git -C "$SR" rev-parse refs/heads/main)" = "$before" ] && grep -q "Nothing was pushed" <<<"$out" \
  && ok "a dry run pushes nothing even with the credential present" || bad "a dry run pushes nothing even with the credential present" "$out"
# The next release is one more commit on top of the last, so the public side is a list of releases and nothing else.
( cd "$SFX" && snap_targets "release two" && git add -A && gq commit -qm r2 )
out="$(publish $T_SNAP 1.1.0)" || bad "publishing a second release succeeds" "$out"
[ "$(git -C "$SR" rev-list --count refs/heads/main)" = 2 ] && ok "the second release adds exactly one commit" \
  || bad "the second release adds exactly one commit" "$(git -C "$SR" rev-list --count refs/heads/main)"
[ "$(git -C "$SR" rev-parse 'refs/heads/main^')" = "$(git -C "$SR" rev-parse refs/tags/chrome-v1.0.0)" ] \
  && ok "its parent is the previous release" || bad "its parent is the previous release"
# A published release is never rewritten: the same tag over a changed tree fails and leaves the public repo alone.
( cd "$SFX" && printf 'changed after the release\n' > NOTICE && git add -A && gq commit -qm r2b )
before="$(git -C "$SR" rev-parse refs/heads/main)"
out="$(publish $T_SNAP 1.1.0)" && bad "republishing a tag over a different tree fails" \
  || { grep -q "already exists in the public source repo with a different tree" <<<"$out" \
       && ok "republishing a tag over a different tree fails" || bad "republishing a tag over a different tree fails" "$out"; }
[ "$(git -C "$SR" rev-parse refs/heads/main)" = "$before" ] && [ "$(git -C "$SR" rev-list --count refs/heads/main)" = 2 ] \
  && ok "the refusal left the public repo untouched" || bad "the refusal left the public repo untouched"
# The token never reaches the output or git config (the mirror job's rule, same credential helper).
grep -q "$T_SNAP" <<<"$out" && bad "publish does not leak the token to its output" || ok "publish does not leak the token to its output"
grep -rqs "$T_SNAP" "$SFX/.git/config" "$TMP/.gitconfig" && bad "publish writes no token into git config" || ok "publish writes no token into git config"
# Both guards: the snapshot must be the complete corresponding source, and must never carry agent state or env files.
before="$(git -C "$SR" rev-parse refs/heads/main)"
( cd "$SFX" && git rm -q chrome_plugin/LICENSE.txt && gq commit -qm "lost the licence" )
expect_fail "publish refuses a tree missing the licence" "not the complete corresponding source" -- publish $T_SNAP 1.2.0
( cd "$SFX" && gq checkout -q 'HEAD@{1}' -- chrome_plugin/LICENSE.txt && printf 'SECRET=x\n' > .env && git add -A && gq commit -qm "stray env file" )
expect_fail "publish refuses a tree carrying a .env file" "must never be published" -- publish $T_SNAP 1.2.0
[ "$(git -C "$SR" rev-parse refs/heads/main)" = "$before" ] && ok "neither guard pushed anything" || bad "neither guard pushed anything"
kill $SRV2 2>/dev/null
[ ! -s "$TMP/srv2.log" ] && ok "the fake git server saw no backend failures (snapshot pushes)" \
  || bad "the fake git server saw no backend failures (snapshot pushes)" "$(cat "$TMP/srv2.log")"

echo "== builds/ landing (scripts/land_build.sh via build_chrome.sh) =="
nvmrc $'22\n'
BD="$BT/builds"; rm -rf "$BD"
bt_build() { env -u CI -u BUILDS_KEEP PATH="$TMP/fakebin:$PATH" FAKE_NODE_MAJOR=22 BUILD_SHORTSHA="${SHA:-abc1234}" "$@" "$BT/scripts/build_chrome.sh" ${VER:+"$VER"}; }
# Failure lands nothing: a failed verification (stub verify exits 1), then a failed config check.
cp "$BT/scripts/verify_chrome_package.sh" "$TMP/verify.keep"; printf '#!/bin/sh\necho verify-boom >&2; exit 1\n' > "$BT/scripts/verify_chrome_package.sh"
expect_fail "a failed verification fails the build" "verify-boom" -- build_with 22
cp "$TMP/verify.keep" "$BT/scripts/verify_chrome_package.sh"; chmod +x "$BT/scripts/verify_chrome_package.sh"
[ -z "$(ls -A "$BD" 2>/dev/null)" ] && ok "a failed verification lands nothing" || bad "a failed verification lands nothing" "$(find "$BD")"
rm "$BT/thankmu/targets.json"; build_with 22 >/dev/null 2>&1 || true; cp "$TMP/targets.keep" "$BT/thankmu/targets.json"
[ -z "$(ls -A "$BD" 2>/dev/null)" ] && ok "a failed build lands nothing" || bad "a failed build lands nothing"
# Success lands unpacked/ + zip under builds/dev/<version>-<sha>/ and points latest at it.
SHA=aaaaaaa bt_build env >"$TMP/l.out" 2>&1 || bad "dev build lands" "$(tail -5 "$TMP/l.out")"
dv="$("$PY" -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$BT/$UBO_PREFIX/dist/build/uBOLite.chromium/manifest.json")"
D1="$BD/dev/$dv-aaaaaaa"
[ -f "$D1/unpacked/manifest.json" ] && [ -s "$D1/thankmu_chromium_dev_$dv-aaaaaaa.zip" ] && ok "successful dev build lands unpacked/ and the zip" || bad "successful dev build lands unpacked/ and the zip" "$(find "$BD" | head -20)"
grep -q '"short_name": "ThankMu"' "$D1/unpacked/manifest.json" && [ ! -e "$D1/unpacked/log.txt" ] && ok "landed copy is the patched package" || bad "landed copy is the patched package"
[ -L "$BD/dev/latest" ] && [ "$(readlink "$BD/dev/latest")" = "$dv-aaaaaaa" ] && ok "latest is a relative symlink to the build" || bad "latest is a relative symlink to the build" "$(readlink "$BD/dev/latest")"
[ -d "$BD/dev/current" ] && [ ! -L "$BD/dev/current" ] && diff -r "$BD/dev/current" "$D1/unpacked" >/dev/null && ok "current is a real dir matching the newest build" || bad "current is a real dir matching the newest build"
# A failed build leaves current untouched.
cp "$BT/scripts/verify_chrome_package.sh" "$TMP/verify.keep"; printf '#!/bin/sh\nexit 1\n' > "$BT/scripts/verify_chrome_package.sh"
echo marker > "$BD/dev/current/marker"; ( SHA=ddddddd; build_with 22 >/dev/null 2>&1 ) || true
cp "$TMP/verify.keep" "$BT/scripts/verify_chrome_package.sh"; chmod +x "$BT/scripts/verify_chrome_package.sh"
[ -f "$BD/dev/current/marker" ] && [ "$(ls -d "$BD"/dev/"$dv"-* | wc -l | tr -d ' ')" = 1 ] && ok "a failed build leaves current untouched" || bad "a failed build leaves current untouched"
rm -f "$BD/dev/current/marker"
# Release build lands under store/ (the fixture manifest carries version $dv whatever X.Y.Z is asked for) with the real release zip.
SHA=bbbbbbb VER=1.2.3 bt_build env >/dev/null 2>&1 || bad "release build lands"
[ -s "$BD/store/$dv-bbbbbbb/thankmu_chromium_store_$dv-bbbbbbb.zip" ] && [ -f "$BD/store/$dv-bbbbbbb/unpacked/manifest.json" ] && [ "$(readlink "$BD/store/latest")" = "$dv-bbbbbbb" ] && ok "release build lands under store/" || bad "release build lands under store/" "$(find "$BD/store" | head)"
cmp -s "$BD/store/$dv-bbbbbbb/thankmu_chromium_store_$dv-bbbbbbb.zip" "$BT/$UBO_PREFIX/dist/build/thankmu_chromium_1.2.3.zip" && ok "landed store zip is the release zip" || bad "landed store zip is the release zip"
# CI choice: skipped when CI is set; release artifacts unchanged.
rm -rf "$BD"; mkdir "$BD"
env CI=true PATH="$TMP/fakebin:$PATH" FAKE_NODE_MAJOR=22 BUILD_SHORTSHA=abc1234 "$BT/scripts/build_chrome.sh" >"$TMP/ci.out" 2>&1 && [ -z "$(ls -A "$BD")" ] && grep -q "Landing skipped: CI is set" "$TMP/ci.out" && ok "CI set: build succeeds and lands nothing" || bad "CI set: build succeeds and lands nothing" "$(tail -3 "$TMP/ci.out")"
# Direct land_build.sh: pruning, latest, containment, symlinks, input checks.
LB="$BT/scripts/land_build.sh"; PKGD="$BT/$UBO_PREFIX/dist/build/uBOLite.chromium"
rm -rf "$BD"; mkdir "$BD"; mkdir -p "$TMP/outside" && echo keep > "$TMP/outside/sentinel"
land() { env -u CI PATH="$TMP/fakebin:$PATH" BUILD_SHORTSHA="$1" ${2:+BUILDS_KEEP=$2} "$LB" dev "$PKGD"; }
mkdir -p "$BD/dev"; ln -s "$TMP/outside" "$BD/dev/9.9.9-ccccccc"; mkdir "$BD/dev/not-a-build"
for i in 1 2 3 4 5; do land "000000$i" 3 >"$TMP/p.out" 2>&1 || bad "land $i" "$(cat "$TMP/p.out")"; touch -t "20200101000$i" "$BD/dev/$dv-000000$i" 2>/dev/null; done
land 0000009 3 >"$TMP/p.out" 2>&1 || bad "land with pruning" "$(cat "$TMP/p.out")"
left="$(cd "$BD/dev" && ls -d "$dv"-* | tr '\n' ' ')"
[ "$left" = "$dv-0000004 $dv-0000005 $dv-0000009 " ] && ok "pruning keeps the newest BUILDS_KEEP builds" || bad "pruning keeps the newest BUILDS_KEEP builds" "$left"
[ -d "$BD/dev/current" ] && [ ! -L "$BD/dev/current" ] && diff -r "$BD/dev/current" "$BD/dev/$dv-0000009/unpacked" >/dev/null && ok "pruning skips current, which holds the newest build" || bad "pruning skips current, which holds the newest build"
[ "$(readlink "$BD/dev/latest")" = "$dv-0000009" ] && ok "latest follows the newest landed build" || bad "latest follows the newest landed build"
[ -d "$BD/dev/$dv-0000009" ] && [ -f "$TMP/outside/sentinel" ] && [ -L "$BD/dev/9.9.9-ccccccc" ] && [ -d "$BD/dev/not-a-build" ] && ok "pruning never follows symlinks or touches non-build entries" || bad "pruning never follows symlinks or touches non-build entries"
rm -rf "$BD"; mkdir "$BD"; for i in 1 2 3 4 5 6 7 8 9 10 11 12; do land "$(printf '%07d' "$i")" >"$TMP/p.out" 2>&1 || bad "land $i of 12" "$(cat "$TMP/p.out")"; touch -t "2020010100$(printf '%02d' "$i")" "$BD/dev/$dv-$(printf '%07d' "$i")"; done
[ "$(ls -d "$BD"/dev/"$dv"-* | wc -l | tr -d ' ')" = 10 ] && ok "default keeps the newest 10 per target" || bad "default keeps the newest 10 per target" "$(ls "$BD/dev")"
# Nothing lands outside builds/: snapshot the tree (minus builds/) around a landing.
find "$BT" -path "$BD" -prune -o -print | sort > "$TMP/before.txt"; find "$BT" -path "$BD" -prune -o -type f -exec cksum {} + 2>/dev/null | sort > "$TMP/before.ck"
land 0000099 >"$TMP/c.out" 2>&1 && ok "containment landing succeeded" || bad "containment landing succeeded" "$(cat "$TMP/c.out")"
find "$BT" -path "$BD" -prune -o -print | sort > "$TMP/after.txt"; find "$BT" -path "$BD" -prune -o -type f -exec cksum {} + 2>/dev/null | sort > "$TMP/after.ck"
cmp -s "$TMP/before.txt" "$TMP/after.txt" && cmp -s "$TMP/before.ck" "$TMP/after.ck" && ok "landing writes nothing outside builds/" || bad "landing writes nothing outside builds/"
[ -d "$BD/dev/$dv-0000099" ] && [ -z "$(find "$BD" -name '.stage.*' -o -name '.current.*')" ] && ok "no staging leftovers" || bad "no staging leftovers"
expect_fail "land rejects an unknown target" "not in thankmu/targets.json" -- env -u CI BUILD_SHORTSHA=abc1234 "$LB" ../x "$PKGD"
expect_fail "land rejects a bad sha" "BUILD_SHORTSHA" -- env -u CI BUILD_SHORTSHA='../..' "$LB" dev "$PKGD"
expect_fail "land needs a sha" "BUILD_SHORTSHA is not set" -- env -u CI -u BUILD_SHORTSHA "$LB" dev "$PKGD"
expect_fail "land rejects a bad BUILDS_KEEP" "BUILDS_KEEP" -- env -u CI BUILD_SHORTSHA=abc1234 BUILDS_KEEP=0 "$LB" dev "$PKGD"
# latest as a real directory is refused, not written into.
rm -rf "$BD"; mkdir -p "$BD/dev/latest"
expect_fail "land refuses a real directory named latest" "not a symlink" -- env -u CI PATH="$TMP/fakebin:$PATH" BUILD_SHORTSHA=abc1234 "$LB" dev "$PKGD"
[ -z "$(ls -A "$BD/dev/latest")" ] && ok "nothing written inside a real latest directory" || bad "nothing written inside a real latest directory"
# An interrupted swap restores current/ instead of deleting it: a stub mv fails the second rename.
rm -rf "$BD"; land 0000001 >/dev/null 2>&1; echo old > "$BD/dev/current/marker"
mkdir -p "$TMP/failmv"; printf '#!/bin/sh\nfor a in "$@"; do case "$a" in *.current.new.*) echo mv-boom >&2; exit 1;; esac; done\nexec "%s" "$@"\n' "$(command -v mv)" > "$TMP/failmv/mv"; chmod +x "$TMP/failmv/mv"
out="$(env -u CI PATH="$TMP/failmv:$TMP/fakebin:$PATH" BUILD_SHORTSHA=0000002 "$LB" dev "$PKGD" 2>&1)" && bad "interrupted swap fails the run" || { grep -q mv-boom <<<"$out" && ok "interrupted swap fails the run" || bad "interrupted swap fails the run" "$out"; }
[ -f "$BD/dev/current/marker" ] && [ -z "$(find "$BD" -name '.current.*')" ] && ok "interrupted swap restores the old current/" || bad "interrupted swap restores the old current/" "$(ls -A "$BD/dev")"
# A SIGKILLed run leaves .current.old.*; the next run restores it (current missing) and sweeps the rest.
rm -rf "$BD/dev/current"; mkdir -p "$BD/dev/.current.old.999" "$BD/dev/.current.new.999" "$BD/dev/.stage.zzz"; echo old > "$BD/dev/.current.old.999/marker"
land 0000003 >"$TMP/s.out" 2>&1 && [ -z "$(find "$BD" -name '.stage.*' -o -name '.current.*')" ] && ok "next run sweeps stale staging dirs" || bad "next run sweeps stale staging dirs" "$(cat "$TMP/s.out")"
[ -d "$BD/dev/current" ] && diff -r "$BD/dev/current" "$BD/dev/$dv-0000003/unpacked" >/dev/null && ok "after the sweep current/ holds the new build" || bad "after the sweep current/ holds the new build"
rm -rf "$BD/dev/current" "$BD/dev/latest"; mkdir -p "$BD/dev/.current.old.999"; echo old > "$BD/dev/.current.old.999/marker"
env -u CI PATH="$TMP/failmv:$TMP/fakebin:$PATH" BUILD_SHORTSHA=0000004 "$LB" dev "$PKGD" >/dev/null 2>&1 || true
[ -f "$BD/dev/current/marker" ] && ok "a stale .current.old is restored when current is missing" || bad "a stale .current.old is restored when current is missing"
rm -rf "$BD"; mkdir "$BD"; ln -s "$TMP/outside" "$BD/dev"
expect_fail "land refuses a symlinked target dir" "symlink" -- env -u CI PATH="$TMP/fakebin:$PATH" BUILD_SHORTSHA=abc1234 "$LB" dev "$PKGD"
[ ! -e "$TMP/outside/latest" ] && ok "nothing written through a symlinked target dir" || bad "nothing written through a symlinked target dir"
rm -rf "$BD"
git -C "$ROOT" check-ignore -q builds/dev/latest && ! git -C "$ROOT" check-ignore -q builds/README.md && [ -f "$ROOT/builds/README.md" ] && ok "builds/ is gitignored except its README" || bad "builds/ is gitignored except its README"

echo "== Store assets (W-P4 part C): final icons, dev name, icon check =="
IC="$ROOT/tests/fixtures/icons"
grep -q 'class="coin"' "$ROOT/thankmu/icon.svg" && grep -q 'class="bg"' "$ROOT/thankmu/icon.svg" && ! grep -qi '<text' "$ROOT/thankmu/icon.svg" && ok "thankmu/icon.svg is the final D1 tip-jar mark (plate, glyph, coin), not the TM monogram" || bad "thankmu/icon.svg is the final D1 tip-jar mark"
"$PY" -I - "$ROOT" <<'PYE' && ok "real targets.json: dev is 'ThankMu Dev' with its own icon stylesheets, store keeps the brand name and the normal set" || bad "real targets.json: dev name and icon stylesheets"
import json, sys
root = sys.argv[1]
t = json.load(open(f"{root}/thankmu/targets.json")); b = json.load(open(f"{root}/thankmu/brand.json"))
assert t["dev"]["brand"] == {"name": "ThankMu Dev", "short_name": "ThankMu Dev"}, t["dev"]
assert "brand" not in t["store"] and "icon_css" not in t["store"] and b["name"] == "ThankMu" == b["short_name"]
assert set(t["dev"]["icon_css"]) == {"on", "off"}
css = [open(f"{root}/{t['dev']['icon_css'][s]}").read() for s in ("on", "off")]
assert css[0] != css[1] and all(".bg" in c for c in css)
PYE
same=""
for f in icon_16 icon_16_off icon_32 icon_32_off icon_64 icon_64_off icon_128 icon_128_off icon_512; do
  [ -s "$IC/dev/$f.png" ] && [ -s "$IC/store/$f.png" ] || same="$same missing:$f"
  cmp -s "$IC/dev/$f.png" "$IC/store/$f.png" && same="$same $f"
done
[ -z "$same" ] && ok "reference icon sets exist for dev and store, and every file differs between them" || bad "reference icons: dev and store sets must exist and differ in every file" "$same"
bad_state=""
for t in dev store; do for s in 16 32 64 128; do cmp -s "$IC/$t/icon_$s.png" "$IC/$t/icon_${s}_off.png" && bad_state="$bad_state $t/$s"; done; done
[ -z "$bad_state" ] && ok "reference icons: the off state differs from the on state in both targets" || bad "reference icons: off state must differ from on" "$bad_state"

# the store listing summary is the manifest description, within the store's 132 characters
"$PY" -I - "$ROOT" <<'PYE' && ok "store listing summary equals the manifest description (brand.json) and is at most 132 characters, in dollars and tips" || bad "store listing summary matches brand.json"
import json, re, sys
root = sys.argv[1]
d = json.load(open(f"{root}/thankmu/brand.json"))["description"]
md = open(f"{root}/store/chrome-web-store.md", encoding="utf8").read()
m = re.search(r"\*\*Summary\*\*[^\n]*\n\n> ([^\n]+)", md)
assert m and m.group(1) == d, (m and m.group(1), d)
assert len(d) <= 132, len(d)
assert re.search(r"this is %d," % len(d), md), "the listing states the wrong length"
for w in ("token", "points", "crypto", "hearts"):
    assert w not in d.lower(), w
PYE

# patch step with a dev target that renames and restyles (fixture targets + the real dev brand/icon_css)
tq "$FX/thankmu/targets.json" "$TMP/t-devbrand.json" 'd["dev"]["brand"]={"name":"ThankMu Dev","short_name":"ThankMu Dev"}; d["dev"]["icon_css"]={"on":"thankmu/icons/dev.css","off":"thankmu/icons/dev-off.css"}'
: > "$TMP/rsvg.log"; rm -f "$TMP/rsvg.log.css"; fresh pdv
patch_cmd "$TMP/pdv" "$FX/thankmu/brand.json" "$FX/thankmu/patch.json" dev "$TMP/t-devbrand.json" >/dev/null 2>"$TMP/patch.err" && ok "patch step runs for a renamed, restyled dev target" || bad "patch step runs for a renamed, restyled dev target" "$(cat "$TMP/patch.err")"
"$PY" -I - "$TMP/pdv" <<'PYE' && ok "dev build is named 'ThankMu Dev' in the manifest, every locale, and the About logo" || bad "dev build is named 'ThankMu Dev' in the manifest, locales and About"
import json, sys
p = sys.argv[1]
m = json.load(open(f"{p}/manifest.json"))
assert m["short_name"] == "ThankMu Dev" and m["name"] == "__MSG_extName__", m
for loc in ("en", "pl"):
    d = json.load(open(f"{p}/_locales/{loc}/messages.json"))
    assert d["extName"]["message"] == "ThankMu Dev", d["extName"]
h = open(f"{p}/dashboard.html", encoding="utf8").read()
assert 'alt="ThankMu Dev"' in h
PYE
dc="$(cat "$ROOT/thankmu/icons/dev.css")"; doc="$(cat "$ROOT/thankmu/icons/dev-off.css")"
grep -qxF "icon_16.png $dc" "$TMP/rsvg.log.css" && grep -qxF "icon_16_off.png $doc" "$TMP/rsvg.log.css" && grep -qxF "icon_512.png $dc" "$TMP/rsvg.log.css" && ok "dev rasterizes the on state with dev.css and the off state with dev-off.css" || bad "dev rasterizes with its own stylesheets" "$(cat "$TMP/rsvg.log.css")"
[ "$(grep -c -- '--stylesheet' "$TMP/rsvg.log")" = "$(grep -c -- '-w ' "$TMP/rsvg.log")" ] && ok "every dev icon (on and off) is restyled" || bad "every dev icon is restyled"
chk_brand "$TMP/pdv" "$FX/thankmu/patch.json" "$TMP/t-devbrand.json" target=dev >/dev/null 2>"$TMP/e" && ok "brand scan passes on the dev build and requires the dev names" || bad "brand scan passes on the dev build" "$(cat "$TMP/e")"
"$PY" -I "$ROOT/scripts/check_blocking_unchanged.py" "$FX/pkg" "$TMP/pdv" brand="$FX/thankmu/brand.json" patch="$FX/thankmu/patch.json" targets="$TMP/t-devbrand.json" target=dev >/dev/null 2>"$TMP/e" && ok "blocking-unchanged passes on the renamed dev build" || bad "blocking-unchanged passes on the renamed dev build" "$(cat "$TMP/e")"
fresh pdv2; patch_cmd "$TMP/pdv2" "$FX/thankmu/brand.json" "$FX/thankmu/patch.json" dev "$FX/thankmu/targets.json" >/dev/null 2>&1
chk_brand "$TMP/pdv2" "$FX/thankmu/patch.json" "$TMP/t-devbrand.json" target=dev >/dev/null 2>&1 && bad "brand scan refuses a dev build that kept the store name" || ok "brand scan refuses a dev build that kept the store name"

# config validation: loud and early
tq "$RT" "$TMP/t-nocss.json" 'd["dev"]["icon_css"]["off"]="thankmu/icons/nope.css"'
expect_fail "a declared icon stylesheet that is missing fails the build config" "icon stylesheet missing: thankmu/icons/nope.css" -- chk_cfg "$TMP/t-nocss.json"
: > "$TMP/empty.css"; tq "$RT" "$TMP/t-emptycss.json" 'd["dev"]["icon_css"]["on"]="thankmu/icons/empty.css"'
cp "$TMP/empty.css" "$ROOT/thankmu/icons/empty.css"; expect_fail "an empty icon stylesheet fails the build config" "icon stylesheet is empty" -- chk_cfg "$TMP/t-emptycss.json"; rm -f "$ROOT/thankmu/icons/empty.css"
tq "$RT" "$TMP/t-badstate.json" 'd["dev"]["icon_css"]["loading"]="thankmu/icons/dev.css"'; expect_fail "an unknown icon state fails the build config" "icon_css must be a non-empty object" -- chk_cfg "$TMP/t-badstate.json"
tq "$RT" "$TMP/t-abscss.json" 'd["dev"]["icon_css"]["on"]="/etc/passwd"';  expect_fail "an absolute icon stylesheet path fails" "repo-relative" -- chk_cfg "$TMP/t-abscss.json"
tq "$RT" "$TMP/t-upcss.json" 'd["dev"]["icon_css"]["on"]="../x.css"';      expect_fail "a parent-relative icon stylesheet path fails" "repo-relative" -- chk_cfg "$TMP/t-upcss.json"
tq "$RT" "$TMP/t-badbrand.json" 'd["dev"]["brand"]={"author":"x"}';        expect_fail "a target brand override of another key fails" "brand must be a non-empty object" -- chk_cfg "$TMP/t-badbrand.json"
tq "$RT" "$TMP/t-emptybrand.json" 'd["dev"]["brand"]={"name":" "}';        expect_fail "a blank target brand name fails" "brand.name must be a non-empty string" -- chk_cfg "$TMP/t-emptybrand.json"

# scripts/check_icons.py on a synthetic package: upstream's art vs the reference set
mkpkg_icons() { # <dir> <src-ref-dir|-> : img/ with every upstream icon name; refs copied from <src>
  rm -rf "$1"; mkdir -p "$1/img"
  if [ "$2" = - ]; then for f in icon_16 icon_16_off icon_32 icon_32_off icon_64 icon_64_off icon_128 icon_128_off icon_512; do printf 'upstream-%s' "$f" > "$1/img/$f.png"; done
  else cp "$2"/*.png "$1/img/"; fi
}
chk_icons() { "$PY" -I "$ROOT/scripts/check_icons.py" "$TMP/iu" "$TMP/ip" "$@"; }
mkpkg_icons "$TMP/iu" -; mkpkg_icons "$TMP/ip" "$IC/dev"
chk_icons target=dev >/dev/null 2>"$TMP/e" && ok "icon check passes a package carrying the dev reference set" || bad "icon check passes the dev set" "$(cat "$TMP/e")"
expect_fail "icon check refuses the dev set in a store build" "differs from the store reference icon" -- chk_icons target=store
mkpkg_icons "$TMP/ip" "$IC/store"
chk_icons target=store >/dev/null 2>"$TMP/e" && ok "icon check passes a package carrying the store reference set" || bad "icon check passes the store set" "$(cat "$TMP/e")"
expect_fail "icon check refuses the store set in a dev build" "differs from the dev reference icon" -- chk_icons target=dev
cp "$TMP/iu/img/icon_64.png" "$TMP/ip/img/icon_64.png"
expect_fail "icon check refuses an icon left as upstream's" "img/icon_64.png: identical to upstream" -- chk_icons target=store
mkpkg_icons "$TMP/ip" "$IC/store"; printf 'placeholder TM' > "$TMP/ip/img/icon_128.png"
expect_fail "icon check refuses a placeholder where a reference exists" "img/icon_128.png: differs from the store reference" -- chk_icons target=store
for f in icon_64 icon_64_off icon_512; do
  mkpkg_icons "$TMP/ip" "$IC/store"; printf 'wrong art' > "$TMP/ip/img/$f.png"
  expect_fail "icon check refuses wrong art at $f" "img/$f.png: differs from the store reference" -- chk_icons target=store
done
mkpkg_icons "$TMP/ip" "$IC/dev"; printf 'wrong art' > "$TMP/ip/img/icon_64_off.png"
expect_fail "icon check refuses wrong art at icon_64_off (dev)" "img/icon_64_off.png: differs from the dev reference" -- chk_icons target=dev
mkpkg_icons "$TMP/ip" "$IC/store"; mkdir "$TMP/partrefs"; cp "$IC/store"/icon_16*.png "$TMP/partrefs/"; mkdir -p "$TMP/partrefs/store"; mv "$TMP/partrefs"/*.png "$TMP/partrefs/store/"
expect_fail "icon check refuses an upstream icon with no reference" "no reference render" -- chk_icons target=store refs="$TMP/partrefs"
mkpkg_icons "$TMP/ip" "$IC/store"; rm "$TMP/ip/img/icon_512.png"
expect_fail "icon check refuses a missing icon" "img/icon_512.png: missing or empty" -- chk_icons target=store
mkpkg_icons "$TMP/ip" "$IC/store"; mkdir "$TMP/emptyrefs"
expect_fail "icon check refuses a target without a reference set" "no reference icon set for target store" -- chk_icons target=store refs="$TMP/emptyrefs"
expect_fail "icon check refuses an unknown target" "unknown target" -- chk_icons target=nope

echo "== Design handoff (W-P4): store icon, tokens, no literal colours =="
# The handoff's MANIFEST.json hashes, copied here because CI has no parent checkout (mockups/docs/handoff/MANIFEST.json,
# approved 2026-10-30). To take a newer handoff: copy the files, then update these constants from its MANIFEST.json.
sha256_of() { "$PY" -I -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }
HANDOFF_STORE_PNG_SHA=d760e7e0c275d3223211abc87e919622e36bf1d83498a04ac48aee7e99d5e0c1
HANDOFF_STORE_SVG_SHA=f8586b681757b1e1340c7e9a44db9ed2e9013517b18b8d31c2891aa90c01c9de
HANDOFF_TOKENS_SHA=362ba00a5ba1ffa857f008d01831ab77a5042eae20d39cfd524851accbaea241
[ "$(sha256_of "$ROOT/store/icon_store_128.png")" = "$HANDOFF_STORE_PNG_SHA" ] && ok "store/icon_store_128.png is the handoff's store listing icon (SHA-256 matches MANIFEST.json brand/png/icon_store_128.png)" || bad "store/icon_store_128.png matches the handoff MANIFEST hash"
[ "$(sha256_of "$ROOT/store/icon-store.svg")" = "$HANDOFF_STORE_SVG_SHA" ] && ok "store/icon-store.svg is the handoff's source (SHA-256 matches MANIFEST.json brand/icon-store.svg)" || bad "store/icon-store.svg matches the handoff MANIFEST hash"
grep -q 'icon_store_128.png' "$ROOT/store/chrome-web-store.md" && grep -q 'icon_store_128.png' "$ROOT/store/README.md" && ok "the Chrome listing and the store checklist name the store listing icon" || bad "the Chrome listing and the store checklist name store/icon_store_128.png"
"$PY" -I - "$ROOT" "$HANDOFF_TOKENS_SHA" <<'PYE' && ok "css/thankmu-tokens.css is the handoff's tokens.css byte for byte after its header, and the header names the hash" || bad "css/thankmu-tokens.css matches the handoff tokens.css hash"
import hashlib, sys
root, want = sys.argv[1:3]
d = open(f"{root}/thankmu/ext/css/thankmu-tokens.css", "rb").read()
mark = b"---- */\n"
assert d.count(mark) == 1, "header end marker"
body = d[d.index(mark) + len(mark):]
assert hashlib.sha256(body).hexdigest() == want, hashlib.sha256(body).hexdigest()
assert want.encode() in d[:d.index(mark)], "the header must name the handoff hash"
assert b"--heart-bg" in body, "round 6 token present"
PYE
"$PY" -I "$ROOT/scripts/check_no_literal_colours.py" "$ROOT/thankmu/ext" >/dev/null 2>"$TMP/e" && ok "no literal colour (hex, rgb(), hsl(), named) in the ThankMu layer's CSS, JS or HTML outside css/thankmu-tokens.css" || bad "no literal colour in the ThankMu layer outside the tokens file" "$(cat "$TMP/e")"
# the check must actually catch a literal: plant one in a copy of the layer, in each file kind
plants=(
  'css/thankmu-popup.css|.x { color: #abc; }'
  'css/thankmu-account.css|.x { background: rgb(1 2 3); }'
  'css/thankmu-account.css|.x { background: RGB(1 2 3); }'
  'css/thankmu-account.css|.x { color: HSL(10 20% 30%); }'
  'css/thankmu-popup.css|.x { border: 1px solid white; }'
  'css/thankmu-popup.css|.x { color: darkred; }'
  'css/thankmu-popup.css|.x { color: rebeccapurple; }'
  'css/thankmu-popup.css|.x { background: whitesmoke; }'
  'css/thankmu-popup.css|.x { outline: 2px solid LightGray; }'
  'css/thankmu-popup.css|.x { background-image: linear-gradient(red, blue); }'
  'js/thankmu/adslot.js|const c = "#c2185b";'
  'js/thankmu/adslot.js|el.style.color = "red";'
  "js/thankmu/adslot.js|el.style.setProperty('color', 'red');"
  'js/thankmu/adslot.js|const X = `.x { border-color: tomato; }`;'
  'thankmu-popup.html|<p style="color:#fff">x</p>'
  'thankmu-popup.html|<p style="background: gold">x</p>'
  'thankmu-popup.html|<font color="red">x</font>'
)
for plant in "${plants[@]}"; do
  rm -rf "$TMP/extcopy"; cp -R "$ROOT/thankmu/ext" "$TMP/extcopy"; printf '\n%s\n' "${plant#*|}" >> "$TMP/extcopy/${plant%%|*}"
  expect_fail "the literal-colour check catches ${plant#*|} in ${plant%%|*}" "literal colour" -- "$PY" -I "$ROOT/scripts/check_no_literal_colours.py" "$TMP/extcopy"
done
rm -rf "$TMP/extcopy"
# the tokens are scoped for the card's shadow root: the :root / .theme-dark selectors are rewritten, nothing else is
"$PY" -I - "$ROOT" <<'PYE' && ok "the generated tokens module scopes only :root and .theme-dark to .tm-slot and keeps every token" || bad "the generated tokens module scopes the tokens for the card"
import importlib.util, json, re, sys
root = sys.argv[1]
spec = importlib.util.spec_from_file_location("pe", f"{root}/thankmu/patch_extension.py"); pe = importlib.util.module_from_spec(spec); spec.loader.exec_module(pe)
src = open(f"{root}/thankmu/ext/css/thankmu-tokens.css", encoding="utf8").read()
js = pe.render_css_module(src, ".tm-slot", "css/thankmu-tokens.css")
css = json.loads(re.search(r"globalThis\.ThankMuTokensCss = (.*);\n$", js).group(1))
assert not re.search(r"(?m)^:root", css) and not re.search(r"(?m)^\.theme-dark", css)
assert css.count(".tm-slot {") == 2 and ".tm-slot.theme-dark {" in css, css[:200]
decl = lambda t: re.findall(r"(--[a-z0-9-]+)\s*:", t)
assert decl(css) == decl(src), "same tokens, same order"
assert src.replace("\n:root {", "\n.tm-slot {").replace("\n:root{", "\n.tm-slot{").replace("\n.theme-dark {", "\n.tm-slot.theme-dark {") == css, "only the selectors differ"
for bad_css in ("a { color: var(--x); }", ":root { --a: 1; }\n.theme-dark { --a: 2; }\nb, :root { --b: 1; }", ":root { --a: 1; }\n.theme-dark { --a: 2; }\nhtml .theme-dark { --a: 3; }"):
    try:
        pe.render_css_module(bad_css, ".tm-slot", "x.css"); raise SystemExit("a leftover or missing tokens selector must fail the build: " + bad_css)
    except pe.PatchError:
        pass
PYE
for f in 400 700; do [ -s "$ROOT/thankmu/ext/assets/fonts/atkinson-hyperlegible-next-latin-$f.woff2" ] || bad "bundled font $f present"; done
[ "$(sha256_of "$ROOT/thankmu/ext/assets/fonts/OFL.txt")" = 474a034e99845062f661855caaa505880d0e9009deddc2727a92795eab374955 ] && ok "assets/fonts/OFL.txt is upstream's LICENSE verbatim (@fontsource/atkinson-hyperlegible-next 5.3.0, SHA-256)" || bad "OFL.txt matches the upstream licence SHA-256"
grep -q "SIL OPEN FONT LICENSE Version 1.1" "$ROOT/thankmu/ext/assets/fonts/OFL.txt" && ok "the bundled Atkinson Hyperlegible Next ships with its SIL OFL 1.1 text" || bad "the OFL text ships with the bundled font"
grep -rqE --include='*.css' "fonts\.(googleapis|gstatic)|@import|https?://" "$ROOT/thankmu/ext/css" && bad "no remote font or @import in the ThankMu CSS" || ok "no remote font, @import or URL in the ThankMu CSS (the privacy listing promises no extra traffic)"

echo "== list_build_hosts.sh =="
hosts="$("$ROOT/scripts/list_build_hosts.sh")" && [ -n "$hosts" ] && ! grep -q '://' <<<"$hosts" && ok "build host list is bare hostnames" || bad "build host list is bare hostnames" "$hosts"
missing=""
while read -r u; do h="${u#*://}"; h="${h%%/*}"; grep -qx -- "$h" <<<"$hosts" || missing="$missing $h"; done < <(python3 -I -c 'import json,sys;[print(u) for r in json.load(open(sys.argv[1])) for u in r["urls"]]' "$ROOT/$UBO_PREFIX/platform/mv3/rulesets.json")
[ -z "$missing" ] && ok "every rulesets.json url host is listed" || bad "every rulesets.json url host is listed" "$missing"

echo "== repo hygiene =="
# Two carve-outs, both narrow, and nothing else is exempt:
#   (d) a verbatim third-party licence notice under an assets/ directory may cite its upstream host. This mirrors the
#       parent scripts/check-consistency.sh (LICENCE_NAMES under LICENCE_ASSET_DIRS).
#   (a) thankmu/targets.json store.source_url, the GPLv3 source offer's public source location (W-P4 items 9 and 11;
#       ADR-013). The file is taken out of this scan and checked by scripts/check_exempt_source_url.py instead, which
#       permits that one field and refuses the host anywhere else in the file. The exemption is the field, not the file.
gh="github"; gh="$gh.com"
gh_hits() { # <repo root> -> project-owned files carrying the host, one per line
  git -C "$1" ls-files -z | grep -zv '^chrome_plugin/' | grep -zv '^thankmu/targets\.json$' \
    | grep -zEv '(^|/)assets/(.*/)?(OFL|LICENSE|NOTICE)[^/]*$' | (cd "$1" && xargs -0r grep -Il -- "$gh" 2>/dev/null) || true
}
hits="$(gh_hits "$ROOT")"
[ -z "$hits" ] && ok "no GitHub URL in project-owned files" || bad "no GitHub URL in project-owned files" "$hits"
exempt_url() { python3 -I "$ROOT/scripts/check_exempt_source_url.py" "$1" "$gh"; }
out="$(exempt_url "$ROOT/thankmu/targets.json" 2>&1)" \
  && [ -z "$out" ] && ok "thankmu/targets.json keeps the host to store.source_url (EX-002 (a))" \
  || bad "thankmu/targets.json keeps the host to store.source_url (EX-002 (a))" "$out"

# The carve-out is one field of one file. Fixtures prove the surrounding rule still bites: a URL on that host is
# accepted in store.source_url and refused everywhere else, including another target's source_url and the _doc prose.
TJ="$TMP/targets"; mkdir -p "$TJ"
tj() { python3 -I -c 'import json,sys; json.dump(json.loads(sys.argv[2]), open(sys.argv[1],"w"))' "$TJ/t.json" "$1"; }
tj "{\"store\": {\"source_url\": \"https://$gh/thankmu/source/\"}}"
out="$(exempt_url "$TJ/t.json" 2>&1)" && [ -z "$out" ] && ok "a source URL on that host is accepted in store.source_url" \
  || bad "a source URL on that host is accepted in store.source_url" "$out"
tj "{\"dev\": {\"source_url\": \"https://$gh/thankmu/source/\"}, \"store\": {}}"
expect_fail "the same URL in dev.source_url is refused" "dev.source_url" -- python3 -I "$ROOT/scripts/check_exempt_source_url.py" "$TJ/t.json" "$gh"
tj "{\"_doc\": \"mirrors live on https://$gh/x\", \"store\": {\"source_url\": \"https://$gh/thankmu/source/\"}}"
expect_fail "the host in _doc is refused even with store.source_url set" "_doc" -- python3 -I "$ROOT/scripts/check_exempt_source_url.py" "$TJ/t.json" "$gh"
tj "{\"store\": {\"source_url\": \"https://$gh/a\", \"mirror_url\": \"https://$gh/b\"}}"
expect_fail "a second URL beside store.source_url is refused" "store.mirror_url" -- python3 -I "$ROOT/scripts/check_exempt_source_url.py" "$TJ/t.json" "$gh"
printf '{"store": {"source_url": "https://%s/a"' "$gh" > "$TJ/t.json"   # truncated: not valid JSON
expect_fail "a targets file that is not valid JSON is refused" "not valid JSON" -- python3 -I "$ROOT/scripts/check_exempt_source_url.py" "$TJ/t.json" "$gh"
expect_fail "an empty host argument is refused" "host argument is empty" -- python3 -I "$ROOT/scripts/check_exempt_source_url.py" "$ROOT/thankmu/targets.json" ""

# The scan itself: in a fixture repo the exemption covers thankmu/targets.json and nothing else, so the same URL in
# any other project-owned file is still caught, and chrome_plugin/ (upstream's words) is still skipped.
FX="$TMP/hygiene"; mkdir -p "$FX/thankmu" "$FX/docs" "$FX/chrome_plugin"
git init -q "$FX"
printf '{"store": {"source_url": "https://%s/thankmu/source/"}}\n' "$gh" > "$FX/thankmu/targets.json"
printf 'upstream lives at https://%s/gorhill/uBlock\n' "$gh" > "$FX/chrome_plugin/README.md"
git -C "$FX" add -A && gq -C "$FX" commit -qm fixture
[ -z "$(gh_hits "$FX")" ] && ok "the scan exempts thankmu/targets.json and skips chrome_plugin/" \
  || bad "the scan exempts thankmu/targets.json and skips chrome_plugin/" "$(gh_hits "$FX")"
printf 'source: https://%s/thankmu/source/\n' "$gh" > "$FX/docs/notes.md"
git -C "$FX" add -A && gq -C "$FX" commit -qm notes
[ "$(gh_hits "$FX")" = "docs/notes.md" ] && ok "the same URL in any other project-owned file is still caught" \
  || bad "the same URL in any other project-owned file is still caught" "$(gh_hits "$FX")"
[ "$(git -C "$ROOT" ls-files -s | grep -c '^160000')" = 0 ] && ok "no gitlinks in index" || bad "no gitlinks in index"
# Vocabulary (founder 2026-11-02, brand brief): nothing is circumvented, so the word is never used; at a partner's wall
# readers unlock. Every project-owned file (the upstream subtree is upstream's words, and stays byte-identical). Built
# from parts, so this check never matches itself.
bw="by"; bw="${bw}pass"
hits="$(git -C "$ROOT" ls-files -z | grep -zv '^chrome_plugin/' | xargs -0 grep -Iil -- "$bw" 2>/dev/null || true)"
[ -z "$hits" ] && ok "the word \"by…pass\" appears in no project-owned file (store listings, layer, docs, tests)" || bad "the word \"by…pass\" appears in no project-owned file" "$hits"

echo; echo "passed=$PASS failed=$FAIL"
[ $FAIL -eq 0 ] || { printf 'FAILED: %s\n' "${FAILED[@]}"; exit 1; }
