#!/usr/bin/env python3
"""ThankMu rebrand + pairing-layer patch step (W-P3 parts A and B).

Same shape as upstream's platform/mv3/<platform>/patch-extension.js: runs on the finished
build output after upstream's make-mv3.sh and edits it in place.

    python3 thankmu/patch_extension.py packageDir=<dir> target=<dev|store|alpha> [brand=...] [patch=...] [targets=...]
    python3 thankmu/patch_extension.py --check-config [target=<dev|store|alpha>] [brand=...] [patch=...] [targets=...]

All names, URLs and strings come from brand.json (identity), patch.json (which upstream
strings change and how, and which ThankMu files are injected) and targets.json (per build
target: the app origin and the dev manifest key). Nothing is hard-coded here. Any missing or unmatched input is a
hard failure: a new upstream string or file must break the build, never leak silently.
"""
import base64
import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

BRAND_STR_KEYS = ["name", "short_name", "description", "author", "homepage_url", "support_url",
                  "privacy_url", "icon_source", "package_name", "credit", "lists_credit",
                  "license_notice", "license_link_text", "source_offer", "source_offer_dev", "modification_notice"]
BRAND_URL_KEYS = ["homepage_url", "support_url", "privacy_url"]
MAX_DESCRIPTION = 132  # Chrome Web Store limit for the manifest description
PLACEHOLDER_KEYS = ["name", "short_name", "description", "author", "homepage_url", "support_url",
                    "privacy_url", "credit", "lists_credit", "license_notice", "license_link_text", "source_offer",
                    "source_offer_dev", "modification_notice"]
# Filled from the build target (targets.json), only in patch.json about_license: the target's public source URL.
TARGET_PLACEHOLDER_KEYS = ["source_url"]
# Filled by apply_edit from patch.json, not from brand.json: the JSON object of ruleset_display_ids.
DISPLAY_IDS_TOKEN = "{ruleset_display_ids}"
# The keys a ThankMu content script entry may carry (W-T1 part A), and the only match patterns it may use.
CONTENT_SCRIPT_KEYS = {"js", "matches", "run_at", "all_frames"}
CONTENT_MATCH_RE = re.compile(r"^https?://\*/\*$")
DISPLAY_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ICON_RE = re.compile(r"^icon_(\d+)(_off)?\.png$")
# A bare https origin: what Chrome reports as sender.origin, so an exact string compare works.
ORIGIN_RE = re.compile(r"^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$")
TARGET_KEYS = {"app_origin", "manifest_key", "extension_id", "source_url", "brand", "icon_css"}
# W-P4: a target may rename the extension (so a dev build is never mistaken for the store one) and restyle the icon.
# brand: overrides for these brand.json keys only. icon_css: icon state ("on"/"off") -> stylesheet file (repo-relative)
# applied by rsvg-convert to the one icon SVG; a state without an entry keeps patch.json icons.states.
TARGET_BRAND_KEYS = ("name", "short_name")
ICON_STATES = ("on", "off")
REQUIRED_TARGETS = ("dev", "store")
STORE_TARGET = "store"  # the Chrome Web Store assigns its own id: this target must not carry a manifest key
ALPHA_TARGET = "alpha"  # the public pre-alpha, installed from a zip: its id must be pinned or it can never pair
# The targets a chrome-vX.Y.Z tag builds and publishes (scripts/ci/release_chrome.sh), both from the one upstream
# build of the tagged tree. Everything a release does for the store zip it does for the alpha zip as well.
RELEASE_TARGETS = (STORE_TARGET, ALPHA_TARGET)
# GPLv3 (W-P4): a build that is distributed to the public must say where its source is. Both release targets are,
# so each needs targets.json source_url; selecting one without it is a hard failure (before the upstream build starts).
SOURCE_REQUIRED_TARGETS = RELEASE_TARGETS
SOURCE_URL_RE = re.compile(r"^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?/[A-Za-z0-9._~%-][A-Za-z0-9._~/%-]*$")
EXT_ID_RE = re.compile(r"^[a-p]{32}$")


class PatchError(Exception):
    pass


def die(msg):
    raise PatchError(msg)


# ---------------------------------------------------------------- config

def load_json(path, what):
    if not os.path.isfile(path):
        die(f"{what} missing: {path}")
    try:
        with open(path, encoding="utf8") as f:
            return json.load(f)
    except ValueError as e:
        die(f"{what} is not valid JSON ({path}): {e}")


def load_brand(path):
    brand = load_json(path, "brand config")
    if not isinstance(brand, dict):
        die(f"brand config must be a JSON object: {path}")
    for k in BRAND_STR_KEYS:
        v = brand.get(k)
        if not isinstance(v, str) or not v.strip():
            die(f"brand config {path} is incomplete: '{k}' is missing or empty")
    for k in BRAND_URL_KEYS:
        if not brand[k].startswith("https://"):
            die(f"brand config {path}: '{k}' must be an https:// URL")
    if len(brand["description"]) > MAX_DESCRIPTION:
        die(f"brand config {path}: 'description' is {len(brand['description'])} chars, limit {MAX_DESCRIPTION}")
    for k in BRAND_STR_KEYS:
        if "\\" in brand[k]:
            die(f"brand config {path}: '{k}' must not contain a backslash")
    return brand


