"""
Navigation smoke tests for kube-ins.

Each test clicks a sidebar menu item and verifies that:
  1. A Dockview tab for that resource appears (or is focused if already open).
  2. The panel's list heading <h3> is present — confirming the ViewPanel mounted
     and routed to the correct list component.
  3. A PrimeReact DataTable is present (skipped for views that render custom
     layouts instead of a DataTable, e.g. Resource Quotas).

Prerequisites: `make dev` must be running (http://localhost:34115).
No cluster connection is required — DataTables render with 'emptyMessage' when
the resource list is empty.
"""

import pytest
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

from helpers import navigate_to, wait_for_tab, wait_for_panel_heading

# ─────────────────────────────────────────────────────────────────────────────
# Navigation item registry
#
# Tuple: (group_label, sidebar_item_label, expected_h3_text, has_datatable)
#
# group_label         — .sidebar-section__badge-label text (e.g. 'Workloads')
# sidebar_item_label  — .sidebar-item__label text (e.g. 'Pods')
# expected_h3_text    — exact text of the <h3> in the list component's JSX
# has_datatable       — False for components that use a custom layout instead
#                       of PrimeReact DataTable (Nodes uses NodeCard grid;
#                       Resource Quotas uses a card layout)
#
# Heading notes:
#   • Most views use "{Resource} List" but a few use a plain noun phrase:
#     "Persistent Volumes", "Volume Claims", "Storage Classes", "Resource Quotas"
# ─────────────────────────────────────────────────────────────────────────────
NAV_ITEMS = [
    # ── Workloads ──────────────────────────────────────────────────────────
    ("Workloads",         "Pods",             "Pod List",            True),
    ("Workloads",         "Deployments",      "Deployment List",     True),
    ("Workloads",         "StatefulSets",     "StatefulSet List",    True),
    ("Workloads",         "ReplicaSets",      "ReplicaSet List",     True),
    ("Workloads",         "DaemonSets",       "DaemonSet List",      True),
    ("Workloads",         "Jobs",             "Job List",            True),
    ("Workloads",         "CronJobs",         "CronJob List",        True),
    # ── Networking ─────────────────────────────────────────────────────────
    ("Networking",        "Services",         "Service List",        True),
    ("Networking",        "Ingresses",        "Ingress List",        True),
    ("Networking",        "Ingress Classes",  "Ingress Class List",  True),
    ("Networking",        "Endpoints",        "Endpoint List",       True),
    ("Networking",        "Network Policies", "Network Policy List", True),
    # ── Config & Security ──────────────────────────────────────────────────
    ("Config & Secrets", "ConfigMaps",       "ConfigMap List",      True),
    ("Config & Secrets", "Secrets",          "Secret List",         True),
    ("Security", "Service Accounts", "Service Account List",True),
    ("Security", "Roles",            "Role List",           True),
    ("Security", "Role Bindings",    "Role Binding List",   True),
    # ── Storage ────────────────────────────────────────────────────────────
    ("Storage",           "Persistent Volumes", "Persistent Volumes",True),
    ("Storage",           "Volume Claims",      "Volume Claims",     True),
    ("Storage",           "Storage Classes",    "Storage Classes",   True),
    # ── Cluster ────────────────────────────────────────────────────────────
    # Nodes renders NodeCard components (card grid), not a PrimeReact DataTable
    ("Cluster",           "Nodes",            "Node List",           False),
    ("Cluster",           "Namespaces",       "Namespace List",      True),
    ("Cluster",           "Events",           "Event List",          True),
    # Resource Quotas renders card-based layout rather than DataTable
    ("Cluster",           "Resource Quotas",  "Resource Quotas",     False),
    ("Cluster",           "Limit Ranges",     "Limit Range List",    True),
]

PANEL_TIMEOUT = 10  # seconds; panels mount synchronously in React


class TestNavigation:
    """
    Parametrised suite: one test per sidebar item.

    All tests share the session-scoped `driver` fixture defined in conftest.py.
    Dockview keeps each opened panel alive in the tab bar, so by the end of
    this class every resource list panel will be open in the browser.
    """

    @pytest.mark.parametrize(
        "group,item,heading,has_datatable",
        NAV_ITEMS,
        ids=[item for _, item, _, _ in NAV_ITEMS],
    )
    def test_navigate_to_resource_list(self, driver, group, item, heading, has_datatable):
        """
        Clicking *item* in the sidebar must:
          • open (or focus) a Dockview tab whose title contains the item label
          • render the expected <h3> heading in the panel content
          • render a PrimeReact DataTable (if has_datatable is True)
        """
        # ── Step 1: click the sidebar item ───────────────────────────────────
        navigate_to(driver, group, item)

        # ── Step 2: confirm a Dockview tab exists for this resource ──────────
        #
        # The tab title is "{item} • {clusterName}" or just "{item}" when no
        # cluster is selected.  We match the item label as a fragment so both
        # forms are accepted.
        wait_for_tab(driver, item, timeout=PANEL_TIMEOUT)

        # ── Step 3: confirm the list component's <h3> is in the DOM ─────────
        #
        # Each list component renders a unique <h3> immediately on mount.
        # Presence proves the ViewPanel routed correctly and the component
        # tree rendered without throwing a JS error.
        wait_for_panel_heading(driver, heading, timeout=PANEL_TIMEOUT)

        # ── Step 4: confirm a PrimeReact DataTable is present ────────────────
        if has_datatable:
            WebDriverWait(driver, PANEL_TIMEOUT).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, ".p-datatable"))
            )


class TestNavigationResourceQuotas:
    """
    Standalone test for Resource Quotas which renders a card layout (no DataTable).
    """

    def test_resource_quotas_panel_renders(self, driver):
        """Resource Quotas panel must open and display its heading without crashing."""
        navigate_to(driver, "Cluster", "Resource Quotas")
        wait_for_tab(driver, "Resource Quotas", timeout=PANEL_TIMEOUT)
        wait_for_panel_heading(driver, "Resource Quotas", timeout=PANEL_TIMEOUT)
