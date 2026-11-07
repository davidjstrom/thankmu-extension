#!/usr/bin/env python3
"""Checks on a finished release zip (a file a release publishes), read from the zip itself.
Usage: check_store_zip.py <zip> <targets.json> <X.Y.Z> [target]      (target defaults to "store")

A chrome-vX.Y.Z tag publishes one zip per release target (thankmu/patch_extension.py RELEASE_TARGETS):
"store", uploaded to the Chrome Web Store, and "alpha", handed to testers directly. Both go to the
public, so both get these same checks; the one difference is the extension id, and it is the whole
reason the alpha target exists:

- manifest.json sits at the zip root and is valid JSON
- the extension id:
  * a target with no manifest_key (store) must carry no "key": the Chrome Web Store assigns the id
  * a target with a manifest_key (alpha) must carry exactly that key, so the package installs under the
    id the app's PLUGIN_EXTENSION_IDS lists. A zip installed from a file with no key gets a fresh random
    id on every machine and can never pair, which no other check in the release path would notice.
- externally_connectable is exactly {"matches": ["<that target's app_origin>/*"]}, that origin only
- manifest version is X.Y.Z
- no log.txt (build log) in the package
- no placeholder source URL: the screenshot tooling's provisional package carries the reserved source.example.invalid
  domain as its GPLv3 source offer (store/screenshots/generate.sh); such a zip is for review only and never uploaded

The targets file is read through patch_extension.load_targets, so the config is fully validated here too:
in particular a manifest_key that does not derive the target's declared extension_id is refused there, which
is what lets the id below be reported from the config rather than recomputed.

Prints the facts it checked so the CI log is the record. Exits 1 on the first failure."""
import importlib.util
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

# RFC 2606 reserves .invalid; the provisional source offer uses source.example.invalid. Nothing real ever does.
PLACEHOLDER = b"source.example.invalid"


def fail(msg):
    print(f"RELEASE ZIP CHECK FAILED: {msg}", file=sys.stderr)
    sys.exit(1)


def load_targets(path):
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("thankmu_patch", os.path.join(REPO, "thankmu", "patch_extension.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    try:
        return mod.load_targets(path)
    except mod.PatchError as e:
        fail(f"cannot read {path}: {e}")


def main(argv):
    if len(argv) not in (3, 4):
        fail("usage: check_store_zip.py <zip> <targets.json> <X.Y.Z> [target]")
    zip_path, targets_path, version = argv[0], argv[1], argv[2]
    name = argv[3] if len(argv) == 4 else "store"
    targets = load_targets(targets_path)
    if name not in targets:
        fail(f"unknown target {name!r}; {targets_path} defines {sorted(targets)}")
    cfg = targets[name]
    origin = cfg["app_origin"]
    want_key = cfg.get("manifest_key")
    try:
        z = zipfile.ZipFile(zip_path)
    except (OSError, zipfile.BadZipFile) as e:
        fail(f"{zip_path} is not a readable zip: {e!r}")
    bad = z.testzip()
    if bad:
        fail(f"corrupt zip member: {bad}")
    names = z.namelist()
    if "manifest.json" not in names:
        fail("manifest.json is not at the zip root")
    try:
        m = json.loads(z.read("manifest.json"))
    except ValueError as e:
        fail(f"manifest.json is not valid JSON: {e}")
    if want_key is None:
        if "key" in m:
            fail(f"manifest.json carries a 'key': a {name} zip must not pin an extension id")
        shown_id = "assigned by the Chrome Web Store"
    else:
        if "key" not in m:
            fail(f"manifest.json carries no 'key': a {name} zip is installed from a file, so without the pinned key "
                 f"it gets a different extension id on every machine and can never pair "
                 f"(expected targets.json {name}.manifest_key, extension id {cfg['extension_id']})")
        if m["key"] != want_key:
            fail(f"manifest.json 'key' is not targets.json {name}.manifest_key, so the package would install under "
                 f"an id the app does not list (expected extension id {cfg['extension_id']})")
        shown_id = cfg["extension_id"]
    want = {"matches": [origin + "/*"]}
    if m.get("externally_connectable") != want:
        fail(f"externally_connectable is {m.get('externally_connectable')!r}, want {want!r}")
    if m.get("version") != version:
        fail(f"manifest version is {m.get('version')!r}, want {version!r}")
    for n in names:
        if n.rsplit("/", 1)[-1] == "log.txt":
            fail(f"build log in the package: {n}")
    for n in names:
        if PLACEHOLDER in z.read(n):
            fail(f"placeholder source URL ({PLACEHOLDER.decode()}) in {n}: a provisional package, never a submission")
    print(f"{name} zip ok: {len(names)} files, version {m['version']}, extension id {shown_id}, "
          f"externally_connectable {m['externally_connectable']['matches']}")
    print(f"  permissions: {m.get('permissions')}")
    print(f"  host_permissions: {m.get('host_permissions')}")
    print(f"  optional_host_permissions: {m.get('optional_host_permissions')}")


if __name__ == "__main__":
    main(sys.argv[1:])
