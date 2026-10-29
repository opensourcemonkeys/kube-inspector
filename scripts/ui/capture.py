"""
Screenshot every screen of the app, in every theme — for a before/after
comparison of a visual change, and as the scenario set contrast_scan.py and
docs_shots.py reuse.

Needs the dev backend + Vite running (the Electron window is not required):

    make electron-dev-go      # terminal 1
    make electron-dev-vite    # terminal 2
    python3 scripts/ui/capture.py before   # or: after

Uses the active cluster from ~/.kube-ins/.active. Output lands in
scripts/ui/out/<label>/<theme>/name.png (gitignored). File names are stable across
runs so before/ and after/ line up one to one. A screen that cannot be reached
(no pods, a menu item missing) is reported and skipped, never fatal.

Env: KUBE_INS_URL, THEMES (comma list), ONLY / SKIP (comma lists of scenario names),
ERROR_CLUSTER (a cluster whose API server is unreachable, for the error state),
HOME_CLUSTER (the cluster to switch back to afterwards).

`cluster-error` switches the active cluster, which is written to the shared
~/.kube-ins/.active — SKIP it while another instance of the app is running.
"""

import json
import os
import sys
import time

from selenium import webdriver
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

URL = os.environ.get("KUBE_INS_URL", "http://localhost:5173/")
THEMES = os.environ.get("THEMES", "graphite,daylight,last-samurai,god-of-war").split(",")
ONLY = set(filter(None, os.environ.get("ONLY", "").split(",")))
SKIP = set(filter(None, os.environ.get("SKIP", "").split(",")))
ERROR_CLUSTER = os.environ.get("ERROR_CLUSTER", "cluster 1")
HOME_CLUSTER = os.environ.get("HOME_CLUSTER", "default 3")

label = sys.argv[1] if len(sys.argv) > 1 else "before"
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", label)


# ── driver ──────────────────────────────────────────────────────────────────

def make_driver(width=1440, height=900):
    opts = webdriver.ChromeOptions()
    opts.add_argument("--headless=new")
    opts.add_argument("--lang=en-US")
    opts.add_argument("--hide-scrollbars")
    opts.add_argument("--disable-dev-shm-usage")
    d = webdriver.Chrome(options=opts)
    # --window-size includes browser chrome even headless; pin the viewport.
    d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
        "width": width, "height": height, "deviceScaleFactor": 1, "mobile": False,
    })
    return d


def boot(d, theme):
    d.get(URL)
    d.execute_script(
        "localStorage.setItem('kube-ins-theme', JSON.stringify({state:{theme:arguments[0]},version:4}));"
        "localStorage.setItem('kube-ins-locale', JSON.stringify({state:{locale:'en'},version:0}));",
        theme,
    )
    d.get(URL)
    time.sleep(6)


# ── interaction helpers ─────────────────────────────────────────────────────

def js_click_text(d, selector, text, exact=True):
    """Click the first element matching selector whose trimmed text is text."""
    return d.execute_script(
        """
        const [sel, txt, exact] = arguments;
        for (const el of document.querySelectorAll(sel)) {
            const t = el.textContent.trim();
            if (exact ? t === txt : t.includes(txt)) { el.click(); return true; }
        }
        return false;
        """,
        selector, text, exact,
    )


def nav(d, item):
    """Click a sidebar item, expanding groups until it is rendered.

    Collapsed groups carry no aria-expanded at all (not "false"), so test
    for anything other than "true".
    """
    click = """
        for (const b of document.querySelectorAll('button.sidebar-item')) {
            const l = b.querySelector('.sidebar-item__label');
            if (l && l.textContent.trim() === arguments[0]) { b.click(); return true; }
        }
        return false;
    """
    if d.execute_script(click, item):
        return True
    for t in d.find_elements(By.CSS_SELECTOR, ".sidebar-section__toggle"):
        if t.get_attribute("aria-expanded") != "true":
            d.execute_script("arguments[0].click()", t)
            time.sleep(0.25)
            if d.execute_script(click, item):
                return True
    return False


