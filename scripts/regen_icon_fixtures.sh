#!/usr/bin/env bash
# Re-render the reference icon set that scripts/check_icons.py compares builds against:
# tests/fixtures/icons/<target>/icon_<size>[_off].png for sizes 16, 32, 64, 128, 512 (no 512 off), from thankmu/icon.svg, with the
# stylesheets the patch step applies for that target (patch.json icons.states, targets.json icon_css).
# Runs inside the pinned build image (same librsvg as CI), so the bytes match a real build. Needs docker and python3.
# Run it after changing thankmu/icon.svg, thankmu/icons/*.css or the off state in patch.json, and commit the result.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
. "$ROOT/scripts/lib.sh"
command -v docker >/dev/null || die "required tool not found: docker"
command -v python3 >/dev/null || die "required tool not found: python3"
[ -f "$ROOT/.nvmrc" ] || die ".nvmrc missing"
NODE_VERSION="$(tr -d '[:space:]' < "$ROOT/.nvmrc")"
IMAGE="thankmu-chrome-build:node${NODE_VERSION}"
docker build -q -t "$IMAGE" --build-arg "NODE_VERSION=$NODE_VERSION" -f "$HERE/ci/Dockerfile.chrome-build" "$HERE/ci" >/dev/null
rm -rf "$ROOT/tests/fixtures/icons"
docker run --rm -i --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$ROOT:/work" -w /work "$IMAGE" python3 -I - <<'PY'
import json, os, subprocess, sys, tempfile
sys.dont_write_bytecode = True
sys.path.insert(0, "thankmu")
import patch_extension as m
brand = m.load_brand("thankmu/brand.json")
patch = m.load_patch("thankmu/patch.json")
targets = m.load_targets("thankmu/targets.json")
for name, target in targets.items():
    ctx = m.Ctx(brand, patch, target)
    states = dict(patch["icons"]["states"])
    for st, rel in (target.get("icon_css") or {}).items():
        states[st] = m.load_icon_css(rel, f"{name}.icon_css.{st}")
    out = os.path.join("tests/fixtures/icons", name)
    os.makedirs(out)
    with tempfile.TemporaryDirectory() as tmp:
        for st, css in states.items():
            for size in (16, 32, 64, 128, 512):
                if size == 512 and st == "off":
                    continue   # upstream ships no icon_512_off
                f = f"icon_{size}{'_off' if st == 'off' else ''}.png"
                cmd = ["rsvg-convert", "-w", str(size), "-h", str(size), "-f", "png", "-o", os.path.join(out, f)]
                if css:
                    cp = os.path.join(tmp, st + ".css")
                    open(cp, "w").write(css)
                    cmd += ["--stylesheet", cp]
                subprocess.run(cmd + [brand["icon_source"]], check=True)
    print("wrote", out, sorted(os.listdir(out)))
PY
