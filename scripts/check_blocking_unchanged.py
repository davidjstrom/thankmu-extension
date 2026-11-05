#!/usr/bin/env python3
"""Prove the ThankMu patch did not touch blocking (W-P3 part A).

    python3 scripts/check_blocking_unchanged.py <unpatchedDir> <patchedDir> [target=dev|store]
        [patch=thankmu/patch.json] [brand=thankmu/brand.json] [targets=thankmu/targets.json]

Compares the package as upstream built it against the patched package. Rules:
  * every file under rulesets/ is byte-identical, except rulesets/ruleset-details.json, where only
    each entry's `name` and `homeURL` may differ;
  * every JS file is byte-identical, except files named in patch.json `edits`, where replaying
    exactly those configured edits on the unpatched text must give the patched text;
  * every other file is byte-identical, except the deliberately changed set: manifest.json (only the
    keys in patch.json manifest.set, plus exactly the ThankMu layer's manifest changes for one build
    target, replayed), _locales/*/messages.json (only `message` values), top-level HTML (replayed byte for byte:
    upstream + visible-text replacements + link rewrites + configured edits + the About rows), img/icon_*.png (regenerated);
  * every HTML file keeps exactly upstream's <script> tags (attributes and inline content), whatever patch.json says;
  * the only files removed are the ones patch.json lists; the only files added are the brand logo and
    the ThankMu layer (patch.json layer.files + the generated config module), each byte-equal to what
    the patch step renders for that target. Without target=, the target is the one whose replay matches.
  * the About pane carries the GPLv3 notice and the source offer for that target exactly once (W-P4); a store
    target without targets.json source_url is refused outright.
Python 3 standard library only.
"""
import html.parser
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


