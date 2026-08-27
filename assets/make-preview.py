#!/usr/bin/env python3
"""Render assets/preview.svg from the real HUD output.

Feeds a sample statusLine payload through statusline/hud.mjs and converts the
ANSI colours it emits into SVG tspans, so the preview is exactly what the
terminal shows. Run from the repo root: python3 assets/make-preview.py
"""
import json, os, re, subprocess, tempfile, time, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SID = "preview-sample"
tmp = tempfile.gettempdir()
# Pre-seed the per-session files so the sample shows a 42m uptime and a Δ$.
pathlib.Path(tmp, f"claude-statusline-start.{SID}").write_text(str(int((time.time() - 42 * 60) * 1000)))
pathlib.Path(tmp, f"claude-statusline-cost.{SID}").write_text("1.16")

payload = {
    "session_id": SID,
    "model": {"display_name": "Fable 5"},
    "workspace": {"current_dir": str(ROOT)},
    "context_window": {
        "used_percentage": 12,
        "total_input_tokens": 61000,
        "total_output_tokens": 3,
        "current_usage": {"cache_read_input_tokens": 58000, "cache_creation_input_tokens": 2100},
    },
    "cost": {"total_cost_usd": 1.20},
}
out = subprocess.run(["node", str(ROOT / "statusline/hud.mjs")], input=json.dumps(payload),
                     capture_output=True, text=True, check=True).stdout.rstrip("\n")

# GitHub-dark palette for the ANSI codes hud.mjs uses.
COLORS = {"36": "#39c5cf", "32": "#3fb950", "33": "#d29922", "31": "#f85149", "35": "#d2a8ff"}
DEFAULT, DIM, BOLD = "#c9d1d9", "#8b949e", "#e6edf3"

def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def line_to_tspans(line, x, y):
    fill, dim, bold, spans, first = DEFAULT, False, False, [], True
    for tok in re.split(r"(\x1b\[[0-9;]*m)", line):
        if not tok:
            continue
        if tok.startswith("\x1b["):
            for code in tok[2:-1].split(";"):
                if code in ("0", ""): fill, dim, bold = DEFAULT, False, False
                elif code == "2": dim = True
                elif code == "1": bold = True
                elif code in COLORS: fill = COLORS[code]
            continue
        color = DIM if dim else (BOLD if bold and fill == DEFAULT else fill)
        pos = f' x="{x}" y="{y}"' if first else ""
        first = False
        spans.append(f'<tspan{pos} fill="{color}">{esc(tok)}</tspan>')
    return "".join(spans)

lines = out.split("\n")
W, LH, TOP = 760, 26, 88
H = TOP + LH * len(lines) + 24
svg = [
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
    'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" role="img" aria-label="claude-code-statusline preview">',
    '  <defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000" flood-opacity="0.35"/></filter></defs>',
    f'  <rect x="12" y="12" width="{W-24}" height="{H-24}" rx="12" fill="#0d1117" stroke="#30363d" stroke-width="1" filter="url(#shadow)"/>',
    f'  <rect x="12" y="12" width="{W-24}" height="40" rx="12" fill="#161b22"/><rect x="12" y="40" width="{W-24}" height="12" fill="#161b22"/>',
    '  <circle cx="36" cy="32" r="6" fill="#ff5f56"/><circle cx="56" cy="32" r="6" fill="#ffbd2e"/><circle cx="76" cy="32" r="6" fill="#27c93f"/>',
    f'  <text x="{W//2}" y="37" text-anchor="middle" font-size="13" fill="#6e7681">claude-code — statusline</text>',
]
for i, line in enumerate(lines):
    svg.append(f'  <text font-size="14.5" xml:space="preserve">{line_to_tspans(line, 34, TOP + LH * i)}</text>')
svg.append("</svg>")
(ROOT / "assets/preview.svg").write_text("\n".join(svg) + "\n")
print(f"wrote assets/preview.svg ({len(lines)} lines)")
