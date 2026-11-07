#!/usr/bin/env python3
"""The repo CI pushes the released source to must be the repo the GPLv3 source offer points at.

Usage: check_snapshot_repo_url.py <targets.json>      (reads SNAPSHOT_REPO_URL from the environment)

Two sides name the public source repo and nothing has ever compared them (W-P4 item 10):

  SNAPSHOT_REPO_URL            the push URL, a Protected CI variable, deliberately in no tracked
                               file (EX-002: that is what keeps the host out of this repo).
  thankmu/targets.json
    store.source_url           the offer printed in the shipped About pane and the store listing
                               (GPLv3 section 6(d); EX-002 (a), the one field permitted to name it).

If they disagree, the release still succeeds and is still wrong: the source is published to one repo
while every copy of the package tells the reader to look in another. The licence obligation is not
met, and nothing in the build or the push can notice, because neither half can see the other.

This is not a string comparison. The two spell the same repo differently by design -- the push URL
ends ".git" and the browse URL does not -- so what is compared is repo identity: host (lowercased,
"www." dropped), port, and path with a trailing slash and a trailing ".git" removed, lowercased.
The scheme is deliberately left out: the push URL must be https or loopback (publish_source_snapshot.sh)
and the offer must be https (patch_extension.py), each enforced where it belongs, and a scheme
difference between them never means a different repo. Userinfo is ignored too, so a credential
accidentally left in the variable cannot make an otherwise-correct pair look like a mismatch -- and
because this file tolerates userinfo, it must never print it: SNAPSHOT_REPO_URL is Protected but not
masked, and every message here goes to the job log, which is readable long after the job. So the URLs
are printed through shown(), with any userinfo replaced.

Being generous about spelling is the point. A false alarm here is expensive: the publish step runs
after the store zip is built, so a refusal late in the release job discards the artifact and spends
the tag. A missed mismatch is worse, which is why the comparison exists at all -- but it must only
fire on a genuinely different repo.

Prints one line and exits 0 when they agree; exits 1 naming both sides otherwise.
"""
import json
import os
import sys
from urllib.parse import urlsplit

FIELD = ("store", "source_url")
FIELD_PATH = ".".join(FIELD)
VAR = "SNAPSHOT_REPO_URL"


def fail(msg):
    sys.exit(f"ERROR: {msg}")


def shown(url):
    """The URL as it is safe to print: any userinfo replaced, so a credential left in the variable
    cannot reach the job log. Deliberately text-only, so it also works on a URL urlsplit rejected,
    and applied to both sides, so no future message has to remember which one can carry a secret."""
    head, sep, rest = url.partition("//")
    authority, slash, tail = (rest if sep else url).partition("/")
    if "@" in authority:
        authority = "***@" + authority.rpartition("@")[2]
    return f"{head if sep else ''}{sep}{authority}{slash}{tail}"


def canon(url, what):
    """Repo identity: host[:port]/path, with .git, a trailing slash and case normalised away."""
    try:
        u = urlsplit(url)
    except ValueError as e:
        fail(f"{what} is not a URL ({e}): {shown(url)!r}")
    host = (u.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    if not host:
        fail(f"{what} names no host: {shown(url)!r}")
    try:
        port = u.port
    except ValueError as e:
        fail(f"{what} has no usable port ({e}): {shown(url)!r}")
    path = u.path.rstrip("/")
    if path.endswith(".git"):
        path = path[:-4]
    path = path.rstrip("/").lower()
    # A host with no path is not a repository, so neither side may be one: the offer would send the
    # reader to a host's front page, and the push would have nowhere to go.
    if not path:
        fail(f"{what} names a host but no repository: {shown(url)!r}")
    return f"{host}{f':{port}' if port else ''}{path}"


def main(argv):
    if len(argv) != 2:
        fail("usage: check_snapshot_repo_url.py <targets.json>")
    targets = argv[1]
    pushed = os.environ.get(VAR, "")
    if not pushed:
        fail(f"{VAR} is not set: cannot check it against {FIELD_PATH}")
    try:
        doc = json.loads(open(targets, encoding="utf-8").read())
    except OSError as e:
        fail(f"cannot read {targets}: {e}")
    except ValueError as e:
        fail(f"{targets} is not valid JSON: {e}")
    if not isinstance(doc, dict):
        fail(f"{targets} must be a JSON object of targets")

    target = doc.get(FIELD[0])
    offered = target.get(FIELD[1]) if isinstance(target, dict) else None
    if not isinstance(offered, str) or not offered:
        fail(
            f"{targets} has no {FIELD_PATH}: there is no source offer to check {VAR} against, "
            "and a store build cannot be released without one"
        )

    if canon(pushed, VAR) != canon(offered, FIELD_PATH):
        fail(
            f"the released source would be published where the source offer does not point.\n"
            f"  {VAR} (CI variable) pushes to: {shown(pushed)}\n"
            f"  {FIELD_PATH} offers readers:   {shown(offered)}\n"
            "These must be the same repository. Fix whichever is wrong before cutting the tag: the\n"
            "variable in the project's CI settings, or the field in thankmu/targets.json (one line,\n"
            "and the only tracked place that host may appear -- EX-002 (a))."
        )
    print(f">> snapshot target ok: {VAR} and {FIELD_PATH} name the same repository")


if __name__ == "__main__":
    main(sys.argv)
