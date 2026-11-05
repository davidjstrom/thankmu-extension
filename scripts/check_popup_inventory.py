#!/usr/bin/env python3
"""Upstream's popup survives the ThankMu popup (W-P6): every upstream control and readout is still there and wired.

Usage: check_popup_inventory.py <unpatchedDir> <patchedDir>

The founder's rule for W-P6: incorporate the D2 popup, never drop an upstream function. The inventory below is the
table in docs/rebrand.md "Popup (W-P6)". For a built package this checks that:
  * upstream's popup has exactly the inventoried controls (an id, a tabindex or a filtering-mode level): a control
    upstream adds or removes fails here until the inventory and the doc table are updated;
  * each one is in the patched popup.html exactly once, inside <main>, between the ThankMu head frame and the ThankMu
    account frame (so neither frame replaces or hides it);
  * upstream's popup scripts are the same tags, and js/popup.js is byte-identical and still wires each control
    (the selector or message it uses), so the behaviour is upstream's own;
  * nothing else changed: the patched popup.html minus the two frame lines is upstream's popup.html byte for byte
    (so no hidden attribute, inline style, class or extra element on upstream's controls), each frame line has exactly
    the allowed shape (an in-flow block: no position, overlay or hiding), and every stylesheet the popup links is
    byte-identical to upstream's.
"""
import os
import re
import sys

# (what, marker in popup.html, what js/popup.js uses to wire it). Order: as upstream lays them out.
INVENTORY = [
    ("hostname of the current site", 'id="hostname"', "'#hostname'"),
    ("filtering-mode slider (drag)", 'class="filteringModeButton"', "'.filteringModeButton', 'mousedown'"),
    ("filtering mode: no filtering", 'data-level="0"', "'.filteringModeSlider span[data-level]'"),
    ("filtering mode: basic", 'data-level="1"', "'.filteringModeSlider span[data-level]'"),
    ("filtering mode: optimal", 'data-level="2"', "'.filteringModeSlider span[data-level]'"),
    ("filtering mode: complete", 'data-level="3"', "'.filteringModeSlider span[data-level]'"),
    ("filtering mode name", 'id="filteringModeText"', "'#filteringModeText > span:nth-of-type(1)'"),
    ("Remove an element (zapper)", 'id="gotoZapper"', "'#gotoZapper'"),
    ("Create a custom filter (picker)", 'id="gotoPicker"', "'#gotoPicker'"),
    ("Remove a custom filter (unpicker)", 'id="gotoUnpicker"', "'#gotoUnpicker'"),
    ("Report an issue", 'id="gotoReport"', "'#gotoReport'"),
    ("Show matched rules (developer mode)", 'id="gotoMatchedRules"', "'#gotoMatchedRules'"),
    ("Dashboard (settings)", 'id="gotoDashboard"', "'#gotoDashboard'"),
    ("busy spinner", "<aside>", "'busy'"),
]
HEAD_FRAME = '<iframe id="thankmuHead" '
ACCOUNT_FRAME = '<iframe id="thankmuPrompts" '
CONTROL_RE = re.compile(r'<(?!html\b)[a-zA-Z][^>]*\b(?:id|tabindex|data-level)="[^"]*"[^>]*>')
SCRIPT_RE = re.compile(r"<script\b[^>]*>", re.I)
# A ThankMu frame line, exactly as the patch step writes it (patch.json popup.html edits). The style may only size the
# frame in the flow: anything else (position, inset, z-index, opacity, display other than block) fails.
FRAME_LINE_RE = re.compile(
    r'^[ ]*<iframe id="thankmu(?:Head|Prompts)" src="thankmu-popup\.html(?:\?part=head)?" title="[^"<>]*" '
    r'style="display: block; width: 100%; (?:min-width: [0-9.]+rem; )?height: [0-9]+px; border: 0"></iframe>\n', re.M)
