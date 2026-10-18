"""
YAML CRUD lifecycle E2E test for kube-ins.

This test simulates a real user:
  1. Opening the 'Apply YAML' panel and injecting a ConfigMap definition.
  2. Clicking 'Apply' and verifying the success Toast.
  3. Navigating to the ConfigMaps list and confirming the resource appeared.
  4. Selecting the row and deleting it via the PrimeReact confirmation Dialog.
  5. Verifying the resource is no longer shown in the list.

Requirements
────────────
• `make dev` must be running on http://localhost:34115.
• A Kubernetes cluster must be configured and connected in kube-ins.
  (The Apply YAML call goes to the real cluster via Wails RPC + kubectl.)
• `kubectl` must be authorised to create/delete ConfigMaps in the
  'default' namespace.

Mark: @pytest.mark.integration
──────────────────────────────
Run only integration tests:  pytest -m integration
Skip integration tests:       pytest -m "not integration"
"""

import time

import pytest
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

from helpers import (
    navigate_to,
    wait_for_panel_heading,
    filter_datatable_by_name,
    find_datatable_row,
    select_datatable_row,
    click_delete_selected_button,
    assert_row_absent,
    wait_for_dialog,
    click_dialog_button,
    wait_for_dialog_closed,
    wait_for_toast,
    wait_for_toast_gone,
    open_apply_yaml_panel,
    set_monaco_value,
    click_apply_button,
)

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

# ConfigMap name is time-stamped to avoid collisions with previous test runs.
CM_NAME = f"e2e-test-cm-{int(time.time())}"
CM_NAMESPACE = "default"

APPLY_TIMEOUT = 30   # seconds — Wails → Go → kubectl → cluster
LIST_TIMEOUT  = 15   # seconds — ConfigMap list polls every 2 s; allow 7+ cycles
DELETE_TIMEOUT = 20  # seconds — delete call + list refresh

CONFIGMAP_YAML = f"""\
apiVersion: v1
kind: ConfigMap
metadata:
  name: {CM_NAME}
  namespace: {CM_NAMESPACE}
  labels:
    created-by: kube-ins-e2e
data:
  test-key: e2e-test-value
"""


# ─────────────────────────────────────────────────────────────────────────────
# Teardown fixture
# ─────────────────────────────────────────────────────────────────────────────

def _try_delete_via_ui(driver: object, name: str, namespace: str) -> None:
    """
    Best-effort cleanup: navigate to ConfigMaps, find the row by name,
    select it, and delete it.  Swallows all exceptions so a cleanup failure
    never masks the original test failure.
    """
    try:
        navigate_to(driver, "Config & Secrets", "ConfigMaps")
        wait_for_panel_heading(driver, "ConfigMap List", timeout=8)
        time.sleep(0.5)  # allow active panel to paint

        # Filter to the test ConfigMap so other rows don't interfere.
        filter_datatable_by_name(driver, name)
        time.sleep(0.5)

        rows = driver.find_elements(
            By.XPATH,
            f"//tbody[contains(@class,'p-datatable-tbody')]"
            f"//tr[.//td[normalize-space(text())='{name}']]",
        )
        if not rows:
            return  # already gone — nothing to clean up

        select_datatable_row(driver, name)
        click_delete_selected_button(driver)
        wait_for_dialog(driver, timeout=8)
        click_dialog_button(driver, "Delete")
        wait_for_dialog_closed(driver, timeout=10)
    except Exception:  # noqa: BLE001
        pass  # best-effort only; never raise during teardown


@pytest.fixture
def configmap_cleanup(driver):
    """
    Pytest fixture that guarantees the test ConfigMap is deleted from the
    cluster even if the test fails mid-way (preventing cluster pollution).

    Usage: add `configmap_cleanup` as a parameter to any test function.
    """
    yield CM_NAME
    _try_delete_via_ui(driver, CM_NAME, CM_NAMESPACE)