def check_placeholders(s, where, extra=()):
    for m in re.finditer(r"\{([a-z_]+)\}", s):
        if m.group(1) not in PLACEHOLDER_KEYS and m.group(1) not in extra and "{" + m.group(1) + "}" != DISPLAY_IDS_TOKEN:
            die(f"{where}: unknown placeholder {{{m.group(1)}}}")


def load_patch(path):
    p = load_json(path, "patch config")
    if not isinstance(p, dict):
        die(f"patch config must be a JSON object: {path}")
    for k in ("manifest", "url_pattern", "locale_key_overrides", "locale_text_replacements",
              "html_text_replacements", "ruleset_details", "link_rewrites", "edits", "logo",
              "remove_files", "icons", "ruleset_display_ids", "third_party_url_allow", "layer", "about_license"):
        if k not in p:
            die(f"patch config {path} is incomplete: '{k}' is missing")
    try:
        re.compile(p["url_pattern"])
    except re.error as e:
        die(f"patch config: url_pattern is not a valid regex: {e}")
    ids = p["ruleset_display_ids"]
    if not isinstance(ids, dict) or not ids:
        die("patch config: ruleset_display_ids must be a non-empty object {upstream ruleset id: display id}")
    for k, v in ids.items():
        if not isinstance(v, str) or not DISPLAY_ID_RE.match(v) or not DISPLAY_ID_RE.match(k):
            die(f"patch config: ruleset_display_ids {k!r}: {v!r}: ids must be lower-case tokens like 'core-filters'")
    if len(set(ids.values())) != len(ids) or set(ids.values()) & set(ids):
        die("patch config: ruleset_display_ids: display ids must be unique and must not be upstream ids")
    allow = p["third_party_url_allow"]
    if not isinstance(allow, list):
        die("patch config: third_party_url_allow must be a list of regexes")
    for a in allow:
        try:
            re.compile(a)
        except (re.error, TypeError) as e:
            die(f"patch config: third_party_url_allow {a!r} is not a valid regex: {e}")
    for i, e in enumerate(p["edits"]):
        for k in ("file", "count", "new"):
            if k not in e:
                die(f"patch config: edits[{i}] lacks '{k}'")
        if "pattern" not in e and not e.get("url_pattern_match"):
            die(f"patch config: edits[{i}] needs 'pattern' or url_pattern_match")
        if not isinstance(e["count"], int) or e["count"] < 1:
            die(f"patch config: edits[{i}].count must be a positive integer")
    for i, r in enumerate(p["link_rewrites"]):
        if "file" not in r or ("i18n" not in r) == ("text" not in r):
            die(f"patch config: link_rewrites[{i}] needs 'file' and exactly one of 'i18n' or 'text'")
        if ("href" in r) == bool(r.get("remove")):
            die(f"patch config: link_rewrites[{i}] needs exactly one of 'href' or 'remove'")
    if p["ruleset_details"].get("homeurl_on_mark") not in ("remove", "brand_homepage"):
        die("patch config: ruleset_details.homeurl_on_mark must be 'remove' or 'brand_homepage'")
    if "states" not in p["icons"] or "on" not in p["icons"]["states"] or "off" not in p["icons"]["states"]:
        die("patch config: icons.states needs 'on' and 'off'")
    lay = p["layer"]
    for k in ("src", "files", "config_module", "service_worker"):
        if k not in lay:
            die(f"patch config: layer lacks '{k}'")
    if not isinstance(lay["files"], list) or not lay["files"]:
        die("patch config: layer.files must be a non-empty list of package paths")
    for f in lay["files"] + [lay["config_module"]]:
        if not isinstance(f, str) or f.startswith("/") or ".." in f.split("/") or f.endswith(".test.mjs"):
            die(f"patch config: layer file {f!r} must be a relative package path (and never a test)")
    for i, cm in enumerate(lay.get("css_modules", [])):
        if not isinstance(cm, dict) or set(cm) != {"from", "to", "scope"} or not all(isinstance(v, str) and v for v in cm.values()):
            die(f"patch config: layer.css_modules[{i}] needs exactly 'from', 'to' and 'scope' (non-empty strings)")
        if cm["from"] not in lay["files"] or not cm["from"].endswith(".css") or not cm["to"].endswith(".js"):
            die(f"patch config: layer.css_modules[{i}]: 'from' must be a .css file in layer.files and 'to' a .js path")
        if cm["to"].startswith("/") or ".." in cm["to"].split("/") or cm["to"] in lay["files"]:
            die(f"patch config: layer.css_modules[{i}].to must be a new relative package path, not a layer file")
        if not re.match(r"^\.[a-z][a-z0-9-]*$", cm["scope"]):
            die(f"patch config: layer.css_modules[{i}].scope must be one class selector like '.tm-slot'")
    sw = lay["service_worker"]
    if not isinstance(sw, dict) or not all(isinstance(sw.get(k), str) and sw[k].startswith("/") for k in ("upstream", "wrapper")):
        die("patch config: layer.service_worker needs 'upstream' and 'wrapper' as absolute package paths")
    if sw["wrapper"].lstrip("/") not in lay["files"]:
        die("patch config: layer.service_worker.wrapper must be one of layer.files")
    cs = lay.get("content_scripts", [])
    if not isinstance(cs, list):
        die("patch config: layer.content_scripts must be a list")
    for i, entry in enumerate(cs):
        if not isinstance(entry, dict) or set(entry) - CONTENT_SCRIPT_KEYS:
            die(f"patch config: layer.content_scripts[{i}] must be an object with keys from {sorted(CONTENT_SCRIPT_KEYS)}")
        js, matches = entry.get("js"), entry.get("matches")
        generated = [cm["to"] for cm in lay.get("css_modules", [])]
        if not isinstance(js, list) or not js or not all(isinstance(f, str) and (f in lay["files"] or f in generated) for f in js):
            die(f"patch config: layer.content_scripts[{i}].js must list files from layer.files")
        if not isinstance(matches, list) or not matches or not all(isinstance(m, str) and CONTENT_MATCH_RE.match(m) for m in matches):
            die(f"patch config: layer.content_scripts[{i}].matches must be http(s) match patterns")
        if entry.get("all_frames") is not False:
            die(f"patch config: layer.content_scripts[{i}] must set all_frames false (the cards live in the top frame only)")
    al = p["about_license"]
    for k in ("file", "after", "with_source", "without_source", "license_file"):
        if not isinstance(al.get(k), str) or not al[k]:
            die(f"patch config: about_license lacks '{k}'")
    lic = al["license_file"]
    if lic.startswith("/") or ".." in lic.split("/"):
        die("patch config: about_license.license_file must be a relative package path")
    for k in ("with_source", "without_source"):
        if f'href="{lic}"' not in al[k]:
            die(f"patch config: about_license.{k} must link license_file ({lic})")
    if "{source_url}" not in al["with_source"] or "{source_url}" in al["without_source"]:
        die("patch config: about_license.with_source must show {source_url}; without_source must not")
    for k in ("with_source", "without_source"):
        check_placeholders(al[k], f"patch config: about_license.{k}", TARGET_PLACEHOLDER_KEYS)
    rest = {k: v for k, v in p.items() if k != "about_license"}
    for s in json.dumps(rest, ensure_ascii=False).split('"') + al["after"].split('"'):
        check_placeholders(s, "patch config")
    return p


