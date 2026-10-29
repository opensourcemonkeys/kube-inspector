#!/usr/bin/env python3
"""WCAG contrast scan over the capture.py screens, in every theme.

For each scenario it measures every visible text node against the background
actually painted behind it (semi-transparent layers composited up to the first
opaque ancestor) and records the pairs below AA: 4.5:1 for body text, 3:1 for
large text (>= 24px, or >= 18.66px at 600+). Disabled controls are skipped, as
WCAG exempts inactive components. Results are grouped by (theme, colours,
element class) so one bad token shows up once rather than per row.

    KUBE_INS_URL=http://localhost:5173/ python3 scripts/ui/contrast_scan.py
    → scripts/ui/out/contrast/report.json + a summary on stdout

Env: KUBE_INS_URL, THEMES, ONLY / SKIP (as capture.py).
"""
import json
import os
import sys
import time

sys.argv = sys.argv[:1] + ["contrast"]  # capture.py reads its label from argv
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import capture  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "contrast")

SCAN_JS = r"""
const parse = (c) => {
  let m = c.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  m = c.match(/^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+))?\)/);
  if (m) return [m[1] * 255, m[2] * 255, m[3] * 255, m[4] === undefined ? 1 : +m[4]];
  return null;
};
const over = (top, bottom) => {            // composite top (with alpha) over an opaque bottom
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
};
const lum = (c) => {
  const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
  return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]);
};
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const bgOf = (el) => {
  const layers = [];
  for (let e = el; e; e = e.parentElement) {
    const c = parse(getComputedStyle(e).backgroundColor);
    if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
  }
  let bg = [255, 255, 255, 1];             // nothing opaque: the canvas default
  for (let i = layers.length - 1; i >= 0; i--) bg = layers[i][3] >= 1 ? layers[i] : over(layers[i], bg);
  return bg;
};
const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const out = [];
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
const seen = new Set();
for (let n = walker.nextNode(); n; n = walker.nextNode()) {
  if (!n.textContent.trim()) continue;
  const el = n.parentElement;
  if (!el || seen.has(el)) continue;
  seen.add(el);
  if (el.closest('canvas, svg, .sr-only, [aria-hidden="true"], .react-flow__minimap, :disabled, .p-disabled, [disabled]')) continue;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden') continue;
  let op = 1; for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity;
  if (op < 0.99) continue;                 // faded on purpose (a disabled-looking hint); reported separately if needed
  const fg0 = parse(cs.color); if (!fg0) continue;
  const bg = bgOf(el);
  const fg = fg0[3] < 1 ? over(fg0, bg) : fg0;
  const size = parseFloat(cs.fontSize), weight = +cs.fontWeight || 400;
  const large = size >= 24 || (size >= 18.66 && weight >= 600);
  const need = large ? 3 : 4.5;
  const k = ratio(fg, bg);
  if (k < need) out.push({ fg: hex(fg), bg: hex(bg), ratio: +k.toFixed(2), need, size,
    cls: (el.className && typeof el.className === 'string' ? el.className : el.tagName.toLowerCase()).split(' ').slice(0, 2).join('.'),
    text: n.textContent.trim().slice(0, 30) });
}
return out;
"""

SCENES = {"overview", "pods", "pod-detail", "events", "nodes", "monitoring", "securityrolemap", "trivy",
          "deployments", "pod-yaml", "pod-logs", "pod-describe", "configmap-editor", "crd-instances",
          "terminal", "port-forwards", "diagnostics", "ai-log", "about-modal", "update-modal",
          "cluster-modal", "menu-open", "cluster-dropdown", "delete-dialog", "list-selection", "tour-2",
          "toolbox", "history-overview", "cluster-history", "history-range", "object-history"}


def main():
    os.makedirs(OUT, exist_ok=True)
    results = []
    for theme in capture.THEMES:
        print(f"[{theme}]")
        d = capture.make_driver(1440, 900)
        for name, fn in capture.SCENARIOS:
            if name not in SCENES or (capture.ONLY and name not in capture.ONLY) or name in capture.SKIP:
                continue
            try:
                capture.boot(d, theme)

                def shot(settle, _name=name):
                    time.sleep(settle)
                    for f in d.execute_script(SCAN_JS):
                        results.append({"theme": theme, "screen": _name, **f})

                fn(d, shot)
                print(f"  {name}")
            except capture.Skip as e:
                print(f"  SKIP {name}: {e}")
            except Exception as e:  # noqa: BLE001
                print(f"  ERROR {name}: {type(e).__name__}")
                d.quit()
                d = capture.make_driver(1440, 900)
        d.quit()

    with open(os.path.join(OUT, "report.json"), "w") as fh:
        json.dump(results, fh, indent=2, ensure_ascii=False)

    groups = {}
    for r in results:
        key = (r["theme"], r["fg"], r["bg"], r["cls"])
        g = groups.setdefault(key, {**r, "screens": set(), "count": 0})
        g["screens"].add(r["screen"])
        g["count"] += 1
    print(f"\n{len(results)} failing text nodes, {len(groups)} distinct pairs")
    for (theme, fg, bg, cls), g in sorted(groups.items(), key=lambda kv: (kv[0][0], kv[1]["ratio"])):
        print(f"{theme:13} {g['ratio']:5}/{g['need']:<3} {fg} on {bg}  {cls:38.38} ×{g['count']:<3} "
              f"{','.join(sorted(g['screens']))[:60]}  “{g['text']}”")


if __name__ == "__main__":
    main()
