"""
Reusable Selenium helpers for kube-ins E2E tests.

All helpers accept an explicit `driver` and optional `timeout` rather than
relying on globals, so they can be safely used across different test classes
and with different timeout budgets.
"""

import time

from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import (
    NoSuchElementException,
    StaleElementReferenceException,
    TimeoutException,
)

DEFAULT_TIMEOUT = 20  # seconds


# ─────────────────────────────────────────────────────────────────────────────
# Sidebar navigation
# ─────────────────────────────────────────────────────────────────────────────

def expand_sidebar_group(driver, group_label: str, timeout: int = DEFAULT_TIMEOUT) -> None:
    """
    Expand a sidebar section (e.g. 'Workloads') if it is currently collapsed.

    The toggle button carries `aria-expanded` so we can detect current state
    and only click when actually collapsed.
    """
    wait = WebDriverWait(driver, timeout)
    toggle_xpath = (
        f"//button[contains(@class,'sidebar-section__toggle')"
        f" and .//*[contains(@class,'sidebar-section__badge-label')"
        f" and text()='{group_label}']]"
    )
    toggle = wait.until(EC.element_to_be_clickable((By.XPATH, toggle_xpath)))
    if toggle.get_attribute("aria-expanded") != "true":
        toggle.click()
        WebDriverWait(driver, timeout).until(
            lambda d: d.find_element(By.XPATH, toggle_xpath).get_attribute("aria-expanded") == "true"
        )


def click_sidebar_item(driver, item_label: str, timeout: int = DEFAULT_TIMEOUT) -> None:
    """Click a sidebar nav item by its visible label text (e.g. 'Pods')."""
    wait = WebDriverWait(driver, timeout)
    item = wait.until(EC.element_to_be_clickable((
        By.XPATH,
        f"//button[contains(@class,'sidebar-item')"
        f" and .//*[contains(@class,'sidebar-item__label') and text()='{item_label}']]",
    )))
    item.click()


def navigate_to(driver, group_label: str, item_label: str, timeout: int = DEFAULT_TIMEOUT) -> None:
    """Expand a sidebar group and click one of its items in a single call."""
    expand_sidebar_group(driver, group_label, timeout)
    click_sidebar_item(driver, item_label, timeout)


# ─────────────────────────────────────────────────────────────────────────────
# Dockview tab helpers
# ─────────────────────────────────────────────────────────────────────────────

def wait_for_tab(driver, title_fragment: str, timeout: int = DEFAULT_TIMEOUT):
    """
    Wait until any Dockview tab whose title contains *title_fragment* exists.

    The FloatableTab component renders a plain <span> with the title text
    inside the `.dv-tab` container element.
    """
    wait = WebDriverWait(driver, timeout)
    return wait.until(EC.presence_of_element_located((
        By.XPATH,
        f"//div[contains(@class,'dv-tab')"
        f" and .//span[contains(text(),'{title_fragment}')]]",
    )))


def wait_for_active_tab(driver, title_fragment: str, timeout: int = DEFAULT_TIMEOUT):
    """
    Wait until the *active* Dockview tab (`.dv-active-tab`) contains
    *title_fragment* in its title span.
    """
    wait = WebDriverWait(driver, timeout)
    return wait.until(EC.presence_of_element_located((
        By.XPATH,
        f"//div[contains(@class,'dv-tab') and contains(@class,'dv-active-tab')"
        f" and .//span[contains(text(),'{title_fragment}')]]",
    )))


# ─────────────────────────────────────────────────────────────────────────────
# Panel content helpers
# ─────────────────────────────────────────────────────────────────────────────

def wait_for_panel_heading(driver, heading_text: str, timeout: int = DEFAULT_TIMEOUT):
    """
    Wait for an <h3> with exactly *heading_text* to appear in the DOM.

    Each resource list view renders a unique <h3> (e.g. 'Pod List',
    'ConfigMap List'). Presence of this element confirms the panel mounted.
    """
    wait = WebDriverWait(driver, timeout)
    return wait.until(EC.presence_of_element_located((
        By.XPATH,
        f"//h3[normalize-space(text())='{heading_text}']",
    )))


