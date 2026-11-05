#!/usr/bin/env python3
"""Icon check on a built, patched package (W-P4): the toolbar/store art is the final icon set for the build target.

Usage: check_icons.py <unpatchedDir> <patchedDir> target=<dev|store> [targets=...] [refs=tests/fixtures/icons]

  * every img/icon_*.png the unpatched upstream build has is present in the patched package, non-empty and
    different from upstream's (upstream's art, or any art the patch step failed to replace, never ships);
  * every one of those names must have a committed reference (refs/<target>/icon_<size>[_off].png, rendered from thankmu/icon.svg
    plus the target's icon stylesheets by scripts/regen_icon_fixtures.sh) the file is byte-identical to it, so a
    dev build carries the dev set and a store build the normal set, and neither carries a placeholder;
  * the target has a reference set at all (a new target without one fails: no unchecked art).
"""
import importlib.util
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
ICON_RE = re.compile(r"^icon_\d+(_off)?\.png$")


def main(argv):
    opts = dict(a.split("=", 1) for a in argv if "=" in a)
    dirs = [a for a in argv if "=" not in a]
    if len(dirs) != 2 or not opts.get("target"):
        print("usage: check_icons.py <unpatchedDir> <patchedDir> target=<dev|store>", file=sys.stderr)
        return 2
    U, P = dirs
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("thankmu_patch", os.path.join(REPO, "thankmu", "patch_extension.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    try:
        targets = mod.load_targets(opts.get("targets", os.path.join(REPO, "thankmu", "targets.json")))
        if opts["target"] not in targets:
            mod.die(f"unknown target {opts['target']!r}; targets.json defines {sorted(targets)}")
    except mod.PatchError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    refs = os.path.join(opts.get("refs", os.path.join(REPO, "tests", "fixtures", "icons")), opts["target"])
    errs = []
    if not os.path.isdir(refs):
        errs.append(f"no reference icon set for target {opts['target']}: {refs} (scripts/regen_icon_fixtures.sh writes it)")
    up = sorted(f for f in os.listdir(os.path.join(U, "img")) if ICON_RE.match(f))
    if not up:
        errs.append("unpatched package has no img/icon_*.png (upstream changed?)")
    n_ref = 0
    for f in up:
        pp = os.path.join(P, "img", f)
        if not os.path.isfile(pp) or os.path.getsize(pp) == 0:
            errs.append(f"img/{f}: missing or empty in the patched package")
            continue
        got = open(pp, "rb").read()
        if got == open(os.path.join(U, "img", f), "rb").read():
            errs.append(f"img/{f}: identical to upstream's icon (not replaced)")
        rp = os.path.join(refs, f)
        if not os.path.isfile(rp):
            errs.append(f"img/{f}: no reference render in tests/fixtures/icons/{opts['target']}/ (scripts/regen_icon_fixtures.sh); unpinned art")
        else:
            n_ref += 1
            if got != open(rp, "rb").read():
                errs.append(f"img/{f}: differs from the {opts['target']} reference icon (tests/fixtures/icons/{opts['target']}/{f})")
    if os.path.isdir(refs) and n_ref == 0:
        errs.append(f"no reference icon matches an upstream icon name in {refs}")
    if errs:
        print(f"ICON CHECK FAILED: {len(errs)} problem(s) for target {opts['target']}", file=sys.stderr)
        for e in errs:
            print("  " + e, file=sys.stderr)
        return 1
    print(f"icons ok: target {opts['target']}, {len(up)} upstream icon names replaced, {n_ref} byte-identical to the reference set")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