def extension_id(manifest_key):
    """Chrome's id for an unpacked extension with this manifest 'key': sha256 of the DER public key, first
    32 hex digits, each mapped 0-f -> a-p."""
    der = base64.b64decode(manifest_key, validate=True)
    return "".join(chr(ord("a") + int(c, 16)) for c in hashlib.sha256(der).hexdigest()[:32])


def load_icon_css(rel, where):
    """The stylesheet text of a target's icon state. A declared file that is missing or empty fails the build."""
    if not isinstance(rel, str) or not rel or os.path.isabs(rel) or ".." in rel.split("/"):
        die(f"{where}: must be a repo-relative path, got {rel!r}")
    path = os.path.join(REPO, rel)
    if not os.path.isfile(path):
        die(f"{where}: icon stylesheet missing: {rel}")
    text = read_text(path).strip()
    if not text:
        die(f"{where}: icon stylesheet is empty: {rel}")
    return text


def target_brand(brand, target):
    """brand.json with the build target's name overrides applied (dev: 'ThankMu Dev'). Every brand placeholder, the
    manifest names and the locale names then come from this one dict, so the verifiers get it by building a Ctx."""
    if not target or "brand" not in target:
        return brand
    out = dict(brand)
    out.update(target["brand"])
    return out


def load_targets(path):
    t = load_json(path, "targets config")
    if not isinstance(t, dict):
        die(f"targets config must be a JSON object: {path}")
    targets = {k: v for k, v in t.items() if not k.startswith("_")}
    for name in REQUIRED_TARGETS:
        if name not in targets:
            die(f"targets config {path}: target '{name}' is missing")
    for name, cfg in targets.items():
        if not isinstance(cfg, dict):
            die(f"targets config: '{name}' must be an object")
        extra = set(cfg) - TARGET_KEYS
        if extra:
            die(f"targets config: '{name}' has unknown keys {sorted(extra)}")
        origin = cfg.get("app_origin")
        if not isinstance(origin, str) or not origin.strip():
            die(f"targets config: '{name}'.app_origin is missing or empty")
        if not ORIGIN_RE.match(origin):
            die(f"targets config: '{name}'.app_origin must be a bare https origin (https://host[:port], no path, "
                f"no trailing slash), got {origin!r}")
        if "manifest_key" in cfg:
            if name == STORE_TARGET:
                die(f"targets config: '{name}' must not carry manifest_key (the Chrome Web Store assigns the id)")
            try:
                got = extension_id(cfg["manifest_key"])
            except (ValueError, TypeError) as e:
                die(f"targets config: '{name}'.manifest_key is not valid base64: {e}")
            if cfg.get("extension_id") != got:
                die(f"targets config: '{name}'.extension_id is {cfg.get('extension_id')!r}, but manifest_key gives {got!r}")
        elif "extension_id" in cfg:
            die(f"targets config: '{name}'.extension_id without manifest_key (the id comes from the key)")
        if "brand" in cfg:
            b = cfg["brand"]
            if not isinstance(b, dict) or not b or set(b) - set(TARGET_BRAND_KEYS):
                die(f"targets config: '{name}'.brand must be a non-empty object with only {list(TARGET_BRAND_KEYS)}")
            for k, v in b.items():
                if not isinstance(v, str) or not v.strip() or "\\" in v:
                    die(f"targets config: '{name}'.brand.{k} must be a non-empty string without a backslash")
        if "icon_css" in cfg:
            ic = cfg["icon_css"]
            if not isinstance(ic, dict) or not ic or set(ic) - set(ICON_STATES):
                die(f"targets config: '{name}'.icon_css must be a non-empty object keyed by {list(ICON_STATES)}")
            for state, rel in ic.items():
                load_icon_css(rel, f"targets config: '{name}'.icon_css.{state}")
        if "source_url" in cfg:
            src = cfg["source_url"]
            if not isinstance(src, str) or not SOURCE_URL_RE.match(src):
                die(f"targets config: '{name}'.source_url must be an https URL with a path and no query "
                    f"(https://host/path), got {src!r}")
    # One release tag publishes the released tree once (scripts/ci/publish_source_snapshot.sh), so every package
    # built from that tag has to offer the reader that one publication. Targets naming different source repos would
    # ship a package whose GPLv3 offer points where the source was never pushed, and nothing downstream could notice:
    # the publish step and scripts/check_snapshot_repo_url.py only ever read one of them.
    offers = {n: c["source_url"] for n, c in targets.items() if "source_url" in c}
    if len(set(offers.values())) > 1:
        die("targets config: the targets that declare source_url must all declare the same one (a release tag "
            "publishes the source once, for every package it builds); got "
            + ", ".join(f"{n}={offers[n]!r}" for n in sorted(offers)))
    return targets


