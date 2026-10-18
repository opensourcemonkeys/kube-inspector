"""
E2E smoke tests for kube-ins.

Prerequisites: `make dev` must be running so the Wails dev server is
available at http://localhost:34115.
"""

import pytest
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

TIMEOUT = 20  # seconds to wait for elements


class TestMainFlow:
    def test_react_root_is_present(self, driver):
        """The React mount point must exist as soon as the page loads."""
        wait = WebDriverWait(driver, TIMEOUT)
        root = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "#root")))
        assert root is not None, "#root element not found"

    def test_dockview_panel_manager_renders(self, driver):
        """
        Dockview renders its container with the theme class we apply in
        DockviewContainer.tsx. Wait for it to appear so we know the React
        tree has fully mounted and the panel manager is active.
        """
        wait = WebDriverWait(driver, TIMEOUT)
        dockview = wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, ".dockview-theme-monolith"))
        )
        assert dockview.is_displayed(), "Dockview container is not visible"

    def test_sidebar_workloads_section_is_visible(self, driver):
        """
        The left sidebar (id='tour-sidebar') must be rendered and the
        Workloads section header must be visible and clickable.
        """
        wait = WebDriverWait(driver, TIMEOUT)

        # The sidebar nav element
        sidebar = wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "#tour-sidebar")))
        assert sidebar.is_displayed(), "Sidebar nav is not visible"

        # The Workloads section badge label
        workloads_label = wait.until(
            EC.visibility_of_element_located(
                (By.XPATH, "//*[contains(@class,'sidebar-section__badge-label') and text()='Workloads']")
            )
        )
        assert workloads_label.is_displayed(), "Workloads section label is not visible"

    def test_sidebar_cluster_section_is_visible(self, driver):
        """
        The Cluster section of the sidebar must also be present, confirming
        all nav groups are rendered.
        """
        wait = WebDriverWait(driver, TIMEOUT)
        cluster_label = wait.until(
            EC.visibility_of_element_located(
                (By.XPATH, "//*[contains(@class,'sidebar-section__badge-label') and text()='Cluster']")
            )
        )
        assert cluster_label.is_displayed(), "Cluster section label is not visible"

    def test_sidebar_workloads_toggle_expands_items(self, driver):
        """
        Clicking the Workloads section toggle should reveal the Pods menu
        item (the default expanded group on first load). If it's already
        expanded, the item is immediately present.
        """
        wait = WebDriverWait(driver, TIMEOUT)

        # Ensure Workloads toggle is present
        toggle = wait.until(
            EC.element_to_be_clickable(
                (By.XPATH, "//button[contains(@class,'sidebar-section__toggle') and .//*[text()='Workloads']]")
            )
        )

        # If the group is collapsed, click to expand
        expanded = toggle.get_attribute("aria-expanded")
        if expanded != "true":
            toggle.click()

        pods_item = wait.until(
            EC.visibility_of_element_located(
                (By.XPATH, "//button[contains(@class,'sidebar-item') and .//*[text()='Pods']]")
            )
        )
        assert pods_item.is_displayed(), "Pods menu item is not visible after expanding Workloads"
