#!/usr/bin/env python3
"""Fail when a literal colour appears in the ThankMu layer outside css/thankmu-tokens.css (design handoff rule:
"colour only from tokens", W-P4). Usage: check_no_literal_colours.py [<dir>]   (default: thankmu/ext)

Looks in every CSS, JS and HTML file of the layer (collocated tests excluded) for hex colours, colour functions
(any case), any of the 148 CSS named colours in any declaration value (stylesheets, CSS in JS templates, style
attributes, gradients included), and a quoted string that is just a colour name (style.color = "red",
setProperty('color', 'red'), <font color="red">). Use var(--name).
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOKENS = "thankmu-tokens.css"
HEX = re.compile(r"#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b")
FUNC = re.compile(r"(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(", re.I)
# The 148 CSS named colours ("transparent" and "currentcolor" are not literals and stay allowed).
NAMES = ('aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen')
NAME = r"(?<![\w-])(?:" + "|".join(NAMES) + r")(?![\w-])"
WORD = re.compile(NAME, re.I)
# A quoted JS string, or an HTML attribute value, that is exactly a colour name: el.style.color = "red",
# style.setProperty('color', 'red'), <font color="red">.
QUOTED = re.compile(r"""(["'`])\s*(?:""" + "|".join(NAMES) + r""")\s*\1""", re.I)
DECL = re.compile(r"(?<![\w.#-])([a-zA-Z-]+)\s*:\s*([^;{}]+)")
STRIP = re.compile(r"var\([^)]*\)|url\([^)]*\)|\"[^\"]*\"|'[^']*'")


def declarations(text):
    """(property, value) pairs found anywhere in text: a stylesheet, or CSS inside a JS template or an HTML style."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    for m in DECL.finditer(text):
        if not m.group(1).startswith("--"):
            yield m.group(1), STRIP.sub(" ", m.group(2))


def scan(root):
    found, n = [], 0
    for dp, _, fs in os.walk(root):
        for f in sorted(fs):
            if f == TOKENS or not f.endswith((".css", ".js", ".mjs", ".html")) or f.endswith(".test.mjs"):
                continue
            n += 1
            rel = os.path.relpath(os.path.join(dp, f), root)
            with open(os.path.join(dp, f), encoding="utf8") as fh:
                text = fh.read()
            for rx in (HEX, FUNC, QUOTED):
                for m in rx.finditer(text):
                    found.append(f"{rel}: literal colour {m.group(0)[:48]!r}")
            for prop, value in declarations(text):
                for m in WORD.finditer(value):
                    found.append(f"{rel}: literal colour {m.group(0)!r} in {prop}: ...")
    return found, n


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(HERE), "thankmu", "ext")
    found, n = scan(root)
    if n == 0:
        print(f"ERROR: no CSS, JS or HTML files under {root}", file=sys.stderr)
        return 1
    if found:
        print("ERROR: literal colours outside the tokens file (use var(--name)):", file=sys.stderr)
        for line in found:
            print("  " + line, file=sys.stderr)
        return 1
    print(f"ok: {n} files, no literal colour")
    return 0


if __name__ == "__main__":
    sys.exit(main())