def get_target(targets, name):
    if not name:
        die(f"target=<{'|'.join(sorted(targets))}> is required")
    if name not in targets:
        die(f"unknown target {name!r}; targets.json defines {sorted(targets)}")
    if name in SOURCE_REQUIRED_TARGETS and not targets[name].get("source_url"):
        die(f"target {name!r} has no source_url in thankmu/targets.json. A {name} build is distributed to the public "
            f"and must carry the GPLv3 source offer on the About pane (W-P4): set '{name}'.source_url to the public "
            f"source location before building it. No {name} build ships without it.")
    return targets[name]


def layer_manifest(m, patch, target):
    """The manifest with the ThankMu layer applied: service worker wrapper, externally_connectable for the app
    origin only, ThankMu's content scripts (appended), and the dev key. Host permissions stay exactly upstream's. Importable by the verifier, which replays it."""
    m = copy.deepcopy(m)
    sw = patch["layer"]["service_worker"]
    bg = m.get("background")
    if not isinstance(bg, dict) or bg.get("service_worker") != sw["upstream"]:
        die(f"manifest.json: background.service_worker is not {sw['upstream']!r} (upstream changed?)")
    if bg.get("type") != "module":
        die("manifest.json: background.type is not 'module'; the ThankMu wrapper imports upstream's worker (upstream changed?)")
    for k in ("externally_connectable", "key"):
        if k in m:
            die(f"manifest.json: upstream now sets '{k}'; the ThankMu layer would overwrite it")
    # No host_permissions entry for the app origin: upstream's mode-manager.js turns permissions.getAll().origins
    # into per-host filtering modes, so an extra origin could change filtering there. <all_urls> covers the call.
    match = target["app_origin"] + "/*"
    bg["service_worker"] = sw["wrapper"]
    m["externally_connectable"] = {"matches": [match]}
    # W-T1 part A: ThankMu's content scripts (the ad-slot card) go after upstream's own, which stay as they are.
    for entry in patch["layer"].get("content_scripts", []):
        m.setdefault("content_scripts", []).append(copy.deepcopy(entry))
    if "manifest_key" in target:
        m["key"] = target["manifest_key"]
    return m


def render_config_module(name, target):
    return ("// Generated by thankmu/patch_extension.py from thankmu/targets.json. Do not edit.\n"
            f"export const BUILD_TARGET = {json.dumps(name)};\n"
            f"export const APP_ORIGIN = {json.dumps(target['app_origin'])};\n")


