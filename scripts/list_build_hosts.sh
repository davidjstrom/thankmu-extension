#!/usr/bin/env bash
# Print the distinct hosts a build downloads filter lists from, one per line.
# Source of truth: the "urls" arrays in chrome_plugin/platform/mv3/rulesets.json (homeURL fields are
# documentation links and are not fetched). Needs python3 only (the CI host has no jq).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"
f="$HERE/../$UBO_PREFIX/platform/mv3/rulesets.json"
[ -f "$f" ] || die "rulesets.json missing: $f"
python3 -I - "$f" <<'PY'
import json, sys
from urllib.parse import urlsplit
hosts = set()
for rs in json.load(open(sys.argv[1])):
    for u in rs.get("urls", []):
        h = urlsplit(u).hostname
        if not h:
            sys.exit(f"ERROR: no host in url {u!r}")
        hosts.add(h)
if not hosts:
    sys.exit("ERROR: rulesets.json lists no urls")
print("\n".join(sorted(hosts)))
PY
