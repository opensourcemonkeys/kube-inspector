#!/usr/bin/env python3
"""Screenshots for the documentation site (docs/assets/screenshots/).

Same driver and helpers as capture.py, but at the size the site uses — a
1728x1054 viewport at device scale 2, which is the 3456x2108 the existing
images have — and only in the default theme. Each scene recreates what the
image it replaces showed.

Output goes to scripts/ui/out/docs/ (gitignored) so the images can be
reviewed before they are copied over the published ones:

    KUBE_INS_URL=http://localhost:5173/ python3 scripts/ui/docs_shots.py
    cp scripts/ui/out/docs/*.png docs/assets/screenshots/

Env: KUBE_INS_URL, ONLY (comma list of image names). cli-pods.png is the
terminal UI and is not produced here.
"""
import os
import sys
import time

from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import capture  # noqa: E402  (reuses the driver and navigation helpers)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "docs")
ONLY = set(filter(None, os.environ.get("ONLY", "").split(",")))
W, H = 1728, 1054


def make_driver():
    d = capture.make_driver(W, H)
    d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
        "width": W, "height": H, "deviceScaleFactor": 2, "mobile": False,
    })
    return d


def dblclick_row(d, text=None):
    """Double-click the first table row (or the first whose text contains `text`)."""
    for _ in range(10):  # the first poll may still be in flight
        rows = d.find_elements(By.CSS_SELECTOR, ".p-datatable-tbody > tr:not(.p-datatable-emptymessage)")
        for r in rows:
            if text is None or text in r.text:
                cells = r.find_elements(By.CSS_SELECTOR, "td")
                ActionChains(d).double_click(cells[1] if len(cells) > 1 else r).perform()
                return True
        time.sleep(1)
    return False


def type_in_terminal(d, index, command):
    """Type into an xterm. The text goes in as one IME commit: per-key events
    are mapped through the host keyboard layout, which turned `-A` into `=A`."""
    area = d.find_elements(By.CSS_SELECTOR, ".xterm-helper-textarea")[index]
    d.execute_script("arguments[0].focus()", area)
    d.execute_cdp_cmd("Input.insertText", {"text": command})
    area.send_keys(Keys.ENTER)


def drag_tab_to_right(d, title_part):
    """Drag a tab onto the right edge of the content area: dockview splits the group."""
    tab = next(t for t in d.find_elements(By.CSS_SELECTOR, ".dv-tab") if title_part in t.text)
    content = d.find_elements(By.CSS_SELECTOR, ".dv-content-container")[0]
    rect = content.rect
    ac = ActionChains(d)
    ac.click_and_hold(tab).pause(0.2).move_by_offset(20, 20).pause(0.2)
    ac.move_to_element_with_offset(content, int(rect["width"] / 2 - 30), 0).pause(0.4)
    ac.release().perform()


# ── scenes ──────────────────────────────────────────────────────────────────

def pods(d):
    capture.nav(d, "Pods"); time.sleep(3)


def deployments(d):
    capture.nav(d, "Deployments"); time.sleep(3)


def monitoring(d):
    # metrics-server is point-in-time; the trend lines are what the open
    # dashboard has collected, so give it time to draw a line.
    capture.nav(d, "Monitoring"); time.sleep(3)
    # The range picker is the one dropdown in the panel that reads "… min".
    d.execute_script("[...document.querySelectorAll('.dv-content-container .p-dropdown')].find(e => /min|hour/.test(e.textContent))?.click()")
    time.sleep(0.6)
    capture.js_click_text(d, ".p-dropdown-item", "5 min")
    time.sleep(240)


def security_role_map(d):
    capture.nav(d, "Security Role Map"); time.sleep(6)
    d.execute_script("""
        for (const n of document.querySelectorAll('.react-flow__node')) {
            if (n.textContent.includes('metrics-server') && n.textContent.toLowerCase().includes('serviceaccount')) { n.click(); return; }
        }""")
    time.sleep(1.5)
    # The whole map fits by default, which leaves the chain too small to read.
    for _ in range(2):
        d.execute_script("document.querySelector('.react-flow__controls-zoomin')?.click()")
        time.sleep(0.4)
    time.sleep(1)


def network_policies(d):
    capture.nav(d, "Network Policies"); time.sleep(3)
    capture.need(dblclick_row(d), "no network policy")
    time.sleep(4)


def yaml_editor(d):
    capture.nav(d, "Deployments"); time.sleep(3)
    capture.need(dblclick_row(d, "nginx") or dblclick_row(d), "no deployment")
    time.sleep(4)


def split_view(d):
    capture.nav(d, "Deployments"); time.sleep(3)
    capture.need(dblclick_row(d, "nginx") or dblclick_row(d), "no deployment")
    time.sleep(4)
    drag_tab_to_right(d, "/nginx")
    time.sleep(2)


def terminal(d):
    capture.menu(d, "Open", "Terminal"); time.sleep(4)
    capture.menu(d, "Open", "Terminal"); time.sleep(4)
    drag_tab_to_right(d, "Terminal 2")
    time.sleep(2)
    type_in_terminal(d, 0, "kubectl get deployments -A")
    type_in_terminal(d, 1, "kubectl get nodes -o wide && kubectl top pods -A | head -20")
    time.sleep(5)


def vulnerability_scan(d):
    capture.nav(d, "Vulnerability Scan"); time.sleep(2)
    capture.js_click_text(d, ".p-tabview-nav-link", "Image Scan", exact=False)
    time.sleep(0.5)
    field = d.find_element(By.CSS_SELECTOR, ".p-tabview-panel:not([hidden]) input.p-inputtext")
    field.clear(); field.send_keys("nginx:1.16")
    capture.js_click_text(d, "button", "Scan image", exact=False)
    for _ in range(90):  # the DB is local; a scan of one image takes well under this
        time.sleep(2)
        if d.find_elements(By.CSS_SELECTOR, ".p-tabview-panel:not([hidden]) .p-datatable-tbody > tr:not(.p-datatable-emptymessage)"):
            break
    time.sleep(1.5)


SCENES = [
    ("pods", pods),
    ("deployments", deployments),
    ("monitoring", monitoring),
    ("security-role-map", security_role_map),
    ("network-policies", network_policies),
    ("yaml-editor", yaml_editor),
    ("split-view", split_view),
    ("terminal", terminal),
    ("vulnerability-scan", vulnerability_scan),
]


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, scene in SCENES:
        if ONLY and name not in ONLY:
            continue
        d = make_driver()
        try:
            capture.boot(d, "graphite")
            scene(d)
            if name != "terminal":  # a terminal keeps its cursor; elsewhere a focus ring is noise
                d.execute_script("document.activeElement?.blur()")
                time.sleep(0.3)
            d.save_screenshot(os.path.join(OUT, f"{name}.png"))
            print(f"{name}: ok")
        except Exception as e:  # keep going, report what failed
            print(f"{name}: error ({e})")
        finally:
            d.quit()
