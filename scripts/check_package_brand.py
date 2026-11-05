#!/usr/bin/env python3
"""Scan a BUILT, PATCHED ThankMu package for upstream marks (W-P3 part A).

    python3 scripts/check_package_brand.py <packageDir> [target=dev|store] [brand=thankmu/brand.json]
        [patch=thankmu/patch.json] [targets=thankmu/targets.json]

Fails (exit 1) listing every user-visible occurrence of: uBlock, uBO, uBOL, uBO Lite, the
micro-sign spelling, upstream author/org/site names and upstream store ids. Case-insensitive.
The allowed exceptions are the credit line from brand.json (names upstream, GPL attribution) and
the neutral filter-lists credit line, each in dashboard.html (present exactly once there), plus the
exact third-party maintainer URLs in patch.json third_party_url_allow. Ruleset ids that carry a mark
(they stay internal and unchanged) must have a display remap in patch.json ruleset_display_ids, and
the troubleshooting text and export file name must apply it.
The About pane must carry the GPLv3 notice and the source offer for the build target exactly once (W-P4):
a store package needs targets.json store.source_url and shows it; a dev package without one shows the
dev-only note. Without target=, the target is the one the package's generated js/thankmu/config.js names.

Boundary (see docs/rebrand.md): scanned = manifest strings (except the DNR ruleset ids/paths and the
dev build's public `key`),
every _locales message, visible HTML (text nodes plus alt/title/aria-label/placeholder/href/src/
content/value attributes), CSS content: strings and url(), SVG text, plain .md/.txt, the display
fields of rulesets/ruleset-details.json, URLs and download file names inside JS string literals,
and the file names under img/ css/ and the package root. NOT scanned: legal notices (LICENSE*,
comment headers), build log, JS identifiers and developer console strings, HTML/CSS ids and
classes, i18n keys, and rulesets/ + web_accessible_resources/ (blocking data and code, which must
stay byte-identical to upstream).
Python 3 standard library only: the CI shell runner has no node.
"""
import html.parser
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

FORBIDDEN = re.compile(
    r"ublock|[µμ]block|(?<![a-z])ubo(?:l|lite)?(?![a-z])|gorhill|ublockorigin"
    r"|ddkjiahejlhfcafbddmgiahcphecmpfh|cjpalhdlnbpafiamejdnhcphjbkeiagm",
    re.I)
# A substitution gone wrong ("ThankMuOrigin", "ThankMu Lite"): passes the mark scan but reads as nonsense.
MANGLED = re.compile(r"ThankMu(?:Origin|Lite)|ThankMu (?:Origin|Lite)\b")
URLISH = re.compile(r"https?://[^\s\"'`<>)]+", re.I)
SKIP_TOP = ("rulesets", "web_accessible_resources")
LEGAL = re.compile(r"(^|/)(LICENSE[^/]*|[^/]*\.LICENSE|log\.txt)$")
BINARY_EXT = {".png", ".gif", ".mp3", ".mp4", ".woff2", ".woff", ".ttf"}
TEXT_EXT = {".js", ".mjs", ".json", ".html", ".css", ".svg", ".md", ".txt", ".xml"}
VISIBLE_ATTRS = {"alt", "title", "aria-label", "placeholder", "href", "src", "content", "value", "action"}

problems = []
CFG = {"allow": [], "map": {}, "map_json": "", "marked": []}  # filled in main(): patch.json data + marked ruleset ids


def bad(rel, where, text):
    problems.append(f"{rel}: {where}: {text[:120]!r}")


def strip_allowed_urls(text):
    """Drop exact, configured third-party maintainer URLs (patch.json third_party_url_allow) before the mark scan."""
    if not CFG["allow"]:
        return text
    return URLISH.sub(lambda m: "" if any(rx.search(m.group(0)) for rx in CFG["allow"]) else m.group(0), text)