def render_css_module(css_text, scope, source):
    """A classic script that hands a stylesheet to a content script as a string (W-P4 design handoff).

    The content script cannot import CSS and a closed shadow root cannot reach the extension's files without
    making them web-accessible, so the token file is inlined here at build time. The only change to the CSS is
    the selectors that name the document (:root, .theme-dark): inside a shadow root they match nothing, so
    they are scoped to the card's own element. Every other byte is the file's. A token file that no longer has
    exactly those selectors fails the build rather than shipping a card with no colours."""
    out, n_root = re.subn(r"(?m)^:root(?=\s*\{)", scope, css_text)
    out, n_dark = re.subn(r"(?m)^\.theme-dark(?=\s*\{)", scope + ".theme-dark", out)
    if n_root < 1 or n_dark != 1:
        die(f"{source}: expected ':root {{' (at least once) and '.theme-dark {{' (once) at line starts; found {n_root} and {n_dark}")
    bare = re.sub(r"/\*.*?\*/", "", out, flags=re.S)
    left = re.findall(r"[^{}]*(?::root|(?<!" + re.escape(scope) + r")\.theme-dark)[^{}]*\{", bare)
    if left:
        die(f"{source}: a :root or .theme-dark selector is left after scoping ({left[0].strip()[:60]!r}); "
            "they match nothing inside a shadow root, so the card would have no colours")
    return ("// Generated by thankmu/patch_extension.py from " + source + ". Do not edit.\n"
            "globalThis.ThankMuTokensCss = " + json.dumps(out, ensure_ascii=False) + ";\n")


def render_css_modules(ctx):
    """{package path: bytes} of every generated css module of the layer."""
    lay = ctx.patch["layer"]
    out = {}
    for cm in lay.get("css_modules", []):
        text = render_layer_file(ctx, cm["from"]).decode("utf8")
        out[cm["to"]] = render_css_module(text, cm["scope"], cm["from"]).encode("utf8")
    return out


def render_layer_file(ctx, rel):
    """The package content of one injected layer file (html gets the brand placeholders filled)."""
    src = os.path.join(REPO, ctx.patch["layer"]["src"], rel)
    if not os.path.isfile(src):
        die(f"ThankMu layer file missing: {ctx.patch['layer']['src']}/{rel}")
    if rel.endswith(".html"):
        return ctx.fill_html(read_text(src)).encode("utf8")
    with open(src, "rb") as f:
        return f.read()


def display_ids_json(patch):
    """The one rendering of ruleset_display_ids that is written into JS and that the brand scan looks for."""
    return json.dumps(patch["ruleset_display_ids"], sort_keys=True)


class Ctx:
    def __init__(self, brand, patch, target=None):
        self.brand = target_brand(brand, target)
        self.patch = patch
        self.target = target  # the build target's targets.json entry; needed only for about_license

    def fill(self, s):
        check_placeholders(s, "template")
        for k in PLACEHOLDER_KEYS:
            s = s.replace("{" + k + "}", self.brand[k])
        return s

    def fill_html(self, s):
        """Like fill, but for text going into HTML: escape the substituted values."""
        check_placeholders(s, "template")
        for k in PLACEHOLDER_KEYS:
            v = (self.brand[k].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                 .replace('"', "&quot;"))
            s = s.replace("{" + k + "}", v)
        return s


# ---------------------------------------------------------------- helpers

def read_text(path):
    with open(path, encoding="utf8", newline="") as f:
        return f.read()


def write_text(path, text):
    with open(path, "w", encoding="utf8", newline="") as f:
        f.write(text)


def need_file(pkg, rel):
    p = os.path.join(pkg, rel)
    if not os.path.isfile(p):
        die(f"expected file missing from package: {rel}")
    return p


def apply_edit(ctx, text, edit, rel):
    """Apply one regex edit; the match count must equal edit['count']. Importable by the verifier."""
    pat = ctx.patch["url_pattern"] if edit.get("url_pattern_match") else edit["pattern"]
    rx = re.compile(pat, re.I if edit.get("url_pattern_match") else 0)
    new_tpl = edit["new"].replace(DISPLAY_IDS_TOKEN, display_ids_json(ctx.patch))
    new_tpl = (ctx.fill_html if rel.endswith(".html") else ctx.fill)(new_tpl)
    found = len(rx.findall(text))
    if found != edit["count"]:
        die(f"{rel}: edit {pat!r} matched {found} time(s), expected {edit['count']} (upstream changed?)")
    return rx.sub(lambda m: m.expand(new_tpl), text)


TAG_RE = re.compile(r"(<!--.*?-->|<script\b.*?</script>|<style\b.*?</style>|<[^>]*>)", re.S | re.I)
ATTR_RE = re.compile(r'(\b(?:alt|title|aria-label|placeholder)=")([^"]*)(")', re.I)