def load_patch_module():
    sys.dont_write_bytecode = True  # do not leave __pycache__ in thankmu/
    spec = importlib.util.spec_from_file_location("thankmu_patch", os.path.join(REPO, "thankmu", "patch_extension.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def files_of(base):
    out = set()
    for root, _, fs in os.walk(base):
        for f in fs:
            out.add(os.path.relpath(os.path.join(root, f), base).replace(os.sep, "/"))
    return out


def rb(base, rel):
    with open(os.path.join(base, rel), "rb") as f:
        return f.read()


def rt(base, rel):
    return rb(base, rel).decode("utf8")


class ScriptTags(html.parser.HTMLParser):
    """Every <script> in document order: its attributes (src, type, ...) and its inline content."""
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.seq = []
        self.cur = None

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            self.cur = [tuple(attrs), ""]
            self.seq.append(self.cur)

    def handle_startendtag(self, tag, attrs):
        if tag == "script":
            self.seq.append([tuple(attrs), ""])

    def handle_endtag(self, tag):
        if tag == "script":
            self.cur = None

    def handle_data(self, data):
        if self.cur is not None:
            self.cur[1] += data


def script_tags(text):
    p = ScriptTags()
    p.feed(text)
    p.close()
    return [tuple(x) for x in p.seq]


def main(argv):
    dirs = [a for a in argv if "=" not in a]
    opts = dict(a.split("=", 1) for a in argv if "=" in a)
    if len(dirs) != 2:
        print("usage: check_blocking_unchanged.py <unpatchedDir> <patchedDir>", file=sys.stderr)
        return 2
    U, P = dirs
    mod = load_patch_module()
    brand = mod.load_brand(opts.get("brand", os.path.join(REPO, "thankmu", "brand.json")))
    patch = mod.load_patch(opts.get("patch", os.path.join(REPO, "thankmu", "patch.json")))
    targets = mod.load_targets(opts.get("targets", os.path.join(REPO, "thankmu", "targets.json")))
    if opts.get("target"):
        mod.get_target(targets, opts["target"])
    ctx = mod.Ctx(brand, patch)
    lay = patch["layer"]
    errs = []
    uf, pf = files_of(U), files_of(P)
    if not uf:
        print(f"ERROR: unpatched package is empty: {U}", file=sys.stderr)
        return 1

    expected_removed = set(patch["remove_files"]) | {patch["logo"]["remove"]}
    expected_added = {patch["logo"]["from_icon_source"], lay["config_module"], *lay["files"], *(cm["to"] for cm in lay.get("css_modules", []))}
    if uf - pf != expected_removed:
        errs.append(f"removed files differ from patch.json: got {sorted(uf - pf)}, expected {sorted(expected_removed)}")
    if pf - uf != expected_added:
        errs.append(f"added files differ from patch.json: got {sorted(pf - uf)}, expected {sorted(expected_added)}")

    edits_by_file = {}
    for e in patch["edits"]:
        edits_by_file.setdefault(e["file"], []).append(e)

    n_identical = n_rulesets = n_js = n_edited_js = n_html = 0
    n_details = 0
    # The target first: the HTML replay needs it (the About rows differ per target).
    target_name = tctx = None
    if "manifest.json" in uf & pf:
        ja, jb = json.loads(rb(U, "manifest.json")), json.loads(rb(P, "manifest.json"))
        for k in patch["manifest"]["set"]:
            ja.pop(k, None); jb.pop(k, None)
        names = [opts["target"]] if opts.get("target") else sorted(targets)
        matched = [n for n in names if mod.layer_manifest(ja, patch, targets[n]) == jb]
        if len(matched) != 1:
            errs.append(f"manifest.json: differs beyond patch.json manifest.set plus the ThankMu layer for target "
                        f"{' or '.join(names)} (matched: {matched or 'none'})")
        else:
            target_name = matched[0]
            try:
                tctx = mod.Ctx(brand, patch, mod.get_target(targets, target_name))
            except mod.PatchError as e:
                errs.append(f"About pane: {e}")
    for rel in sorted(uf & pf):
        a, b = rb(U, rel), rb(P, rel)
        if re.fullmatch(r"img/icon_\d+(_off)?\.png", rel):
            continue
        if rel == "manifest.json":
            continue
        if rel.endswith(".html") and script_tags(a.decode("utf8")) != script_tags(b.decode("utf8")):
            # Independent of patch.json (the replay below proves "upstream + config", not that the config is benign):
            # no HTML file may gain, lose or change a <script> (src, type, inline content).
            errs.append(f"{rel}: script tags differ from upstream (no configured change may add or alter a script)")
        if rel.startswith("_locales/") and rel.endswith("/messages.json"):
            ja, jb = json.loads(a), json.loads(b)
            if set(ja) != set(jb):
                errs.append(f"{rel}: key set changed")
            else:
                for k in ja:
                    x, y = dict(ja[k]), dict(jb[k]); x.pop("message", None); y.pop("message", None)
                    if x != y:
                        errs.append(f"{rel}: {k} changed beyond its message")
        elif rel == "rulesets/ruleset-details.json":
            ja, jb = json.loads(a), json.loads(b)
            if [e["id"] for e in ja] != [e["id"] for e in jb]:
                errs.append(f"{rel}: ruleset ids/order changed")
            else:
                for x, y in zip(ja, jb):
                    x, y = dict(x), dict(y)
                    for k in ("name", "homeURL"):
                        x.pop(k, None); y.pop(k, None)
                    if x != y:
                        errs.append(f"{rel}: {x.get('id')} changed beyond name/homeURL")
            n_details += 1
        elif rel.endswith(".html") and "/" not in rel:
            # Replayed byte for byte, like the JS edits: upstream + visible-text replacements + link rewrites + the
            # configured edits + the About rows, exactly as the patch step renders them. Any other change (a script,
            # an inline handler, a javascript: link, an iframe or form) fails.
            if tctx is None:
                errs.append(f"{rel}: cannot replay the HTML changes without a resolved build target")
            else:
                try:
                    want = mod.render_html(tctx, rel, a.decode("utf8"))
                except mod.PatchError as e:
                    want = None
                    errs.append(f"{rel}: replaying the configured HTML changes failed: {e}")
                if want is not None and want != b.decode("utf8"):
                    errs.append(f"{rel}: differs from upstream plus the configured HTML changes (visible text, link "
                                f"rewrites, edits, About rows)")
                n_html += 1
        elif rel in edits_by_file:
            text = a.decode("utf8")
            for e in edits_by_file[rel]:
                text = mod.apply_edit(ctx, text, e, rel)
            if text != b.decode("utf8"):
                errs.append(f"{rel}: differs from upstream by more than the configured edits")
            n_edited_js += 1
        elif a != b:
            errs.append(f"{rel}: differs from upstream and is not a deliberately changed file")
        else:
            n_identical += 1
            if rel.startswith("rulesets/"):
                n_rulesets += 1
            elif rel.endswith((".js", ".mjs")):
                n_js += 1
    if target_name is not None:
        want = {rel: mod.render_layer_file(tctx or ctx, rel) for rel in lay["files"]}
        want[lay["config_module"]] = mod.render_config_module(target_name, targets[target_name]).encode("utf8")
        want.update(mod.render_css_modules(tctx or ctx))
        for rel, data in sorted(want.items()):
            if rel in pf and rb(P, rel) != data:
                errs.append(f"{rel}: ThankMu layer file differs from what the patch step renders for target {target_name}")
        if tctx is not None:
            about = patch["about_license"]["file"]
            errs.extend(mod.about_problems(tctx, rt(P, about), P) if about in pf else [f"{about}: missing"])
    if errs:
        print(f"BLOCKING CHANGED: {len(errs)} problem(s)", file=sys.stderr)
        for e in errs[:100]:
            print("  " + e, file=sys.stderr)
        return 1
    print(f"blocking unchanged: {n_identical} files byte-identical ({n_rulesets} ruleset files, {n_js} JS files); "
          f"deliberately changed and verified: {n_details} ruleset-details.json (name/homeURL only), "
          f"{n_html} HTML files and {n_edited_js} JS files (== upstream + the configured changes only; JS: "
          f"{', '.join(f for f in sorted(edits_by_file) if f.endswith('.js'))}); "
          f"ThankMu layer for target {target_name}: {len(expected_added) - 1} files added, all as rendered; "
          f"About pane GPLv3 notice and source offer as configured")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as e:  # loud, not a traceback-only failure
        print(f"ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