def wait_for_datatable(driver, timeout: int = DEFAULT_TIMEOUT):
    """
    Wait for a PrimeReact DataTable (`.p-datatable`) to be present.

    The table renders even when the resource list is empty (shows an
    'emptyMessage' row), so presence alone is a reliable render check.
    """
    wait = WebDriverWait(driver, timeout)
    return wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, ".p-datatable")))


# ─────────────────────────────────────────────────────────────────────────────
# DataTable row interaction
# ─────────────────────────────────────────────────────────────────────────────

def filter_datatable_by_name(driver, name: str, timeout: int = DEFAULT_TIMEOUT) -> None:
    """
    Type *name* into the DataTable's 'Search name' plain-text filter input
    (the Name column uses FilterMatchMode.CONTAINS with filterDisplay='row').
    """
    wait = WebDriverWait(driver, timeout)
    inp = wait.until(EC.element_to_be_clickable((
        By.CSS_SELECTOR, "input[placeholder='Search name']"
    )))
    inp.clear()
    inp.send_keys(name)


def find_datatable_row(driver, cell_text: str, timeout: int = DEFAULT_TIMEOUT):
    """
    Wait until a DataTable <tr> containing a cell with *cell_text* is present.

    Uses normalize-space() to handle leading/trailing whitespace in cell text.
    """
    wait = WebDriverWait(driver, timeout)
    return wait.until(EC.presence_of_element_located((
        By.XPATH,
        f"//tbody[contains(@class,'p-datatable-tbody')]"
        f"//tr[.//td[normalize-space(text())='{cell_text}']]",
    )))


def select_datatable_row(driver, cell_text: str, timeout: int = DEFAULT_TIMEOUT) -> None:
    """
    Check the PrimeReact selection checkbox on the DataTable row whose cells
    contain *cell_text*.

    PrimeReact v10 overlays an `<input class="p-checkbox-input">` on top of the
    visual `.p-checkbox-box`; that transparent input intercepts pointer events,
    so clicking `.p-checkbox-box` directly raises ElementClickInterceptedException.
    We click the input itself (the accessible target), falling back to a JS click.

    The list polls every ~2s and re-renders its <tr> elements, so a previously
    located row/checkbox can go stale mid-interaction. We therefore re-locate the
    row and checkbox on every attempt and retry until the checkbox reports
    aria-checked='true' (or the timeout elapses).
    """
    row_xpath = (
        f"//tbody[contains(@class,'p-datatable-tbody')]"
        f"//tr[.//td[normalize-space(text())='{cell_text}']]"
    )
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        try:
            row = driver.find_element(By.XPATH, row_xpath)
            try:
                target = row.find_element(By.CSS_SELECTOR, ".p-checkbox-input")
            except Exception:
                # Older PrimeReact markup without the input overlay.
                target = row.find_element(By.CSS_SELECTOR, ".p-checkbox-box")

            # Already selected? Done.
            if (target.get_attribute("aria-checked") == "true"
                    or target.get_attribute("data-p-highlight") == "true"):
                return

            try:
                target.click()
            except Exception:
                driver.execute_script("arguments[0].click();", target)

            # Verify the click registered before returning; if the row re-rendered
            # and dropped the selection, the loop re-locates and retries.
            time.sleep(0.2)
            row = driver.find_element(By.XPATH, row_xpath)
            try:
                target = row.find_element(By.CSS_SELECTOR, ".p-checkbox-input")
            except Exception:
                target = row.find_element(By.CSS_SELECTOR, ".p-checkbox-box")
            if target.get_attribute("aria-checked") == "true":
                return
        except StaleElementReferenceException as exc:
            last_err = exc
        except NoSuchElementException as exc:
            last_err = exc
        time.sleep(0.2)

    raise TimeoutException(
        f"Could not select DataTable row containing {cell_text!r} within "
        f"{timeout}s (last error: {last_err})"
    )


def click_delete_selected_button(driver, timeout: int = DEFAULT_TIMEOUT) -> None:
    """
    Click the list toolbar's delete button inside the active panel.

    The button only exists while at least one row is checked, and its label
    carries the count ("Delete 3") and is translated, so it is found by its
    stable class rather than by text.
    """
    wait = WebDriverWait(driver, timeout)
    btn = wait.until(EC.element_to_be_clickable((
        By.XPATH, "//button[contains(@class,'rlv-delete') and not(@disabled)]",
    )))
    btn.click()


