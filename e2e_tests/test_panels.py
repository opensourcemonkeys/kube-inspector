"""
Panel open/load E2E tests for kube-ins.

Verifies that the interactive resource panels mount and render their shell when
the user opens them:

  • Pod Logs viewer   — opened from a Pods-list row action (VscListFlat icon)
  • Pod Exec terminal — opened from a Pods-list row action (VscTerminal icon)
  • Resource Graph    — opened from the ClusterBar 'Resource Graph' button

These tests assert that the panel's Dockview tab appears and its container
element renders. They intentionally do NOT assert on live data (streamed logs,
an interactive shell, or a populated graph), since that depends on the backing
cluster having running workloads — only that the UI opens and loads its shell.

The Logs and Exec tests require at least one pod in the active cluster; they
`pytest.skip` cleanly when the Pods list is empty.

Prerequisites:
  • `make dev` running on http://localhost:34115.
  • A connected cluster selected in kube-ins (the ClusterBar shows it).
"""

import time

import pytest
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

from helpers import (
    navigate_to,
    wait_for_tab,
    wait_for_active_tab,
    wait_for_panel_heading,
    wait_for_datatable,
    pod_data_rows,
    open_pod_log_panel,
    open_pod_exec_panel,
    open_resource_graph,
)

PANEL_TIMEOUT = 15  # seconds — panels mount synchronously but allow for poll cycles


# ─────────────────────────────────────────────────────────────────────────────
# Shared setup
# ─────────────────────────────────────────────────────────────────────────────

def _open_pods_list(driver):
    """Navigate to the Pods list and wait for its DataTable to render."""
    navigate_to(driver, "Workloads", "Pods")
    wait_for_tab(driver, "Pods", timeout=PANEL_TIMEOUT)
    wait_for_panel_heading(driver, "Pod List", timeout=PANEL_TIMEOUT)
    wait_for_datatable(driver, timeout=PANEL_TIMEOUT)


def _require_pod_rows(driver):
    """
    Wait briefly for pod rows to populate; skip the test if the list stays empty.
    Returns the list of row elements when present.
    """
    deadline = time.time() + PANEL_TIMEOUT
    rows = []
    while time.time() < deadline:
        rows = pod_data_rows(driver)
        if rows:
            return rows
        time.sleep(0.5)
    pytest.skip("No pods available in the active cluster — cannot open Logs/Exec panels.")


# ─────────────────────────────────────────────────────────────────────────────
# Pod Logs viewer
# ─────────────────────────────────────────────────────────────────────────────

class TestPodLogPanel:
    """Opening the Logs viewer from a pod row mounts the LogViewerPanel shell."""

    def test_log_panel_opens_and_loads(self, driver):
        _open_pods_list(driver)
        _require_pod_rows(driver)

        clicked = open_pod_log_panel(driver, timeout=PANEL_TIMEOUT)
        assert clicked, "Expected to click a Logs action button on a pod row."

        # A Dockview tab titled 'Logs • <ns>/<name>' must appear and be active.
        wait_for_active_tab(driver, "Logs", timeout=PANEL_TIMEOUT)

        # The LogViewerPanel wrapper renders immediately on mount, independent of
        # whether log streaming has started — proving the panel shell loaded.
        WebDriverWait(driver, PANEL_TIMEOUT).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, ".log-viewer-panel"))
        )

        # The toolbar carries a 'Logs' label and the pod/container dropdowns.
        WebDriverWait(driver, PANEL_TIMEOUT).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, ".log-viewer-toolbar"))
        )
        label = driver.find_element(By.CSS_SELECTOR, ".log-viewer-toolbar__label")
        assert label.text.strip() == "Logs", (
            f"Expected log toolbar label 'Logs', got {label.text.strip()!r}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Pod Exec terminal
# ─────────────────────────────────────────────────────────────────────────────

class TestPodExecPanel:
    """Opening Exec from a pod row mounts the PodExecPanel xterm.js terminal."""

    def test_exec_panel_opens_and_loads(self, driver):
        _open_pods_list(driver)
        _require_pod_rows(driver)

        clicked = open_pod_exec_panel(driver, timeout=PANEL_TIMEOUT)
        assert clicked, "Expected to click an Exec action button on a pod row."

        # A Dockview tab titled 'Exec • <ns>/<name>' must appear and be active.
        wait_for_active_tab(driver, "Exec", timeout=PANEL_TIMEOUT)

        # PodExecPanel mounts an xterm.js terminal; xterm injects a `.xterm`
        # element into its container as soon as it initialises. Its presence
        # proves the terminal shell loaded (regardless of backend connection).
        WebDriverWait(driver, PANEL_TIMEOUT).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, ".xterm"))
        )
        # The xterm render layer (screen) confirms the terminal painted.
        WebDriverWait(driver, PANEL_TIMEOUT).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, ".xterm .xterm-screen"))
        )


# ─────────────────────────────────────────────────────────────────────────────
# Resource Graph (ReactFlow)
# ─────────────────────────────────────────────────────────────────────────────

class TestResourceGraphPanel:
    """
    Opening the Resource Graph from the ClusterBar mounts the ClusterResourcePanel
    (ReactFlow canvas). This does not require any pods — an empty cluster still
    renders the graph shell and legend.
    """

    def test_graph_panel_opens_and_loads(self, driver):
        open_resource_graph(driver, timeout=PANEL_TIMEOUT)

        # A Dockview tab titled 'Resource Graph • <cluster>' must appear/activate.
        wait_for_active_tab(driver, "Resource Graph", timeout=PANEL_TIMEOUT)

        # The panel toolbar label confirms the correct component mounted.
        label = WebDriverWait(driver, PANEL_TIMEOUT).until(
            EC.presence_of_element_located((
                By.XPATH,
                "//span[contains(@class,'yaml-editor-toolbar__label')"
                " and contains(normalize-space(.),'Cluster Resource Graph')]",
            ))
        )
        assert "Cluster Resource Graph" in label.text

        # ReactFlow renders its root container `.react-flow` once mounted.
        WebDriverWait(driver, PANEL_TIMEOUT).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, ".react-flow"))
        )
        # The viewport pane confirms the canvas itself painted.
        WebDriverWait(driver, PANEL_TIMEOUT).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, ".react-flow__viewport"))
        )