ANY_FRAME_LINE_RE = re.compile(r'^[^\n]*<iframe\b[^\n]*\n', re.M | re.I)
STYLESHEET_RE = re.compile(r'<link rel="stylesheet" href="([^"]+)"')


def read(path):
    with open(path, encoding="utf8") as f:
        return f.read()


def problems(unpatched, patched):
    out = []
    up_html = read(os.path.join(unpatched, "popup.html"))
    html = read(os.path.join(patched, "popup.html"))
    known = {m for _, m, _ in INVENTORY}
    for tag in CONTROL_RE.findall(up_html):
        if not any(m in tag for m in known):
            out.append(f"upstream popup control not in the inventory: {tag} (add it here and to docs/rebrand.md)")
    for what, marker, _ in INVENTORY:
        if up_html.count(marker) != 1:
            out.append(f"upstream popup.html no longer has {what} ({marker}) exactly once: update the inventory")
    if html.count(HEAD_FRAME) != 1 or html.count(ACCOUNT_FRAME) != 1:
        return out + ["patched popup.html must have the ThankMu head and account frames exactly once each"]
    main_i, main_j = html.find("<main>"), html.find("</main>")
    head_i, acct_i = html.index(HEAD_FRAME), html.index(ACCOUNT_FRAME)
    if not (0 <= main_i < head_i < acct_i < main_j):
        out.append("the ThankMu frames must both sit inside upstream's <main>, head first")
    for what, marker, _ in INVENTORY:
        n = html.count(marker)
        if n != 1:
            out.append(f"{what}: {marker} appears {n} times in the patched popup, expected once")
            continue
        i = html.index(marker)
        if marker == "<aside>":
            if i < main_j:
                out.append(f"{what}: must stay after <main>")
        elif not head_i < i < acct_i:
            out.append(f"{what}: must sit between the ThankMu head frame and the account frame")
    frame_lines = ANY_FRAME_LINE_RE.findall(html)
    good = FRAME_LINE_RE.findall(html)
    if len(frame_lines) != 2 or len(good) != 2:
        out.append(f"popup.html: expected exactly the two ThankMu frame lines in their allowed shape, found {len(frame_lines)} "
                   f"iframe line(s), {len(good)} well-formed: {frame_lines}")
    elif FRAME_LINE_RE.sub("", html) != up_html:
        out.append("popup.html: without the two ThankMu frame lines it must equal upstream's popup.html byte for byte "
                   "(an upstream control was hidden, restyled or covered)")
    for href in STYLESHEET_RE.findall(up_html):
        if read(os.path.join(unpatched, href)) != read(os.path.join(patched, href)):
            out.append(f"{href} differs from upstream: the popup's controls must keep upstream's styles")
    if SCRIPT_RE.findall(up_html) != SCRIPT_RE.findall(html):
        out.append("popup.html: upstream's script tags changed")
    up_js = read(os.path.join(unpatched, "js", "popup.js"))
    js = read(os.path.join(patched, "js", "popup.js"))
    if up_js != js:
        out.append("js/popup.js differs from upstream: the popup's behaviour must stay upstream's own")
    for what, _, wiring in INVENTORY:
        if wiring not in js:
            out.append(f"{what}: js/popup.js no longer wires it ({wiring})")
    return out


def main(argv):
    if len(argv) != 2:
        print("usage: check_popup_inventory.py <unpatchedDir> <patchedDir>", file=sys.stderr)
        return 2
    try:
        probs = problems(*argv)
    except (OSError, ValueError) as e:
        print(f"ERROR: popup inventory: {e}", file=sys.stderr)
        return 1
    if probs:
        for p in probs:
            print(f"ERROR: popup inventory: {p}", file=sys.stderr)
        return 1
    print(f"popup inventory: all {len(INVENTORY)} upstream controls and readouts present, between the ThankMu frames, "
          "wired by upstream's unchanged js/popup.js")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