def check(rel, where, text, credit=None):
    for c in ([credit] if isinstance(credit, str) else (credit or [])):
        text = text.replace(c, "")
    text = strip_allowed_urls(text)
    for rx in (FORBIDDEN, MANGLED):
        m = rx.search(text)
        if m:
            bad(rel, where, text[max(0, m.start() - 30):m.end() + 30])
            return


def read(path):
    with open(path, encoding="utf8", errors="replace") as f:
        return f.read()


def walk_json_strings(node, path=""):
    if isinstance(node, str):
        yield path, node
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from walk_json_strings(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk_json_strings(v, f"{path}[{i}]")


class VisibleHTML(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.items = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        for k, v in attrs:
            if tag == "script":
                break  # script src is a code path, not visible text
            if not v:
                continue
            if k in VISIBLE_ATTRS:
                self.items.append((f"<{tag} {k}>", v))
            else:
                # any other attribute (data-url, data-href, ...) can still carry a link the UI follows; ids and classes carry no URL
                for u in URLISH.findall(v):
                    self.items.append((f"<{tag} {k}> URL", u))

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip and data.strip():
            self.items.append(("text", data))


def strip_js_comments(src):
    """Drop comment-only lines, /* */ blocks and trailing ' // ...' comments, line by line.
    Deliberately not a tokenizer: regex literals with quotes defeat those, and a URL inside a
    string never has whitespace before its '//'."""
    out, in_block = [], False
    for line in src.splitlines():
        s = line.strip()
        if in_block:
            if "*/" in s:
                in_block = False
            continue
        if s.startswith("/*"):
            in_block = "*/" not in s
            continue
        if s.startswith("//") or s.startswith("*"):
            continue
        out.append(re.sub(r"\s//\s.*$", "", line))
    return "\n".join(out)


def scan_js(rel, path):
    code = strip_js_comments(read(path))
    for m in URLISH.finditer(code):
        url = m.group(0)
        if FORBIDDEN.search(url) and not re.match(r"https?://[^/]*\.invalid(/|$)", url):  # .invalid = non-routable internal placeholder
            bad(rel, "URL in JS string", url)
    # download file names: quoted literals are checked as written; template literals are rendered once per
    # marked ruleset id (the display lookup written by the patch step maps it, a bare ${this.id} does not)
    lookup = "${(" + CFG["map_json"] + ")[this.id] ?? this.id}"
    for m in re.finditer(r"""(?:download['"]\s*,|exportToFile\([^,]*,)\s*(`[^`]*`|'[^']*'|"[^"]*")""", code):
        name = m.group(1)[1:-1]
        if "${" not in name:
            check(rel, "download file name", name)
            continue
        for rid in CFG["marked"] or [""]:
            rendered = name.replace(lookup, CFG["map"].get(rid, rid)).replace("${this.id}", rid)
            rendered = re.sub(r"\$\{[^}]*\}", "", rendered)
            check(rel, f"download file name (rendered for ruleset {rid!r})", rendered)


def scan_css(rel, path):
    css = re.sub(r"/\*.*?\*/", "", read(path), flags=re.S)
    for m in re.finditer(r"content\s*:\s*([^;}]+)", css):
        check(rel, "css content", m.group(1))
    for m in re.finditer(r"url\(([^)]*)\)", css):
        if not m.group(1).strip("'\" ").startswith("data:"):
            check(rel, "css url()", m.group(1))


def scan(pkg, brand):
    credits = [brand["credit"], brand["lists_credit"]]
    credit_counts = [0, 0]
    for root, dirs, files in os.walk(pkg):
        relroot = os.path.relpath(root, pkg)
        top = relroot.split(os.sep)[0] if relroot != "." else ""
        if top in SKIP_TOP:
            if top == "rulesets" and relroot == "rulesets":
                dirs[:] = []
                files = ["ruleset-details.json"] if "ruleset-details.json" in files else []
            else:
                dirs[:] = []
                continue
        for f in sorted(files):
            path = os.path.join(root, f)
            rel = os.path.relpath(path, pkg).replace(os.sep, "/")
            if LEGAL.search(rel):
                continue
            ext = os.path.splitext(f)[1]
            if ext not in TEXT_EXT and ext not in BINARY_EXT and "." in f:
                bad(rel, "unclassified file type", ext)
                continue
            if top in ("", "img", "css") or rel.startswith("img/"):
                check(rel, "file name", f)
            if ext in BINARY_EXT:
                continue
            if rel == "manifest.json":
                m = json.loads(read(path))
                m.get("declarative_net_request", {}).pop("rule_resources", None)  # ruleset ids/paths: internal, must match the byte-identical rulesets
                m.pop("key", None)  # dev build only: base64 public key, never shown (thankmu/targets.json)
                for p, s in walk_json_strings(m):
                    check(rel, p, s)
            elif rel.startswith("_locales/") and f == "messages.json":
                for key, e in json.loads(read(path)).items():
                    check(rel, key, e.get("message", ""))
                    for name, ph in (e.get("placeholders") or {}).items():
                        check(rel, f"{key}.placeholders.{name}", str(ph.get("content", "")) + " " + str(ph.get("example", "")))
            elif rel == "rulesets/ruleset-details.json":
                for e in json.loads(read(path)):
                    for k in ("name", "homeURL", "group"):
                        if isinstance(e.get(k), str):
                            check(rel, f"{e['id']}.{k}", e[k])
            elif ext == ".json":
                for p, s in walk_json_strings(json.loads(read(path))):
                    check(rel, p, s)
            elif ext in (".html", ".svg"):
                parser = VisibleHTML()
                parser.feed(read(path))
                for where, text in parser.items:
                    if rel == "dashboard.html":
                        for i, c in enumerate(credits):
                            credit_counts[i] += text.count(c)
                    check(rel, where, text, credits if rel == "dashboard.html" else None)
            elif ext == ".css":
                scan_css(rel, path)
            elif ext in (".js", ".mjs"):
                scan_js(rel, path)
            elif ext in (".md", ".txt", ".xml"):
                if top != "web_accessible_resources":
                    check(rel, "text", read(path))
    for name, c, n in zip(("credit line", "lists credit line"), credits, credit_counts):
        if n != 1:
            problems.append(f"dashboard.html: {name} must appear exactly once, found {n}")


def check_ruleset_display(pkg, patch):
    """Ruleset ids carrying an upstream mark stay internal, but must never be shown raw: each needs a
    display remap, and every JS file the patch step edits with the lookup must still contain it."""
    for rid in CFG["marked"]:
        if rid not in CFG["map"]:
            problems.append(f"rulesets/ruleset-details.json: ruleset id '{rid}' is shown without a display remap (add it to patch.json ruleset_display_ids)")
    for k, v in CFG["map"].items():
        check("patch.json", f"ruleset_display_ids.{k}", v)
    files = sorted({e["file"] for e in patch["edits"] if "{ruleset_display_ids}" in e["new"]})
    for rel in files:
        path = os.path.join(pkg, rel)
        if not os.path.isfile(path):
            problems.append(f"{rel}: missing (it carries the ruleset display lookup)")
        elif CFG["map_json"] not in read(path):
            problems.append(f"{rel}: ruleset display lookup missing or different from patch.json ruleset_display_ids (ids would show raw)")


BUILD_TARGET_RE = re.compile(r'^export const BUILD_TARGET = "([a-z0-9_-]+)";$', re.M)


def check_about_license(pkg, mod, brand, patch, targets, target_name):
    """The GPLv3 notice + source offer (or the dev-only note) for the target, exactly once (patch_extension renders it)."""
    if not target_name:
        cfg = os.path.join(pkg, patch["layer"]["config_module"])
        m = BUILD_TARGET_RE.search(read(cfg)) if os.path.isfile(cfg) else None
        if not m:
            problems.append(f"{patch['layer']['config_module']}: no BUILD_TARGET; cannot tell which source offer the About pane needs (pass target=)")
            return
        target_name = m.group(1)
    try:
        target = mod.get_target(targets, target_name)  # a store target without source_url fails here, loudly
    except mod.PatchError as e:
        problems.append(f"About pane: {e}")
        return
    path = os.path.join(pkg, patch["about_license"]["file"])
    if not os.path.isfile(path):
        problems.append(f"{patch['about_license']['file']}: missing (it carries the GPLv3 notice and source offer)")
        return
    problems.extend(mod.about_problems(mod.Ctx(brand, patch, target), read(path), pkg))
    return target_name


def check_names(pkg, brand):
    mp = os.path.join(pkg, "manifest.json")
    m = json.loads(read(mp))
    if m.get("short_name") != brand["short_name"]:
        problems.append(f"manifest.json: short_name is {m.get('short_name')!r}, brand says {brand['short_name']!r}")
    for loc in sorted(os.listdir(os.path.join(pkg, "_locales"))):
        msgs = json.loads(read(os.path.join(pkg, "_locales", loc, "messages.json")))
        for key, want in (("extName", brand["name"]), ("extShortDesc", brand["description"])):
            if key in msgs and msgs[key]["message"] != want:
                problems.append(f"_locales/{loc}: {key} is {msgs[key]['message']!r}, brand says {want!r}")


def main(argv):
    pkg = next((a for a in argv if "=" not in a), None)
    opts = dict(a.split("=", 1) for a in argv if "=" in a)
    if not pkg or not os.path.isfile(os.path.join(pkg, "manifest.json")):
        print("usage: check_package_brand.py <packageDir with manifest.json> [brand=<file>]", file=sys.stderr)
        return 2
    bp = opts.get("brand", os.path.join(REPO, "thankmu", "brand.json"))
    if not os.path.isfile(bp):
        print(f"ERROR: brand config missing: {bp}", file=sys.stderr)
        return 1
    # One required-key set for the whole layer: the patch step's own validator.
    import importlib.util
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("thankmu_patch", os.path.join(REPO, "thankmu", "patch_extension.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    try:
        brand = mod.load_brand(bp)
    except mod.PatchError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    pp = opts.get("patch", os.path.join(REPO, "thankmu", "patch.json"))
    try:
        patch = mod.load_patch(pp)
    except mod.PatchError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    try:
        targets = mod.load_targets(opts.get("targets", os.path.join(REPO, "thankmu", "targets.json")))
    except mod.PatchError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    dp = os.path.join(pkg, "rulesets", "ruleset-details.json")
    if not os.path.isfile(dp):
        print(f"ERROR: {dp} missing", file=sys.stderr)
        return 1
    CFG["allow"] = [re.compile(a) for a in patch["third_party_url_allow"]]
    CFG["map"] = patch["ruleset_display_ids"]
    CFG["map_json"] = mod.display_ids_json(patch)
    CFG["marked"] = [e["id"] for e in json.loads(read(dp)) if FORBIDDEN.search(e["id"])]
    scan(pkg, brand)
    check_ruleset_display(pkg, patch)
    target_name = check_about_license(pkg, mod, brand, patch, targets, opts.get("target"))
    # The names the package must carry are the target's (dev: "ThankMu Dev"), not brand.json's alone.
    check_names(pkg, mod.target_brand(brand, targets.get(target_name)))
    if problems:
        print(f"BRAND SCAN FAILED: {len(problems)} problem(s) in {pkg}", file=sys.stderr)
        for p in problems[:200]:
            print("  " + p, file=sys.stderr)
        return 1
    print(f"brand scan ok: {pkg} (credit lines present once, no other upstream marks; {len(CFG['marked'])} marked ruleset ids all "
          f"display-remapped; GPLv3 notice and {'source offer' if targets[target_name].get('source_url') else 'dev-only source note'} "
          f"for target {target_name} present once)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
