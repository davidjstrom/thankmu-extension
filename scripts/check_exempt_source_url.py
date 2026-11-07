#!/usr/bin/env python3
"""EX-002 (a): in thankmu/targets.json, the release targets' source_url is the only place a given host may appear.

Usage: check_exempt_source_url.py <targets.json> <host>

The GPLv3 source offer has to name the public source location (W-P4 item 9), and that location is on
a host this project otherwise never references: development is on git.draglabs.com only, and the one
public repo there is a distribution channel, not a development host (EX-002 (a); ADR-013 "Source
publication"). The exemption is those fields, not the file. So every occurrence of <host> in the
file must sit inside the source_url of a target a release tag publishes -- store and alpha, both
distributed to the public, both carrying the offer -- and nowhere else: not in _doc, not in a key,
not in the source_url of a target that is never published (dev). The host is an argument rather than
a constant here so that naming it does not put it in a project-owned file, which is the rest of the
rule (tests/run.sh "repo hygiene").

Those two fields must hold the same URL anyway (one tag publishes the source once); that is enforced
in thankmu/patch_extension.py load_targets, where the whole config is validated. This file is only
about where the host is allowed to be written down.

Prints nothing and exits 0 when the rule holds; exits 1 with the offending locations otherwise.
"""
import json
import sys

# The targets a chrome-vX.Y.Z tag builds and publishes; kept in step with RELEASE_TARGETS in
# thankmu/patch_extension.py. Not imported from there: this check is run by the repo-hygiene scan on
# a targets file alone and stays free of the patch step's imports.
EXEMPT_TARGETS = ("store", "alpha")
FIELD = "source_url"
EXEMPT_PATHS = tuple(f"{t}.{FIELD}" for t in EXEMPT_TARGETS)
EXEMPT_PATH = " or ".join(EXEMPT_PATHS)


def fail(msg):
    sys.exit(f"ERROR: {msg}")


def walk(node, path=()):
    """Every string VALUE in the document, with its dotted path."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield from walk(value, path + (key,))
    elif isinstance(node, list):
        for i, value in enumerate(node):
            yield from walk(value, path + (str(i),))
    elif isinstance(node, str):
        yield ".".join(path), node


def main(argv):
    if len(argv) != 3:
        fail("usage: check_exempt_source_url.py <targets.json> <host>")
    path, host = argv[1], argv[2].lower()
    if not host:
        fail("the host argument is empty: nothing would be checked")
    try:
        raw = open(path, encoding="utf-8").read()
    except OSError as e:
        fail(f"cannot read {path}: {e}")
    # The whole file text, so an occurrence in a key, in _doc or in JSON whitespace counts too.
    total = raw.lower().count(host)
    try:
        doc = json.loads(raw)
    except ValueError as e:
        fail(f"{path} is not valid JSON: {e}")
    if not isinstance(doc, dict):
        fail(f"{path} must be a JSON object of targets")

    # Every exempt field that is actually present; a release target the file does not define contributes nothing.
    allowed = 0
    for name in EXEMPT_TARGETS:
        target = doc.get(name)
        value = target.get(FIELD) if isinstance(target, dict) else None
        if isinstance(value, str):
            allowed += value.lower().count(host)
    if total == allowed:
        return

    others = sorted({p for p, s in walk(doc) if host in s.lower()} - set(EXEMPT_PATHS))
    where = ", ".join(others) if others else "in a key or outside any string value"
    fail(
        f"{path}: that host is permitted in {EXEMPT_PATH} only (EX-002 (a)); "
        f"{total - allowed} other occurrence(s), {where}"
    )


if __name__ == "__main__":
    main(sys.argv)
