#!/usr/bin/env python3
"""Release smoke test: the backend binary as packaged, its embedded frontend,
and a real cluster.

The Go binary *is* the application — Electron only supplies the window — so
this starts it the way the shell does (`--serve`), opens what it serves in
headless Chrome and walks the path every new user takes:

  1. launch    — the first-run screen appears (frontend loaded, RPC answering,
                 ListClusters returned nothing for an empty ~/.kube-ins)
  2. add       — paste a kubeconfig, save; the file lands in ~/.kube-ins
  3. connect   — the cluster bar shows the new cluster
  4. pods      — the Pods list shows a pod the cluster is known to run

Everything runs against a throwaway HOME, so it never touches the real
~/.kube-ins. The update check is pointed at a dead address to keep the run
hermetic.

    python3 scripts/smoke/smoke.py --binary /opt/kube-inspector/resources/kube-inspector \\
        --kubeconfig ~/.kube/config --expect-pod coredns --out build/smoke

Exit 0 when every step passes. On failure, --out receives a screenshot, the
step log and the backend's own log files. The kubeconfig is never written
there: the textarea is emptied before the screenshot and the copy the app
saved under the temporary HOME is not collected.
"""
import argparse
import glob
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time

from selenium import webdriver
from selenium.webdriver.common.by import By

CLUSTER = "smoke"
ROWS = ".p-datatable-tbody > tr:not(.p-datatable-emptymessage)"


class StepFailed(Exception):
    pass


def log(msg):
    print(msg, flush=True)