def menu(d, top, item):
    """Open a title-bar Menubar entry, then click one of its items."""
    if not js_click_text(d, ".tb-actions .p-menuitem-link", top):
        return False
    time.sleep(0.4)
    ok = js_click_text(d, ".tb-actions .p-submenu-list .p-menuitem-link", item, exact=False)
    time.sleep(0.4)
    return ok


def close_overlays(d):
    """Close dialogs/menus/tours. Escape alone does not close every dialog."""
    for _ in range(3):
        ActionChains(d).send_keys(Keys.ESCAPE).perform()
        time.sleep(0.2)
    d.execute_script("document.querySelectorAll('.p-dialog-header-close').forEach(b => b.click());")
    time.sleep(0.4)


def first_row(d):
    rows = d.find_elements(By.CSS_SELECTOR, ".p-datatable-tbody > tr:not(.p-datatable-emptymessage)")
    return rows[0] if rows else None


def open_cluster_dropdown(d):
    return d.execute_script(
        "const t = document.querySelector('#tour-cluster-area .p-dropdown'); if (t) { t.click(); return true; } return false;"
    )


def switch_cluster(d, name):
    if not open_cluster_dropdown(d):
        return False
    time.sleep(0.6)
    return js_click_text(d, ".p-dropdown-item", name, exact=False)


# ── scenarios ───────────────────────────────────────────────────────────────
# Each takes (d, shot); shot(settle) waits, then saves <scenario>.png.
# Raise Skip("why") when the screen is unreachable on this cluster.

class Skip(Exception):
    pass


def need(ok, why):
    if not ok:
        raise Skip(why)


LISTS = [
    ("overview", "Overview", 4), ("pods", "Pods", 3), ("deployments", "Deployments", 2),
    ("services", "Services", 2), ("configmaps", "ConfigMaps", 2), ("secrets", "Secrets", 2),
    ("namespaces", "Namespaces", 2), ("events", "Events", 3), ("networkpolicies", "Network Policies", 2),
    ("resourcequotas", "Resource Quotas", 2), ("crds", "CRDs", 2), ("nodes", "Nodes", 3),
    ("monitoring", "Monitoring", 12), ("securityrolemap", "Security Role Map", 6),
    ("trivy", "Vulnerability Scan", 2),
]


def list_scenario(item, settle):
    def run(d, shot):
        need(nav(d, item), f"sidebar item {item!r} not found")
        shot(settle)
    return run


def open_pods(d):
    need(nav(d, "Pods"), "no Pods item")
    time.sleep(3)
    row = first_row(d)
    need(row, "no pods")
    return row


def pod_detail(d, shot):
    row = open_pods(d)
    d.execute_script("arguments[0].querySelector('td:nth-child(3)')?.click()", row)
    shot(4)


def pod_yaml(d, shot):
    row = open_pods(d)
    ActionChains(d).double_click(row.find_elements(By.CSS_SELECTOR, "td")[2]).perform()
    shot(4)


def pod_logs(d, shot):
    row = open_pods(d)
    # The first button on a pod row is Logs. None of the row buttons carry a
    # title or aria-label (only "More actions" does), so go by position.
    need(d.execute_script(
        "const b = arguments[0].querySelector('button'); if (b) { b.click(); return true; } return false;",
        row,
    ), "no row buttons")
    shot(5)


def pod_describe(d, shot):
    row = open_pods(d)
    # On a pod row Describe sits in the ⋮ menu; row buttons are named since
    # step 5 (RowAction), so go by label.
    need(d.execute_script(
        "const b = arguments[0].querySelector('button[aria-label=\"More actions\"]'); if (b) { b.click(); return true; } return false;",
        row,
    ), "no More actions button")
    time.sleep(0.5)
    need(js_click_text(d, ".p-menuitem-link", "Describe", exact=False), "no Describe item")
    shot(4)


