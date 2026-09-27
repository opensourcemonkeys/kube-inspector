import { lazy, useEffect, useRef } from 'react';
import { VscDashboard } from 'react-icons/vsc';
import { DockviewReact, DockviewReadyEvent, DockviewApi } from 'dockview';
import 'dockview/dist/styles/dockview.css';
import { useTabContext, renderPanelTitle } from '../../contexts/TabContext';
import { useT } from '../../i18n/useT';
import { useClusterContext } from '../../contexts/ClusterContext';
import { initialPanel, onDragHover, onDragLeave, onPanelFromWindow } from '../../lib/shellWindows';
import {
    dragHover,
    dragLeave,
    dropPanel,
    isCrossWindowDragActive,
    takeDroppedPanel,
} from '../../lib/crossWindowDrop';
import FloatableTab from './FloatableTab';
import GroupActions from './GroupActions';
import ViewPanel from './ViewPanel';
import { withBoundary } from '../shared/PanelErrorBoundary';

/**
 * Panel components, keyed by the `component` string TabContext opens them with.
 *
 * Everything except `view` is `React.lazy`: a panel type nobody opens should
 * not be in the chunk the window waits for before it can paint. The libraries
 * behind these are the whole reason the entry bundle was ~6MB — Monaco (the
 * four YAML editors), reactflow (clusterResource), xterm (terminal, podExec) —
 * and each now arrives with the first tab that needs it.
 *
 * `view` stays eager because one is always open: the app boots with the
 * Overview tab. Its own heavy sub-views are lazy inside ViewPanel instead.
 *
 * `withBoundary` (below) supplies the Suspense fallback, so no entry here needs
 * to think about loading state.
 */
const rawComponents = {
    view: ViewPanel,
    yamlEditor: lazy(() => import('./YamlEditorPanel')),
    terminal: lazy(() => import('../terminal/TerminalPanel')),
    applyYaml: lazy(() => import('./ApplyYamlPanel')),
    logViewer: lazy(() => import('../logs/LogViewerPanel')),
    policyViewer: lazy(() => import('../networkpolicy/PolicyViewerPanel')),
    clusterResource: lazy(() => import('../clusterresource/ClusterResourcePanel')),
    configMapEditor: lazy(() => import('../configmap/ConfigMapEditorPanel')),
    secretEditor: lazy(() => import('../secret/SecretEditorPanel')),
    podExec: lazy(() => import('../pod/PodExecPanel')),
    nodeShell: lazy(() => import('../node/NodeShellPanel')),
    roleEditor: lazy(() => import('../role/RoleEditorPanel')),
    roleBindingEditor: lazy(() => import('../rolebinding/RoleBindingEditorPanel')),
    objectYaml: lazy(() => import('./ObjectYamlPanel')),
    describe: lazy(() => import('./DescribePanel')),
    diagnostics: lazy(() => import('../diagnostics/DiagnosticsPanel')),
    portforwards: lazy(() => import('../portforward/PortForwardsPanel')),
};

// Every panel type gets an error boundary, applied here in one place so a new
// entry above cannot forget one. Without it a single component that throws
// during render unmounts the whole tree — one bad panel whites out the window
// and takes every other open tab with it. Wrapped at module scope so the
// component identities stay stable across renders (a fresh wrapper per render
// would remount every panel).
const components = Object.fromEntries(
    Object.entries(rawComponents).map(([key, Component]) => [key, withBoundary(Component as any, key)]),
);