def html_visible_replace(text, reps):
    """Apply text replacements to visible text nodes and alt/title/aria-label/placeholder values only.
    Ids, classes, comments, scripts and styles are never touched."""
    def rep(s):
        for a, b in reps:
            s = s.replace(a, b)
        return s
    out = []
    for part in TAG_RE.split(text):
        if part.startswith("<!--") or re.match(r"<(script|style)\b", part, re.I):
            out.append(part)
        elif part.startswith("<"):
            out.append(ATTR_RE.sub(lambda m: m.group(1) + rep(m.group(2)) + m.group(3), part))
        else:
            out.append(rep(part))
    return "".join(out)


def html_files(pkg):
    return sorted(f for f in os.listdir(pkg) if f.endswith(".html") and os.path.isfile(os.path.join(pkg, f)))


# ---------------------------------------------------------------- steps

def patch_manifest(ctx, pkg):
    path = need_file(pkg, "manifest.json")
    m = json.loads(read_text(path))
    for k, v in ctx.patch["manifest"]["set"].items():
        m[k] = ctx.fill(v)
    if m.get("name") != "__MSG_extName__" or m.get("description") != "__MSG_extShortDesc__":
        die("manifest.json: name/description are no longer __MSG_extName__/__MSG_extShortDesc__ (upstream changed?)")
    write_text(path, json.dumps(m, indent=2, ensure_ascii=False) + "\n")


def patch_locales(ctx, pkg):
    base = os.path.join(pkg, "_locales")
    if not os.path.isdir(base):
        die("expected directory missing from package: _locales")
    url_rx = re.compile(ctx.patch["url_pattern"], re.I)
    tr = ctx.patch["locale_text_replacements"]
    ko = ctx.patch["locale_key_overrides"]
    if "*" not in tr or "*" not in ko:
        die("patch config: locale_text_replacements and locale_key_overrides need a '*' entry")
    count = 0
    for loc in sorted(os.listdir(base)):
        path = os.path.join(base, loc, "messages.json")
        if not os.path.isfile(path):
            die(f"_locales/{loc}: messages.json is missing (a locale that is not patched would leak upstream marks)")
        msgs = json.loads(read_text(path))
        overrides = dict(ko["*"]); overrides.update(ko.get(loc, {}))
        reps = list(tr["*"]) + list(tr.get(loc, []))
        for key, entry in msgs.items():
            if key in overrides:
                entry["message"] = ctx.fill(overrides[key])
                continue
            msg = url_rx.sub(lambda m: ctx.brand["support_url"], entry["message"])
            for a, b in reps:
                msg = msg.replace(a, ctx.fill(b))
            entry["message"] = msg
        for key in overrides:
            if key not in msgs and loc == "en":
                die(f"_locales/en: override key '{key}' not found (upstream changed?)")
        write_text(path, json.dumps(msgs, indent=2, ensure_ascii=False) + "\n")
        count += 1
    if count == 0:
        die("no _locales/*/messages.json found in package")


A_RX = re.compile(r"<a\b([^>]*)>(.*?)</a>", re.S)


def link_rewrite(ctx, r, text):
    """Apply one patch.json link_rewrite to one file's text."""
    hits = []
    for m in A_RX.finditer(text):
        attrs, inner = m.group(1), m.group(2)
        if "i18n" in r:
            ok = re.search(r'\bdata-i18n="%s"' % re.escape(r["i18n"]), attrs)
        else:
            ok = inner.strip() == r["text"]
        if ok:
            hits.append(m)
    want = r.get("i18n") or r.get("text")
    if len(hits) != 1:
        die(f"{r['file']}: link {want!r} matched {len(hits)} anchors, expected 1 (upstream changed?)")
    m = hits[0]
    if r.get("remove"):
        wrap = re.compile(r'[ \t]*<div class="li">' + re.escape(m.group(0)) + r"</div>\n?")
        if len(wrap.findall(text)) != 1:
            die(f"{r['file']}: link {want!r} is not a lone <div class=\"li\"> row, cannot remove cleanly")
        return wrap.sub("", text)
    href = ctx.fill_html(r["href"])
    new_attrs, n = re.subn(r'\bhref="[^"]*"', 'href="' + href + '"', m.group(1))
    if n != 1:
        die(f"{r['file']}: link {want!r} has {n} href attributes, expected 1")
    return text[:m.start()] + "<a" + new_attrs + ">" + m.group(2) + "</a>" + text[m.end():]


def about_license_html(ctx):
    """The About pane's licence rows for this build target: the modification notice, the GPLv3 notice, and either the
    source offer (the target's source_url) or, when the target has none (dev only; get_target refuses a store target
    without one), the dev-only note. Importable by the package checks, which require exactly this fragment once."""
    if ctx.target is None:
        die("about_license: no build target given")
    al = ctx.patch["about_license"]
    src = ctx.target.get("source_url")
    tpl = al["with_source"] if src else al["without_source"]
    if src:
        esc = src.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
        tpl = tpl.replace("{source_url}", esc)
    return ctx.fill_html(tpl)


