#!/usr/bin/env python3
"""EX-002 (a): in thankmu/targets.json, store.source_url is the one place a given host may appear.

Usage: check_exempt_source_url.py <targets.json> <host>

The GPLv3 source offer has to name the public source location (W-P4 item 9), and that location is on
a host this project otherwise never references: development is on git.draglabs.com only, and the one
public repo there is a distribution channel, not a development host (EX-002 (a); ADR-013 "Source
publication"). The exemption is that one field, not the file. So every occurrence of <host> in the
file must sit inside the value of store.source_url and nowhere else: not in _doc, not in a key, not
in another target's source_url. The host is an argument rather than a constant here so that naming it
does not put it in a project-owned file, which is the rest of the rule (tests/run.sh "repo hygiene").

Prints nothing and exits 0 when the rule holds; exits 1 with the offending locations otherwise.
"""
import json
import sys

EXEMPT = ("store", "source_url")
EXEMPT_PATH = ".".join(EXEMPT)


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

    target = doc.get(EXEMPT[0])
    exempt = target.get(EXEMPT[1]) if isinstance(target, dict) else None
    allowed = exempt.lower().count(host) if isinstance(exempt, str) else 0
    if total == allowed:
        return

    others = sorted({p for p, s in walk(doc) if host in s.lower()} - {EXEMPT_PATH})
    where = ", ".join(others) if others else "in a key or outside any string value"
    fail(
        f"{path}: that host is permitted in {EXEMPT_PATH} only (EX-002 (a)); "
        f"{total - allowed} other occurrence(s), {where}"
    )


if __name__ == "__main__":
    main(sys.argv)