def configmap_editor(d, shot):
    need(nav(d, "ConfigMaps"), "no ConfigMaps item")
    time.sleep(2.5)
    row = first_row(d)
    need(row, "no configmaps")
    need(d.execute_script(
        "const b = arguments[0].querySelector('button[aria-label=\"Edit\"]'); if (b) { b.click(); return true; } return false;",
        row,
    ), "no Edit button")
    shot(3)


def crd_instances(d, shot):
    need(nav(d, "CRDs"), "no CRDs item")
    time.sleep(3)
    need(d.execute_script(
        "const k = document.querySelector('.crd-tree__kind'); if (k) { k.click(); return true; } return false;"
    ), "no CRD kinds")
    shot(3)


def select_first(d, item):
    need(nav(d, item), f"no {item} item")
    time.sleep(2.5)
    row = first_row(d)
    need(row, f"no {item} rows")
    need(d.execute_script(
        "const c = arguments[0].querySelector('.p-checkbox-input, .p-checkbox-box');"
        "if (c) { c.click(); return true; } return false;",
        row,
    ), "no checkbox")


def list_selection(d, shot):
    select_first(d, "ConfigMaps")
    shot(1)


def delete_dialog(d, shot):
    select_first(d, "ConfigMaps")
    time.sleep(0.5)
    # Opened, photographed and cancelled — never confirmed.
    need(js_click_text(d, ".p-button", "Delete", exact=False), "no delete button")
    shot(1)
    close_overlays(d)


def via_menu(top, item, settle):
    def run(d, shot):
        need(menu(d, top, item), f"menu {top} > {item} not found")
        shot(settle)
    return run


def cluster_modal(d, shot):
    need(d.execute_script(
        "const b = document.querySelector('.cluster-header__icon-btn'); if (b) { b.click(); return true; } return false;"
    ), "no add-cluster button")
    shot(1.5)


def menu_open(d, shot):
    need(js_click_text(d, ".tb-actions .p-menuitem-link", "Open"), "no Open menu")
    shot(0.6)


def cluster_dropdown(d, shot):
    need(open_cluster_dropdown(d), "no cluster dropdown")
    shot(0.8)


AI_LOG = {
    "state": {
        "host": "http://localhost:11434",
        "model": "",
        "messages": [
            {"role": "user", "content": "Why is the container-tester pod restarting?"},
            {"role": "assistant", "content": "The pod is in CrashLoopBackOff. Its init container exits with status 1 after printing \"Hata oluştu, konteyner kapanıyor\", so the main container never starts.",
             "tools": [
                 {"id": "1", "name": "list_pods", "status": "done"},
                 {"id": "2", "name": "get_pod_logs", "status": "done"},
             ]},
            {"role": "user", "content": "Delete it so the deployment recreates it."},
            {"role": "assistant", "content": "",
             "tools": [{"id": "3", "name": "delete_pod", "status": "declined", "mutating": True}],
             "error": "The request was cancelled."},
        ],
    },
    "version": 1,
}


def ai_log(d, shot):
    # Seeded into this Selenium profile only, then the page reloads to pick it up.
    d.execute_script("localStorage.setItem('kube-ins-ai-chat-store', arguments[0]);", json.dumps(AI_LOG))
    d.get(URL)
    time.sleep(6)
    need(menu(d, "Open", "AI Assistant"), "no AI Assistant item")
    shot(3)


def tour(d, shot):
    need(menu(d, "Help", "Tutorial"), "no Tutorial item")
    shot(1.5)


def tour_step2(d, shot):
    need(menu(d, "Help", "Tutorial"), "no Tutorial item")
    time.sleep(1.5)
    need(js_click_text(d, "button", "Next", exact=False), "no Next button")
    shot(1.5)