def about_problems(ctx, text, pkg=None):
    """Problems with the licence rows in a patched dashboard.html for ctx.target (empty list = fine). With pkg, the
    licence text the notice links (about_license.license_file) must be in the package."""
    al = ctx.patch["about_license"]
    want = about_license_html(ctx)
    out = []
    n = text.count(want)
    if n != 1:
        out.append(f"{al['file']}: the GPLv3 notice and source-offer rows for this target must appear exactly once, found {n}")
    if ctx.target.get("source_url") and ctx.brand["source_offer_dev"] in text:
        out.append(f"{al['file']}: the dev-only source note is shown although this target has a source_url")
    if pkg is not None and not os.path.isfile(os.path.join(pkg, al["license_file"])):
        out.append(f"{al['license_file']}: missing from the package, but the About pane's GPLv3 notice links it")
    return out


def insert_about_license(ctx, text):
    al = ctx.patch["about_license"]
    anchor = ctx.fill_html(al["after"])
    if text.count(anchor) != 1:
        die(f"{al['file']}: about_license anchor {anchor!r} found {text.count(anchor)} time(s), expected 1 (credit rows moved?)")
    return text.replace(anchor, anchor + about_license_html(ctx), 1)


def render_html(ctx, rel, text):
    """A top-level package HTML file as the patch step leaves it: the visible-text replacements, then this file's link
    rewrites, its edits and (for about_license.file) the About licence rows. The one rendering: the patch step writes
    it, and check_blocking_unchanged.py replays it on the unpatched file and requires byte equality."""
    text = html_visible_replace(text, [(a, ctx.fill(b)) for a, b in ctx.patch["html_text_replacements"]])
    for r in ctx.patch["link_rewrites"]:
        if r["file"] == rel:
            text = link_rewrite(ctx, r, text)
    for e in ctx.patch["edits"]:
        if e["file"] == rel:
            text = apply_edit(ctx, text, e, rel)
    if rel == ctx.patch["about_license"]["file"]:
        text = insert_about_license(ctx, text)
    return text


def patch_html(ctx, pkg):
    al = ctx.patch["about_license"]
    configured = ({r["file"] for r in ctx.patch["link_rewrites"]} | {al["file"]}
                  | {e["file"] for e in ctx.patch["edits"] if e["file"].endswith(".html")})
    for rel in sorted(configured):
        need_file(pkg, rel)
        if "/" in rel:
            die(f"patch config: {rel}: HTML changes are only supported in top-level package files")
    for f in html_files(pkg):
        p = os.path.join(pkg, f)
        write_text(p, render_html(ctx, f, read_text(p)))
    probs = about_problems(ctx, read_text(os.path.join(pkg, al["file"])), pkg)
    if probs:
        die("; ".join(probs))


def patch_edits(ctx, pkg):
    """The non-HTML edits; HTML edits are applied by render_html."""
    for e in ctx.patch["edits"]:
        if e["file"].endswith(".html"):
            continue
        p = need_file(pkg, e["file"])
        write_text(p, apply_edit(ctx, read_text(p), e, e["file"]))


def patch_ruleset_details(ctx, pkg):
    p = need_file(pkg, "rulesets/ruleset-details.json")
    details = json.loads(read_text(p))
    url_rx = re.compile(ctx.patch["url_pattern"], re.I)
    names = ctx.patch["ruleset_details"]["name_overrides"]
    seen = set()
    for d in details:
        if d["id"] in names:
            d["name"] = names[d["id"]]
            seen.add(d["id"])
        if isinstance(d.get("homeURL"), str) and url_rx.search(d["homeURL"]):
            if ctx.patch["ruleset_details"]["homeurl_on_mark"] == "remove":
                del d["homeURL"]
            else:
                d["homeURL"] = url_rx.sub(lambda m: ctx.brand["homepage_url"], d["homeURL"])
    missing = set(names) - seen
    if missing:
        die(f"rulesets/ruleset-details.json: name_overrides for unknown rulesets {sorted(missing)} (upstream changed?)")
    real = {d["id"] for d in details}
    disp = ctx.patch["ruleset_display_ids"]
    if set(disp) - real:
        die(f"rulesets/ruleset-details.json: ruleset_display_ids for unknown rulesets {sorted(set(disp) - real)} (upstream changed?)")
    clash = set(disp.values()) & real
    if clash:
        die(f"rulesets/ruleset-details.json: display ids {sorted(clash)} collides with real ruleset ids")
    write_text(p, json.dumps(details, indent=1, ensure_ascii=False) + "\n")