# ─────────────────────────────────────────────────────────────────────────────
# Test class
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestConfigMapCRUD:
    """
    Full Create → Read/Verify → Delete lifecycle via the kube-ins UI.

    The test is broken into clearly labelled steps so pytest output and
    the HTML report make it easy to identify exactly which step failed.
    """

    def test_configmap_crud_lifecycle(self, driver, configmap_cleanup):
        """
        End-to-end CRUD test using a temporary ConfigMap in the 'default'
        namespace.  The `configmap_cleanup` fixture ensures the resource is
        removed from the cluster even if any assertion below fails.
        """
        name = configmap_cleanup  # CM_NAME

        # ── Step 1: Open the Apply YAML panel ────────────────────────────────
        #
        # Via TitleBar 'Open → YAML Editor' Menubar item.
        # ApplyYamlPanel mounts Monaco and renders the toolbar with Apply / Clear.
        open_apply_yaml_panel(driver)

        # ── Step 2: Inject the test ConfigMap YAML into Monaco ───────────────
        #
        # Tries window.monaco.editor.getEditors() JS injection first; falls
        # back to .inputarea keyboard simulation if Monaco global is unavailable.
        set_monaco_value(driver, CONFIGMAP_YAML)

        # Brief visual confirmation pause so the editor shows the injected text
        # before we click Apply.
        time.sleep(0.3)

        # ── Step 3: Click 'Apply' ─────────────────────────────────────────────
        click_apply_button(driver)

        # ── Step 4: Verify the success Toast ─────────────────────────────────
        #
        # ApplyYamlPanel shows severity='success', summary='Applied' on success.
        # The RPC call goes all the way to the cluster, so allow APPLY_TIMEOUT.
        summary = wait_for_toast(driver, severity="success", timeout=APPLY_TIMEOUT)
        assert summary == "Applied", (
            f"Expected 'Applied' toast after applying YAML, got: {repr(summary)}"
        )

        # Wait for the toast to fade (life=2500 ms) so it doesn't interfere
        # with the deletion-toast assertion later.
        wait_for_toast_gone(driver, timeout=8)

        # ── Step 5: Navigate to the ConfigMaps list panel ────────────────────
        navigate_to(driver, "Config & Secrets", "ConfigMaps")
        wait_for_panel_heading(driver, "ConfigMap List", timeout=10)

        # ── Step 6: Filter by name and verify the ConfigMap appears ──────────
        #
        # The ConfigMap list polls every 2 seconds.  Use LIST_TIMEOUT so we
        # wait through several polling cycles before failing.
        filter_datatable_by_name(driver, name)
        row = find_datatable_row(driver, name, timeout=LIST_TIMEOUT)
        assert row is not None, (
            f"ConfigMap '{name}' was not found in the ConfigMaps list after applying YAML."
        )

        # ── Step 7: Select the row via its checkbox ───────────────────────────
        select_datatable_row(driver, name)

        # Verify the delete button appeared after selecting the row (it does
        # not exist while nothing is selected).
        WebDriverWait(driver, 5).until(
            EC.element_to_be_clickable((
                By.XPATH, "//button[contains(@class,'rlv-delete') and not(@disabled)]",
            ))
        )

        # ── Step 8: Click the delete button ──────────────────────────────────
        click_delete_selected_button(driver)

        # ── Step 9: Handle the PrimeReact confirmation Dialog ─────────────────
        #
        # ConfigMapListComponent shows header='Delete ConfigMap Confirmation'.
        wait_for_dialog(driver, header_text="Delete ConfigMap Confirmation")
        click_dialog_button(driver, "Delete")
        wait_for_dialog_closed(driver, timeout=DELETE_TIMEOUT)

        # ── Step 10: Verify the deletion success Toast ────────────────────────
        #
        # ConfigMapListComponent emits summary='Deleted successfully' on success.
        del_summary = wait_for_toast(driver, severity="success", timeout=DELETE_TIMEOUT)
        assert del_summary == "Deleted successfully", (
            f"Expected 'Deleted successfully' toast after delete, got: {repr(del_summary)}"
        )

        # ── Step 11: Confirm the row is gone from the list ───────────────────
        #
        # The list refreshes automatically; assert_row_absent actively waits
        # (via EC.invisibility_of_element_located) for the row to disappear.
        assert_row_absent(driver, name, timeout=10)


# ─────────────────────────────────────────────────────────────────────────────
# Additional safety: verify the editor rejects an empty payload
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.integration
class TestApplyYamlValidation:
    """
    Quick validation tests for the Apply YAML panel that do NOT hit the cluster.
    """

    def test_empty_yaml_shows_warn_toast(self, driver):
        """
        Clicking 'Apply' with no content must show a 'warn' Toast (not an error
        from the cluster).  ApplyYamlPanel guards against empty submissions.
        """
        # Open a fresh Apply YAML panel (counter increments so a new panel is added).
        open_apply_yaml_panel(driver)

        # Ensure the Monaco editor is empty by clearing it via JS first.
        # ApplyYamlPanel exposes its editor on window.__kubeInsYamlEditor
        # (window.monaco is NOT set in this project's Vite ESM build).
        driver.execute_script("""
            try {
                if (window.__kubeInsYamlEditor) {
                    window.__kubeInsYamlEditor.setValue('');
                }
            } catch (e) {}
        """)
        time.sleep(0.2)

        click_apply_button(driver)

        summary = wait_for_toast(driver, severity="warn", timeout=10)
        assert summary == "Empty", (
            f"Expected 'Empty' warn toast for blank editor, got: {repr(summary)}"
        )
        wait_for_toast_gone(driver, timeout=8)

    def test_invalid_yaml_shows_error_toast(self, driver):
        """
        Submitting malformed YAML must produce an 'error' Toast from the backend.
        The Apply call reaches the Go layer which runs kubectl and returns the
        error.

        Requires a cluster connection; without one the call may time out or
        return a different error.  The test only asserts that an error toast
        appears (not its exact message).
        """
        open_apply_yaml_panel(driver)
        set_monaco_value(driver, "this: is: not: valid: yaml: ::::\n  - broken")
        time.sleep(0.2)
        click_apply_button(driver)

        # The error may be a YAML parse error or a kubectl error — either way
        # the panel shows severity='error'.
        wait_for_toast(driver, severity="error", timeout=APPLY_TIMEOUT)
        wait_for_toast_gone(driver, timeout=8)