def focus_input(d, shot):
    need(nav(d, "Pods"), "no Pods item")
    time.sleep(2.5)
    inp = d.find_elements(By.CSS_SELECTOR, ".p-datatable input.p-inputtext")
    need(inp, "no filter input")
    inp[0].click()
    shot(0.6)


def focus_keyboard(d, shot):
    # Keyboard focus on a toolbar button: tab from the filter input back to
    # the list toolbar so the ring lands on a PrimeReact button.
    need(nav(d, "Pods"), "no Pods item")
    time.sleep(2.5)
    btn = d.find_elements(By.CSS_SELECTOR, ".p-datatable-header .p-button, .rlv-toolbar .p-button, .p-button")
    need(btn, "no button")
    d.execute_script("arguments[0].focus({focusVisible: true})", btn[0])
    ActionChains(d).key_down(Keys.SHIFT).send_keys(Keys.TAB).key_up(Keys.SHIFT).send_keys(Keys.TAB).perform()
    shot(0.6)


def sidebar_collapsed(d, shot):
    d.execute_script("document.querySelector('.tb-sidebar-toggle')?.click()")
    shot(1)
    d.execute_script("document.querySelector('.tb-sidebar-toggle')?.click()")


def many_tabs(d, shot):
    for item in ("Pods", "Deployments", "Services", "ConfigMaps", "Secrets", "Events", "Nodes", "Namespaces"):
        nav(d, item)
        time.sleep(0.6)
    shot(2)


def cluster_error(d, shot):
    need(switch_cluster(d, ERROR_CLUSTER), f"no cluster matching {ERROR_CLUSTER!r}")
    try:
        time.sleep(6)
        nav(d, "Pods")
        shot(8)
    finally:
        close_overlays(d)
        switch_cluster(d, HOME_CLUSTER)
        time.sleep(2)


def open_toolbox(d):
    need(d.execute_script(
        "const b = document.querySelector('.cluster-header__icon-btn[title=\"Toolbox\"]'); if (b) { b.click(); return true; } return false;"
    ), "no Toolbox button")
    time.sleep(3)


def toolbox(d, shot):
    open_toolbox(d)
    shot(1)


def open_history(d):
    open_toolbox(d)
    # The history row's Open button is disabled until toolbox answers.
    need(d.execute_script(
        "const b = document.querySelector('.tool-row:not([aria-disabled=\"true\"]) .tool-row__action');"
        "if (b && !b.disabled) { b.click(); return true; } return false;"
    ), "toolbox not usable on this cluster")
    time.sleep(4)


def history_since(d, label):
    """Pick a time range preset (or "Custom range…") in the history filters."""
    need(d.execute_script(
        "const dd = document.querySelector('.history-filters .p-dropdown[aria-label=\"Time range\"], .history-filters .p-dropdown:last-of-type');"
        "if (dd) { dd.click(); return true; } return false;"
    ), "no time range dropdown")
    time.sleep(0.6)
    need(js_click_text(d, ".p-dropdown-item", label, exact=False), f"no {label!r} option")
    time.sleep(2)


def history_view(d, label):
    """Switch the history panel to one of its views (it opens on Overview)."""
    need(js_click_text(d, ".history-panel .panel-toolbar button", label), f"no {label!r} view")
    time.sleep(2)


def history_overview(d, shot):
    open_history(d)
    history_since(d, "7 days")
    shot(4)


def cluster_history(d, shot):
    open_history(d)
    history_view(d, "Changes")
    # A quiet test cluster may have nothing in the default 24 hours.
    history_since(d, "30 days")
    # Hover a row so the pivot keys show, and open the first change's diff.
    row = first_row(d)
    need(row, "no recorded changes")
    ActionChains(d).move_to_element(row).perform()
    d.execute_script("arguments[0].querySelector('td')?.click()", row)
    shot(4)


