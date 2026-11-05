#!/usr/bin/env python3
"""Checks on the finished store zip (the file a release uploads), read from the zip itself.
Usage: check_store_zip.py <zip> <targets.json> <X.Y.Z>
- manifest.json sits at the zip root and is valid JSON
- no "key" (the Chrome Web Store assigns the extension id)
- externally_connectable is exactly {"matches": ["<store app_origin>/*"]}, the store target's origin only
- manifest version is X.Y.Z
- no log.txt (build log) in the package
- no placeholder source URL: the screenshot tooling's provisional package carries the reserved source.example.invalid
  domain as its GPLv3 source offer (store/screenshots/generate.sh); such a zip is for review only and never uploaded
Prints the facts it checked so the CI log is the record. Exits 1 on the first failure."""
import json
import sys
import zipfile

# RFC 2606 reserves .invalid; the provisional source offer uses source.example.invalid. Nothing real ever does.
PLACEHOLDER = b"source.example.invalid"


def fail(msg):
    print(f"STORE ZIP CHECK FAILED: {msg}", file=sys.stderr)
    sys.exit(1)


def main(argv):
    if len(argv) != 3:
        fail("usage: check_store_zip.py <zip> <targets.json> <X.Y.Z>")
    zip_path, targets_path, version = argv
    try:
        store = json.load(open(targets_path))["store"]
        origin = store["app_origin"]
    except (OSError, ValueError, KeyError) as e:
        fail(f"cannot read the store target from {targets_path}: {e!r}")
    if "manifest_key" in store:
        fail("targets.json: the store target carries a manifest_key; the store assigns its own id")
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
    if "key" in m:
        fail("manifest.json carries a 'key': a store zip must not pin an extension id")
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
    print(f"store zip ok: {len(names)} files, version {m['version']}, no key, "
          f"externally_connectable {m['externally_connectable']['matches']}")
    print(f"  permissions: {m.get('permissions')}")
    print(f"  host_permissions: {m.get('host_permissions')}")
    print(f"  optional_host_permissions: {m.get('optional_host_permissions')}")


if __name__ == "__main__":
    main(sys.argv[1:])