def assert_row_absent(driver, cell_text: str, timeout: int = DEFAULT_TIMEOUT) -> None:
    """
    Assert that no DataTable row containing *cell_text* exists.

    Uses EC.invisibility_of_element_located so the assertion actively waits
    (rather than failing immediately) for up to *timeout* seconds — useful
    after a delete while the list is still polling.
    """
    WebDriverWait(driver, timeout).until(
        EC.invisibility_of_element_located((
            By.XPATH,
            f"//tbody[contains(@class,'p-datatable-tbody')]"
            f"//tr[.//td[normalize-space(text())='{cell_text}']]",
        ))
    )


# ─────────────────────────────────────────────────────────────────────────────
# PrimeReact Dialog helpers
# ─────────────────────────────────────────────────────────────────────────────

def wait_for_dialog(driver, header_text: str = None, timeout: int = DEFAULT_TIMEOUT):
    """
    Wait for a PrimeReact modal dialog to become visible.

    Pass *header_text* to additionally assert the dialog title matches.
    PrimeReact Dialog uses `.p-dialog-title` for the header string.
    """
    wait = WebDriverWait(driver, timeout)
    if header_text:
        return wait.until(EC.visibility_of_element_located((
            By.XPATH,
            f"//div[contains(@class,'p-dialog')"
            f" and .//*[contains(@class,'p-dialog-title')"
            f" and text()='{header_text}']]",
        )))
    return wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, ".p-dialog")))


def click_dialog_button(driver, button_label: str, timeout: int = DEFAULT_TIMEOUT) -> None:
    """
    Click a button inside a visible PrimeReact Dialog footer by its label text.

    PrimeReact Button renders the label inside
    `<span class="p-button-label p-c">`.
    """
    wait = WebDriverWait(driver, timeout)
    btn = wait.until(EC.element_to_be_clickable((
        By.XPATH,
        f"//div[contains(@class,'p-dialog-footer')]"
        f"//button[.//*[contains(@class,'p-button-label')"
        f" and text()='{button_label}']]",
    )))
    btn.click()


def wait_for_dialog_closed(driver, timeout: int = DEFAULT_TIMEOUT) -> None:
    """Wait for the PrimeReact Dialog to fully disappear from the DOM."""
    WebDriverWait(driver, timeout).until(
        EC.invisibility_of_element_located((By.CSS_SELECTOR, ".p-dialog"))
    )


# ─────────────────────────────────────────────────────────────────────────────
# PrimeReact Toast helpers
# ─────────────────────────────────────────────────────────────────────────────

def wait_for_toast(driver, severity: str = "success", timeout: int = DEFAULT_TIMEOUT) -> str:
    """
    Wait for a PrimeReact Toast of the given severity and return its summary text.

    PrimeReact Toast adds `p-toast-message-{severity}` to each message element.
    Severity values: 'success', 'error', 'warn', 'info'.

    PrimeReact toasts slide in via a CSS animation, so the message element can
    be present in the DOM a moment before its `.p-toast-summary` is rendered and
    visible. Reading `.text` too early returns ''. We therefore wait for the
    summary element to become *visible* and poll until its text is non-empty.
    """
    wait = WebDriverWait(driver, timeout)
    msg = wait.until(EC.presence_of_element_located((
        By.CSS_SELECTOR, f".p-toast-message-{severity}",
    )))

    # Wait for the summary node to render and carry text. Some toasts (rare)
    # omit a summary; in that case return '' after the visibility wait elapses.
    summary_locator = (
        By.CSS_SELECTOR, f".p-toast-message-{severity} .p-toast-summary",
    )
    try:
        wait.until(EC.visibility_of_element_located(summary_locator))
        wait.until(lambda d: d.find_element(*summary_locator).text.strip() != "")
        return msg.find_element(By.CSS_SELECTOR, ".p-toast-summary").text
    except Exception:
        return ""


def wait_for_toast_gone(driver, timeout: int = DEFAULT_TIMEOUT) -> None:
    """Wait until all PrimeReact toast messages have faded away."""
    WebDriverWait(driver, timeout).until(
        EC.invisibility_of_element_located((By.CSS_SELECTOR, ".p-toast-message"))
    )


# ─────────────────────────────────────────────────────────────────────────────
# YAML Editor (Monaco) helpers
# ─────────────────────────────────────────────────────────────────────────────