def history_range(d, shot):
    open_history(d)
    history_view(d, "Changes")
    history_since(d, "Custom range")
    need(d.execute_script(
        "const i = document.querySelector('.history-filters__range input'); if (i) { i.click(); i.focus(); return true; } return false;"
    ), "no range input")
    shot(1)


def object_history(d, shot):
    need(nav(d, "Deployments"), "no Deployments item")
    time.sleep(3)
    row = first_row(d)
    need(row, "no deployments")
    need(d.execute_script(
        "const b = arguments[0].querySelector('button[aria-label=\"More actions\"]'); if (b) { b.click(); return true; } return false;",
        row,
    ), "no More actions button")
    time.sleep(0.5)
    need(js_click_text(d, ".p-menuitem-link", "History", exact=False), "no History item")
    shot(6)


SCENARIOS = [(name, list_scenario(item, s)) for name, item, s in LISTS] + [
    ("pod-detail", pod_detail),
    ("pod-yaml", pod_yaml),
    ("pod-logs", pod_logs),
    ("pod-describe", pod_describe),
    ("configmap-editor", configmap_editor),
    ("crd-instances", crd_instances),
    ("list-selection", list_selection),
    ("delete-dialog", delete_dialog),
    ("many-tabs", many_tabs),
    ("terminal", via_menu("Open", "Terminal", 4)),
    ("yaml-editor", via_menu("Open", "YAML Editor", 3)),
    ("port-forwards", via_menu("Open", "Port Forwards", 2)),
    ("diagnostics", via_menu("Help", "Diagnostics", 4)),
    ("ai-assistant", via_menu("Open", "AI Assistant", 3)),
    ("ai-log", ai_log),
    ("about-modal", via_menu("Help", "About", 1.5)),
    ("update-modal", via_menu("Help", "Check for updates", 4)),
    ("cluster-modal", cluster_modal),
    ("menu-open", menu_open),
    ("cluster-dropdown", cluster_dropdown),
    ("tour-1", tour),
    ("tour-2", tour_step2),
    ("focus-input", focus_input),
    ("focus-keyboard", focus_keyboard),
    ("sidebar-collapsed", sidebar_collapsed),
    ("cluster-error", cluster_error),
    ("toolbox", toolbox),
    ("history-overview", history_overview),
    ("cluster-history", cluster_history),
    ("history-range", history_range),
    ("object-history", object_history),
]

NARROW = [
    ("narrow-900-pods", list_scenario("Pods", 3)),
    ("narrow-900-pod-detail", pod_detail),
]


def run_set(theme, scenarios, width, height, report):
    out = os.path.join(root, theme)
    os.makedirs(out, exist_ok=True)
    d = None
    for name, fn in scenarios:
        if (ONLY and name not in ONLY) or name in SKIP:
            continue
        # A fresh page load per scenario: no leftover tabs, dialogs or toasts
        # leak into the next screenshot, and a crashed renderer costs one shot.
        try:
            if d is None:
                d = make_driver(width, height)
            boot(d, theme)

            def shot(settle, _name=name):
                time.sleep(settle)
                d.save_screenshot(os.path.join(out, f"{_name}.png"))
                print(f"  {theme}/{_name}.png")

            fn(d, shot)
        except Skip as e:
            report.append(f"{theme}/{name}: skipped ({e})")
            print(f"  SKIP {name}: {e}")
        except Exception as e:  # noqa: BLE001 — one bad screen must not stop the run
            report.append(f"{theme}/{name}: error ({type(e).__name__}: {str(e).splitlines()[0][:120]})")
            print(f"  ERROR {name}: {type(e).__name__}")
            try:
                d.quit()
            except Exception:  # noqa: BLE001
                pass
            d = None
    if d is not None:
        d.quit()


if __name__ == "__main__":
    report = []
    for theme in THEMES:
        print(f"[{theme}]")
        run_set(theme, SCENARIOS, 1440, 900, report)
        run_set(theme, NARROW, 900, 800, report)
    print("\n".join(report) or "all screens captured")