export default function DockviewContainer() {
    const t = useT();
    const { registerApi, openTab, openReceivedPanel, openApplyYaml } = useTabContext();
    const { activeCluster } = useClusterContext();
    const apiRef = useRef<DockviewApi | null>(null);

    // Place a panel dropped in from another window at the spot dockview's
    // overlay was showing. `takeDroppedPanel` is non-null only for our own
    // synthetic cross-window drop (crossWindowDrop.ts), so genuine external
    // drops are ignored. Create at the default position, then move onto the
    // resolved group — dockview gives us the group + edge, but no addPanel
    // position that reproduces a header/tab drop directly.
    const placeDrop = (event: any) => {
        const panel = takeDroppedPanel();
        if (!panel) return;
        const api = apiRef.current;
        if (!api) return;

        let addedId: string | null = null;
        const capture = api.onDidAddPanel(p => { addedId = p.id; });
        openReceivedPanel(panel);
        capture.dispose();

        if (addedId && event.group) {
            api.getPanel(addedId)?.api.moveTo({ group: event.group, position: event.position });
        }
    };

    // Cross-window drag wiring (Electron only; no-ops elsewhere). Main forwards
    // the cursor of a drag hovering this window so we can drive dockview's drop
    // overlay, and forwards the panel itself on release.
    useEffect(() => {
        const offHover = onDragHover((x, y) => dragHover(x, y));
        const offLeave = onDragLeave(() => dragLeave());
        const offPanel = onPanelFromWindow(panel => {
            // A drag landing here places via the live overlay; a plain
            // send-to-window (right-click menu) has no overlay, so default-place.
            if (!dropPanel(panel)) openReceivedPanel(panel);
        });
        return () => { offHover?.(); offLeave?.(); offPanel?.(); };
    }, [openReceivedPanel]);

    // Dockview writes a tab title once, at addPanel time, so a language change
    // would leave every open tab in the old language. Every panel carries the
    // i18n key it was titled from (TabContext.renderPanelTitle), so re-titling
    // is a sweep rather than a reopen. Panels with no titleKey — anything not
    // opened through TabContext — are left alone.
    useEffect(() => {
        const api = apiRef.current;
        if (!api) return;
        for (const panel of api.panels) {
            const params = panel.params as { titleKey?: string; titleVars?: Record<string, string | number> } | undefined;
            if (!params?.titleKey) continue;
            panel.api.setTitle(renderPanelTitle(t, params));
        }
    }, [t]);

    // Dockview adds `.dv-tab-ghost-drag` to DOM when a tab drag starts (pointer mode).
    // We toggle `body.dv-dragging` so CSS can apply `user-select: none !important`
    // across all elements, preventing text highlight-scanning during drag.
    useEffect(() => {
        const observer = new MutationObserver(() => {
            document.body.classList.toggle('dv-dragging', !!document.querySelector('.dv-tab-ghost-drag'));
        });
        observer.observe(document.body, { childList: true, subtree: true });
        return () => {
            observer.disconnect();
            document.body.classList.remove('dv-dragging');
        };
    }, []);

    const onReady = (event: DockviewReadyEvent) => {
        apiRef.current = event.api;
        registerApi(event.api);
        (event.api as any).updateOptions({ dndStrategy: 'pointer' });

        // dockview only shows overlays for a drag it recognises; a cross-window
        // drag is "external" (its PanelTransfer lives in the other renderer), so
        // it asks here whether to accept. Accept only while one is in flight.
        event.api.onUnhandledDragOverEvent(e => {
            if (isCrossWindowDragActive()) e.accept();
        });

        // A window created by dragging a tab out opens with that tab alone;
        // everything else starts on Overview.
        const seed = initialPanel();
        if (seed) openReceivedPanel(seed);
        else openTab({ view: 'overview', clusterName: activeCluster, icon: <VscDashboard size={16} /> });
    };

    // Double-clicking the empty strip of a tab bar opens a blank YAML editor in
    // that group — the same panel the title bar's "YAML Editor" action opens.
    // dockview surfaces no event for its void container, so this is a delegated
    // listener on the dockview root; a double-click anywhere else bubbles
    // through here and is ignored. The group is already active by then: the
    // void container activates its group on pointerdown, so the panel lands in
    // the tab bar that was clicked.
    const openBlankYamlEditor = (event: React.MouseEvent) => {
        const target = event.target as HTMLElement | null;
        if (!target?.closest?.('.dv-void-container')) return;
        openApplyYaml(activeCluster);
    };

    return (
        <div style={{ height: '100%', width: '100%' }} onDoubleClick={openBlankYamlEditor}>
        <DockviewReact
            className="dockview-theme-monolith"
            // Prevent dockview from adding `dockview-theme-abyss` (its default) to the
            // inner dv-shell element, which would set --dv-separator-border to a blue color.
            theme={{ name: 'monolith', className: 'dockview-theme-monolith' } as any}
            components={components}
            defaultTabComponent={FloatableTab}
            // dockview lays the header out as tabs → leftActions → void strip →
            // rightActions, so the "left" slot is the one immediately after the
            // last tab (VS Code's "+" position). "right" would pin it to the far
            // edge of the bar, a whole empty strip away from the tabs.
            leftHeaderActionsComponent={GroupActions}
            floatingGroupBounds="boundedWithinViewport"
            onReady={onReady}
            onDidDrop={placeDrop}
        />
        </div>
    );
}