def wait_for(what, fn, timeout, interval=0.5):
    """Poll fn until it returns something truthy; fail the step after timeout."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:  # a stale element mid-render is not a failure yet
            last = e
        time.sleep(interval)
    raise StepFailed(f"timed out after {timeout}s waiting for {what} (last: {last!r})")


def start_backend(binary, home, out):
    env = dict(os.environ)
    env["HOME"] = home
    env.pop("KUBECONFIG", None)
    # Hermetic: no request to the real update server from a test run.
    env["KUBE_INS_UPDATE_MANIFEST"] = "http://127.0.0.1:9/version.json"
    stderr = open(os.path.join(out, "backend-stderr.log"), "w")
    # stdin stays an open pipe: closing it is the orphan guard's stop signal
    # (main.go serve()), which is also how this script shuts the backend down.
    proc = subprocess.Popen(
        [binary, "--serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=stderr, env=env, text=True,
    )
    lines = queue.Queue()
    threading.Thread(target=lambda: [lines.put(l) for l in proc.stdout], daemon=True).start()
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise StepFailed(f"backend exited early with code {proc.returncode} (see backend-stderr.log)")
        try:
            line = lines.get(timeout=0.5).strip()
        except queue.Empty:
            continue
        if line.startswith("kube-ins serving at "):
            return proc, line[len("kube-ins serving at "):].strip()
    raise StepFailed("backend printed no 'kube-ins serving at' line within 60s")


def stop_backend(proc):
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.stdin.close()
        proc.wait(timeout=10)
    except Exception:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def make_driver():
    opts = webdriver.ChromeOptions()
    opts.add_argument("--headless=new")
    opts.add_argument("--lang=en-US")
    opts.add_argument("--disable-dev-shm-usage")
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        opts.add_argument("--no-sandbox")  # Chrome refuses to sandbox as root
    d = webdriver.Chrome(options=opts)
    d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
        "width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False,
    })
    return d


def assert_no_crash(d):
    cards = d.find_elements(By.CSS_SELECTOR, ".crash-card")
    if cards:
        raise StepFailed("an error boundary caught a crash: " + cards[0].text.replace("\n", " | "))


def set_react_value(d, selector, value):
    """Set a controlled input/textarea the way typing would, in one go.
    React tracks the native value setter, so assigning .value alone is ignored."""
    ok = d.execute_script(
        """
        const [sel, v] = arguments;
        const el = document.querySelector(sel);
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
        """,
        selector, value,
    )
    if not ok:
        raise StepFailed(f"{selector} is not on the page")


def nav(d, label):
    """Click a sidebar item, expanding collapsed groups until it is rendered."""
    click = """
        for (const b of document.querySelectorAll('button.sidebar-item')) {
            const l = b.querySelector('.sidebar-item__label');
            if (l && l.textContent.trim() === arguments[0]) { b.click(); return true; }
        }
        return false;
    """
    if d.execute_script(click, label):
        return True
    for t in d.find_elements(By.CSS_SELECTOR, ".sidebar-section__toggle"):
        if t.get_attribute("aria-expanded") != "true":
            d.execute_script("arguments[0].click()", t)
            time.sleep(0.25)
            if d.execute_script(click, label):
                return True
    return False


def run(args, home, out, steps):
    proc = None
    d = None
    try:
        proc, url = start_backend(args.binary, home, out)
        log(f"backend serving at {url}")
        d = make_driver()

        def step(name, fn):
            fn()
            steps.append(f"PASS {name}")
            log(f"PASS {name}")

        def launch():
            d.get(url)
            # English, whatever the runner's locale: the steps match on labels.
            d.execute_script(
                "localStorage.setItem('kube-ins-locale', JSON.stringify({state:{locale:'en'},version:0}));")
            d.get(url)
            wait_for("the first-run cluster dialog", lambda: d.find_elements(By.ID, "cluster-config-name"), 45)
            assert_no_crash(d)

        def add():
            with open(args.kubeconfig) as f:
                content = f.read()
            set_react_value(d, "#cluster-config-name", CLUSTER)
            set_react_value(d, "#cluster-kubeconfig-content", content)
            buttons = d.find_elements(By.CSS_SELECTOR, ".cluster-modal__footer button")
            if not buttons:
                raise StepFailed("the cluster dialog has no footer buttons")
            buttons[-1].click()  # Save is the last (and, on first run, the only) one
            saved = os.path.join(home, ".kube-ins", f"{CLUSTER}.yaml")
            wait_for(f"{saved} to be written", lambda: os.path.exists(saved), 20)
            wait_for("the cluster dialog to close",
                     lambda: not d.find_elements(By.ID, "cluster-config-name"), 20)

        def connect():
            wait_for(f"the cluster bar to show '{CLUSTER}'",
                     lambda: CLUSTER in d.find_element(By.ID, "tour-cluster-area").text, 30)
            assert_no_crash(d)

        def pods():
            wait_for("the Pods item in the sidebar", lambda: nav(d, "Pods"), 20)

            def found():
                for r in d.find_elements(By.CSS_SELECTOR, ROWS):
                    if args.expect_pod in r.text:
                        return r.text.replace("\n", " ")
                return None
            try:
                row = wait_for(f"a pod containing '{args.expect_pod}' in the Pods list", found, args.timeout)
            except StepFailed:
                # A forbidden or failed list shows shared/ErrorBanner — .err-block
                # in place of an empty table, .err-banner above stale rows — not
                # an empty table. role=alert catches both.
                banners = [b.text.replace("\n", " ") for b in d.find_elements(By.CSS_SELECTOR, '[role="alert"]')]
                rows = len(d.find_elements(By.CSS_SELECTOR, ROWS))
                raise StepFailed(f"no '{args.expect_pod}' row among {rows} rows; banners: {banners}")
            log(f"     row: {row[:140]}")
            assert_no_crash(d)

        step("launch", launch)
        step("add", add)
        step("connect", connect)
        step("pods", pods)
        return True
    except StepFailed as e:
        steps.append(f"FAIL {e}")
        log(f"FAIL {e}")
        if d is not None:
            try:
                # Never put the kubeconfig in an artifact.
                d.execute_script(
                    "const t = document.querySelector('#cluster-kubeconfig-content'); if (t) t.value = '';")
                d.save_screenshot(os.path.join(out, "screenshot.png"))
            except Exception as se:
                log(f"(could not take a screenshot: {se})")
        return False
    finally:
        if d is not None:
            d.quit()
        stop_backend(proc)


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--binary", required=True, help="the Go backend (in a package: /opt/kube-inspector/resources/kube-inspector)")
    p.add_argument("--kubeconfig", required=True, help="kubeconfig of the cluster to add")
    p.add_argument("--expect-pod", default="coredns", help="substring of a pod name the cluster runs")
    p.add_argument("--timeout", type=int, default=90, help="seconds to wait for the pod to be listed")
    p.add_argument("--out", default="build/smoke", help="where failure evidence goes")
    args = p.parse_args()

    for path in (args.binary, args.kubeconfig):
        if not os.path.isfile(path):
            sys.exit(f"not a file: {path}")
    shutil.rmtree(args.out, ignore_errors=True)
    os.makedirs(args.out)
    home = tempfile.mkdtemp(prefix="kube-ins-smoke-")
    steps = []
    try:
        ok = run(args, home, args.out, steps)
    finally:
        with open(os.path.join(args.out, "steps.txt"), "w") as f:
            f.write("\n".join(steps) + "\n")
        # The backend's own log (logstash JSON), not the saved kubeconfig.
        for f in glob.glob(os.path.join(home, ".kube-ins", "logs", "*.log")):
            shutil.copy(f, args.out)
        shutil.rmtree(home, ignore_errors=True)
    log("smoke test passed" if ok else f"smoke test FAILED — evidence in {args.out}/")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