def open_apply_yaml_panel(driver, timeout: int = DEFAULT_TIMEOUT) -> None:
    """
    Open the Apply YAML panel via the TitleBar 'Open → YAML Editor' menu.

    The TitleBar uses a PrimeReact Menubar.  Root items carry the label text
    inside `<span class="p-menuitem-text">`.  Sub-items live in
    `<ul class="p-submenu-list">`.
    """
    wait = WebDriverWait(driver, timeout)

    # Hover + click the 'Open' root menu item so both hover-open and
    # click-open Menubar configurations are handled.
    open_label = wait.until(EC.element_to_be_clickable((
        By.XPATH,
        "//div[contains(@class,'tb-actions')]"
        "//span[contains(@class,'p-menuitem-text') and text()='Open']",
    )))
    ActionChains(driver).move_to_element(open_label).click().perform()

    # Wait for the 'YAML Editor' item in the revealed submenu.
    yaml_item = wait.until(EC.element_to_be_clickable((
        By.XPATH,
        "//ul[contains(@class,'p-submenu-list')]"
        "//span[contains(@class,'p-menuitem-text') and text()='YAML Editor']",
    )))
    yaml_item.click()

    # The ApplyYamlPanel mounts Monaco.  Wait for .view-lines which is always
    # present once Monaco has finished laying out — regardless of whether Chrome
    # uses the native EditContext API (no .inputarea) or the textarea fallback.
    wait.until(EC.presence_of_element_located(
        (By.CSS_SELECTOR, ".monaco-editor .view-lines")
    ))


def set_monaco_value(driver, yaml_content: str, timeout: int = DEFAULT_TIMEOUT) -> None:
    """
    Inject *yaml_content* into the active Monaco editor instance.

    Strategy (in order):
    1. window.__kubeInsYamlEditor.setValue() — the ApplyYamlPanel onMount
       callback writes the editor ref here. Always correct; works in the Vite
       ESM build where window.monaco is NOT set.
    2. window.monaco.editor.getEditors() — standard AMD/CDN build fallback.
    3. Keyboard fallback via ActionChains on .view-lines — last resort. Avoid
       if possible: Monaco's YAML auto-indentation corrupts keyboard-typed
       multi-line content when newlines are sent as Enter keystrokes.
    """
    # Ensure Monaco has mounted.  .view-lines is always present in both
    # native EditContext mode (Chrome 121+) and textarea-based mode.
    WebDriverWait(driver, timeout).until(
        EC.presence_of_element_located((By.CSS_SELECTOR, ".monaco-editor .view-lines"))
    )
    # Brief settle time for Monaco worker initialisation.
    time.sleep(0.3)

    injected = driver.execute_script("""
        try {
            // Primary path: kube-ins exposes the most-recently-mounted
            // ApplyYamlPanel editor on window.__kubeInsYamlEditor from
            // its onMount callback. This is always correct regardless of
            // how Monaco is loaded (ESM via Vite, not AMD/CDN, so
            // window.monaco is NOT set in this project).
            if (window.__kubeInsYamlEditor) {
                window.__kubeInsYamlEditor.setValue(arguments[0]);
                return 'editor-ref';
            }
            // Fallback: standard window.monaco global (AMD/CDN builds only).
            const m = window.monaco;
            if (m && m.editor) {
                const eds = m.editor.getEditors();
                if (eds && eds.length > 0) {
                    eds[eds.length - 1].setValue(arguments[0]);
                    return 'editor-api';
                }
                const models = m.editor.getModels();
                if (models && models.length > 0) {
                    models[models.length - 1].setValue(arguments[0]);
                    return 'model-api';
                }
            }
        } catch (e) { /* fall through to keyboard fallback */ }
        return null;
    """, yaml_content)

    if injected:
        return

    # Keyboard fallback: click the .view-lines area to focus Monaco, then
    # select-all + delete existing content, then send keys in chunks.
    view_lines = driver.find_element(By.CSS_SELECTOR, ".monaco-editor .view-lines")
    ActionChains(driver).click(view_lines).perform()
    time.sleep(0.2)
    (ActionChains(driver)
     .key_down(Keys.CONTROL).send_keys("a").key_up(Keys.CONTROL)
     .perform())
    time.sleep(0.1)
    ActionChains(driver).send_keys(Keys.DELETE).perform()
    time.sleep(0.1)

    # Send YAML in small chunks to avoid overwhelming the synthetic event queue.
    chunk = 150
    for i in range(0, len(yaml_content), chunk):
        ActionChains(driver).send_keys(yaml_content[i: i + chunk]).perform()
        time.sleep(0.04)