def patch_layer(ctx, pkg, name, target):
    lay = ctx.patch["layer"]
    out = {rel: render_layer_file(ctx, rel) for rel in lay["files"]}
    out[lay["config_module"]] = render_config_module(name, target).encode("utf8")
    out.update(render_css_modules(ctx))
    for rel, data in out.items():
        dst = os.path.join(pkg, rel)
        if os.path.exists(dst):
            die(f"{rel}: already in the package; the ThankMu layer only adds files, never replaces upstream ones")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(data)
    path = need_file(pkg, "manifest.json")
    m = layer_manifest(json.loads(read_text(path)), ctx.patch, target)
    write_text(path, json.dumps(m, indent=2, ensure_ascii=False) + "\n")


def patch_files(ctx, pkg):
    for rel in ctx.patch["remove_files"]:
        os.remove(need_file(pkg, rel))


def raster_icons(ctx, pkg):
    src = os.path.join(REPO, ctx.brand["icon_source"])
    if not os.path.isfile(src):
        die(f"icon source missing: {ctx.brand['icon_source']}")
    if shutil.which("rsvg-convert") is None:
        die("rsvg-convert not found (it is installed in scripts/ci/Dockerfile.chrome-build; run the build via scripts/ci/docker_build_chrome.sh)")
    img = os.path.join(pkg, "img")
    if not os.path.isdir(img):
        die("expected directory missing from package: img")
    states = dict(ctx.patch["icons"]["states"])
    for state, rel in ((ctx.target or {}).get("icon_css") or {}).items():
        states[state] = load_icon_css(rel, f"icon_css.{state}")
    css_files = {}
    tmp = tempfile.mkdtemp()
    try:
        for state, css in states.items():
            if css:
                cp = os.path.join(tmp, f"{state}.css")
                write_text(cp, css)
                css_files[state] = cp
        found = 0
        for f in sorted(os.listdir(img)):
            if not f.endswith(".png"):
                continue
            m = ICON_RE.match(f)
            if not m:
                die(f"img/{f}: a PNG the icon pipeline does not know (upstream changed?); add it to the pipeline or remove it")
            size = int(m.group(1))
            state = "off" if m.group(2) else "on"
            cmd = ["rsvg-convert", "-w", str(size), "-h", str(size), "-f", "png", "-o", os.path.join(img, f)]
            if state in css_files:
                cmd += ["--stylesheet", css_files[state]]
            cmd.append(src)
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0:
                die(f"rsvg-convert failed for img/{f}: {r.stderr.strip()}")
            if not os.path.isfile(os.path.join(img, f)) or os.path.getsize(os.path.join(img, f)) == 0:
                die(f"rsvg-convert produced no output for img/{f}")
            found += 1
        if found == 0:
            die("no img/icon_*.png found in package (upstream changed?)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    # dashboard logo: replace the upstream SVG with the brand source
    logo = ctx.patch["logo"]
    os.remove(need_file(pkg, logo["remove"]))
    shutil.copyfile(src, os.path.join(pkg, logo["from_icon_source"]))


def patch_package(pkg, brand, patch, target_name, target):
    if not os.path.isdir(pkg):
        die(f"packageDir is not a directory: {pkg}")
    ctx = Ctx(brand, patch, target)
    patch_manifest(ctx, pkg)
    patch_locales(ctx, pkg)
    patch_html(ctx, pkg)  # per HTML file: text, link rewrites, edits, then the About rows (anchored on the credit rows)
    patch_edits(ctx, pkg)
    patch_ruleset_details(ctx, pkg)
    patch_files(ctx, pkg)
    patch_layer(ctx, pkg, target_name, target)  # after the text passes: injected files ship exactly as rendered
    raster_icons(ctx, pkg)


def parse_args(argv):
    args = {}
    flags = set()
    for a in argv:
        if "=" in a:
            k, v = a.split("=", 1)
            args[k] = v
        else:
            flags.add(a)
    return args, flags


def main(argv):
    args, flags = parse_args(argv)
    brand = load_brand(args.get("brand", os.path.join(HERE, "brand.json")))
    patch = load_patch(args.get("patch", os.path.join(HERE, "patch.json")))
    targets = load_targets(args.get("targets", os.path.join(HERE, "targets.json")))
    if "--check-config" in flags:
        if args.get("target"):  # the build checks its own target too, so a store build without source_url fails early
            get_target(targets, args["target"])
        print("thankmu config ok" + (f" (target {args['target']})" if args.get("target") else ""))
        return
    if "packageDir" not in args:
        die("usage: patch_extension.py packageDir=<dir> target=<dev|store|alpha> [brand=<file>] [patch=<file>] [targets=<file>]")
    target = get_target(targets, args.get("target"))
    patch_package(args["packageDir"], brand, patch, args["target"], target)
    ext = f", extension id {target['extension_id']}" if "extension_id" in target else ", no manifest key (store assigns the id)"
    print(f"thankmu: patched {args['packageDir']} as {target_brand(brand, target)['name']} (target {args['target']}, APP_ORIGIN {target['app_origin']}{ext})")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except PatchError as e:
        print(f"ERROR: thankmu patch: {e}", file=sys.stderr)
        sys.exit(1)