def click_apply_button(driver, timeout: int = DEFAULT_TIMEOUT) -> None:
    """Click the 'Apply' button inside the YAML editor toolbar."""
    wait = WebDriverWait(driver, timeout)
    btn = wait.until(EC.element_to_be_clickable((
        By.XPATH,
        "//div[contains(@class,'yaml-editor-toolbar')]"
        "//button[.//*[contains(@class,'p-button-label') and text()='Apply']]",
    )))
    btn.click()


# ─────────────────────────────────────────────────────────────────────────────
# Pod row actions (Logs / Exec) and Resource Graph
# ─────────────────────────────────────────────────────────────────────────────

# The Pods list renders two icon-only action buttons in its last column, in a
# fixed order: [0] = Logs (VscListFlat), [1] = Exec (VscTerminal). They have no
# text label, so we target them positionally within the row.
_POD_LOG_BUTTON_INDEX = 0
_POD_EXEC_BUTTON_INDEX = 1

# Real data rows exclude the PrimeReact 'emptyMessage' placeholder row.
_DATA_ROW_XPATH = (
    "//tbody[contains(@class,'p-datatable-tbody')]"
    "/tr[not(.//td[contains(@class,'p-datatable-emptymessage')])]"
)


def pod_data_rows(driver):
    """
    Return the list of real (non-empty-message) <tr> elements currently in the
    Pods DataTable. Empty list means the cluster reported no pods.
    """
    return driver.find_elements(By.XPATH, _DATA_ROW_XPATH)


def _click_first_row_action(driver, button_index: int, timeout: int = DEFAULT_TIMEOUT) -> bool:
    """
    Click the action button at *button_index* on the first data row of the
    active DataTable. Returns False if there are no data rows.

    The Pods list polls every few seconds and re-renders its rows, so we
    re-locate the row and button on each attempt and swallow staleness until
    the click lands (or the timeout elapses).
    """
    deadline = time.time() + timeout
    saw_rows = False
    while time.time() < deadline:
        try:
            rows = driver.find_elements(By.XPATH, _DATA_ROW_XPATH)
            if not rows:
                # No rows yet — keep polling briefly in case the list is still
                # loading, but report False overall if none ever appear.
                time.sleep(0.3)
                continue
            saw_rows = True
            buttons = rows[0].find_elements(By.CSS_SELECTOR, "button")
            if len(buttons) <= button_index:
                time.sleep(0.2)
                continue
            target = buttons[button_index]
            try:
                target.click()
            except Exception:
                driver.execute_script("arguments[0].click();", target)
            return True
        except (StaleElementReferenceException, NoSuchElementException):
            time.sleep(0.2)
    return saw_rows  # rows existed but every click attempt went stale


def open_pod_log_panel(driver, timeout: int = DEFAULT_TIMEOUT) -> bool:
    """
    Click the Logs action button on the first pod row.
    Returns True if a pod row existed and was clicked, False if the list is empty.
    """
    return _click_first_row_action(driver, _POD_LOG_BUTTON_INDEX, timeout)


def open_pod_exec_panel(driver, timeout: int = DEFAULT_TIMEOUT) -> bool:
    """
    Click the Exec (terminal) action button on the first pod row.
    Returns True if a pod row existed and was clicked, False if the list is empty.
    """
    return _click_first_row_action(driver, _POD_EXEC_BUTTON_INDEX, timeout)


def open_resource_graph(driver, timeout: int = DEFAULT_TIMEOUT) -> None:
    """
    Click the 'Resource Graph' button in the ClusterBar, which opens the
    cluster resource graph (ReactFlow) panel for the active cluster.
    """
    wait = WebDriverWait(driver, timeout)
    btn = wait.until(EC.element_to_be_clickable((
        By.CSS_SELECTOR, "button.cluster-bar__icon-btn[title='Resource Graph']",
    )))
    btn.click()
