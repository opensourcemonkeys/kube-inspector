import React, { createContext, useContext, useRef, useCallback } from 'react';
import { DockviewApi } from 'dockview';
import { NAV_GROUPS } from '../components/menu/menuItems';
import { useT, type TFn } from '../i18n/useT';

// A moved panel's params cannot carry its icon — it is a React element, which
// neither structured clone nor JSON survives — so the receiving side looks it
// up again by view (see openReceivedPanel).
const viewIcons: Record<string, React.ReactNode> = Object.fromEntries(
    NAV_GROUPS.flatMap(g => g.items.map(i => [i.view, i.icon])),
);

/**
 * Every panel title is stored as an i18n key plus its variables, not as text.
 *
 * Dockview writes a tab title once, at addPanel time, so a language switch
 * would otherwise leave every open tab in the old language until it was closed
 * and reopened. Keeping the key in `params` lets DockviewContainer re-render
 * all of them on a locale change — and it means a panel transferred to another
 * instance is titled in the *receiver's* language rather than inheriting the
 * sender's text.
 *
 * `titleVars.suffix` is the ` • ` qualifier the app appends everywhere (a
 * cluster name, or `namespace/name`); it is deliberately not part of the
 * catalog, because it is data.
 */
export interface PanelTitleParams {
    titleKey?: string;
    titleVars?: Record<string, string | number | undefined>;
}

export function renderPanelTitle(t: TFn, params: PanelTitleParams): string {
    const { titleKey, titleVars } = params;
    if (!titleKey) return '';
    const { suffix, ...vars } = titleVars ?? {};
    // The one place the typed-key guarantee cannot hold: the key arrives in
    // panel params, either computed from a view name or sent by another
    // instance. defaultValue keeps an unknown key (a view added without its
    // catalog entry, a panel from a newer build) readable instead of blank.
    const translate = t as unknown as (key: string, options?: Record<string, unknown>) => string;
    const base = translate(titleKey, { ...vars, defaultValue: titleKey });
    return suffix ? `${base} • ${suffix}` : base;
}

/** nav:item.* for a view name that is only known at runtime (panel params). */
const viewTitleKey = (view: string) => `nav:item.${view}`;


export interface TabDef {
    view: string;
    clusterName: string;
    icon?: React.ReactNode;
}

export interface YamlPanelDef {
    clusterName: string;
    resourceKind: 'pod' | 'deployment' | 'statefulset' | 'replicaset' | 'daemonset' | 'job' | 'cronjob' | 'service' | 'ingress' | 'ingressclass' | 'endpoint' | 'configmap' | 'secret' | 'node' | 'namespace' | 'resourcequota' | 'limitrange' | 'persistentvolume' | 'persistentvolumeclaim' | 'storageclass' | 'serviceaccount' | 'role' | 'rolebinding';
    name: string;
    namespace: string;
    /** dockview panel id of the list panel to split beside */
    referencePanel: string;
}

export interface LogPanelDef {
    clusterName: string;
    resourceKind: 'pod' | 'deployment' | 'statefulset' | 'replicaset' | 'daemonset' | 'job' | 'cronjob';
    name: string;
    namespace: string;
    referencePanel: string;
}

export interface ExecPanelDef {
    clusterName: string;
    name: string;
    namespace: string;
    container: string;
    referencePanel: string;
}

export interface NodeShellDef {
    clusterName: string;
    nodeName: string;
    referencePanel: string;
}

export interface PolicyViewerDef {
    clusterName: string;
    name: string;
    namespace: string;
    referencePanel: string;
}

export interface ConfigMapEditorDef {
    clusterName: string;
    name: string;
    namespace: string;
    referencePanel: string;
}

export interface SecretEditorDef {
    clusterName: string;
    name: string;
    namespace: string;
    referencePanel: string;
}

export interface RoleEditorDef {
    clusterName: string;
    name: string;
    namespace: string;
    referencePanel: string;
}

export interface RoleBindingEditorDef {
    clusterName: string;
    name: string;
    namespace: string;
    referencePanel: string;
}

export interface DescribePanelDef {
    clusterName: string;
    /** Plural resource name, e.g. "pods" — matches the sidebar/TUI view keys. */
    resource: string;
    name: string;
    namespace: string;
    referencePanel: string;
}

export interface ObjectYamlDef {
    clusterName: string;
    kind: string;
    group: string;
    resource: string;
    name: string;
    namespace: string;
    referencePanel: string;
}

export interface ReceivedPanel {
    componentType: string;
    title: string;
    params: Record<string, any>;
}

interface TabContextValue {
    registerApi: (api: DockviewApi) => void;
    getApi: () => DockviewApi | null;
    openTab: (def: TabDef) => void;
    openYamlPanel: (def: YamlPanelDef) => void;
    openLogPanel: (def: LogPanelDef) => void;
    openExecPanel: (def: ExecPanelDef) => void;
    openNodeShellPanel: (def: NodeShellDef) => void;
    openPolicyViewer: (def: PolicyViewerDef) => void;
    openConfigMapEditor: (def: ConfigMapEditorDef) => void;
    openSecretEditor: (def: SecretEditorDef) => void;
    openRoleEditor: (def: RoleEditorDef) => void;
    openRoleBindingEditor: (def: RoleBindingEditorDef) => void;
    openObjectYaml: (def: ObjectYamlDef) => void;
    openDescribePanel: (def: DescribePanelDef) => void;
    openTerminal: (clusterName: string) => void;
    openApplyYaml: (clusterName: string) => void;
    openDiagnostics: () => void;
    openPortForwards: () => void;
    openClusterResourceView: (clusterName: string) => void;
    openReceivedPanel: (panel: ReceivedPanel) => void;
}

function positionAfter(api: DockviewApi, referenceId: string) {
    const ref = api.getPanel(referenceId);
    if (!ref) return undefined;
    const panels: any[] = (ref as any).group?.panels ?? [];
    const idx = panels.findIndex((p: any) => p.id === referenceId);
    return { referencePanel: referenceId, direction: 'within' as const, index: idx >= 0 ? idx + 1 : undefined };
}

const TabContext = createContext<TabContextValue | null>(null);

export function TabProvider({ children }: { children: React.ReactNode }) {
    const t = useT();
    const apiRef = useRef<DockviewApi | null>(null);
    const terminalCounterRef = useRef(0);
    const applyYamlCounterRef = useRef(0);

    const registerApi = useCallback((api: DockviewApi) => {
        apiRef.current = api;
    }, []);

    const getApi = useCallback(() => apiRef.current, []);

    const openTab = useCallback((def: TabDef) => {
        const api = apiRef.current;
        if (!api) return;

        const panelId = def.clusterName ? `${def.view}:${def.clusterName}` : def.view;

        const existing = api.getPanel(panelId);
        if (existing) {
            existing.focus();
            return;
        }

        const titleParams = {
            titleKey: viewTitleKey(def.view),
            titleVars: def.clusterName ? { suffix: def.clusterName } : undefined,
        };
        api.addPanel({
            id: panelId,
            component: 'view',
            title: renderPanelTitle(t, titleParams),
            params: { view: def.view, clusterName: def.clusterName, icon: def.icon ?? null, ...titleParams },
        });
    }, [t]);

    // Like the apply-yaml panel, the terminal is seeded with a cluster but stays
    // retargetable from its own toolbar — so the id is just the session id and
    // the title is re-set by the panel when the choice changes.
    const openTerminal = useCallback((clusterName: string) => {
        const api = apiRef.current;
        if (!api) return;

        terminalCounterRef.current += 1;
        const n = terminalCounterRef.current;
        const sessionId = `terminal-${n}-${Date.now()}`;

        const titleParams = {
            titleKey: 'panels:title.terminal',
            titleVars: clusterName ? { n, suffix: clusterName } : { n },
        };
        api.addPanel({
            id: sessionId,
            component: 'terminal',
            title: renderPanelTitle(t, titleParams),
            params: { sessionId, clusterName, ...titleParams },
        });
    }, [t]);

    // The panel is seeded with a cluster but, unlike the read-only views, lets
    // the user retarget it from its own toolbar — so the id only has to stay
    // unique, and the title is re-set by the panel when the choice changes.
    const openApplyYaml = useCallback((clusterName: string) => {
        const api = apiRef.current;
        if (!api) return;

        applyYamlCounterRef.current += 1;
        const n = applyYamlCounterRef.current;

        const titleParams = {
            titleKey: 'panels:title.applyYaml',
            titleVars: clusterName ? { suffix: clusterName } : undefined,
        };
        api.addPanel({
            id: `applyYaml:${clusterName}:${n}`,
            component: 'applyYaml',
            title: renderPanelTitle(t, titleParams),
            params: { clusterName, ...titleParams },
        });
    }, [t]);

    // A singleton, and deliberately outside the `${view}:${clusterName}` scheme:
    // the panel describes this process, not a cluster. Empty params keep it
    // structured-clone safe for a drag-out to another window.
    const openDiagnostics = useCallback(() => {
        const api = apiRef.current;
        if (!api) return;

        const existing = api.getPanel('diagnostics');
        if (existing) {
            existing.api.setActive();
            return;
        }
        const titleParams = { titleKey: 'panels:title.diagnostics' };
        api.addPanel({
            id: 'diagnostics',
            component: 'diagnostics',
            title: renderPanelTitle(t, titleParams),
            params: { ...titleParams },
        });
    }, [t]);

    // Also a singleton outside the `${view}:${clusterName}` scheme, for the same
    // reason as Diagnostics: it describes this process rather than a cluster.
    // Port forwards are owned by the backend and span every cluster the user has
    // opened, so there is nothing sensible to pin it to.
    const openPortForwards = useCallback(() => {
        const api = apiRef.current;
        if (!api) return;

        const existing = api.getPanel('portforwards');
        if (existing) {
            existing.api.setActive();
            return;
        }
        const titleParams = { titleKey: 'panels:title.portForwards' };
        api.addPanel({
            id: 'portforwards',
            component: 'portforwards',
            title: renderPanelTitle(t, titleParams),
            params: { ...titleParams },
        });
    }, [t]);

    const openLogPanel = useCallback((def: LogPanelDef) => {
        const api = apiRef.current;
        if (!api) return;

        const panelId = `log:${def.resourceKind}:${def.clusterName}:${def.namespace}/${def.name}`;
        const existing = api.getPanel(panelId);
        if (existing) {
            existing.focus();
            return;
        }

        const titleParams = { titleKey: 'panels:title.logs', titleVars: { suffix: `${def.namespace}/${def.name}` } };
        const addOptions: any = {
            id: panelId,
            component: 'logViewer',
            title: renderPanelTitle(t, titleParams),
            params: {
                ...titleParams,
                clusterName: def.clusterName,
                resourceKind: def.resourceKind,
                name: def.name,
                namespace: def.namespace,
            },
        };

        const pos = positionAfter(api, def.referencePanel);
        if (pos) addOptions.position = pos;

        api.addPanel(addOptions);
    }, [t]);

    const openExecPanel = useCallback((def: ExecPanelDef) => {
        const api = apiRef.current;
        if (!api) return;

        const panelId = `exec:${def.clusterName}:${def.namespace}/${def.name}:${def.container}`;
        const existing = api.getPanel(panelId);
        if (existing) {
            existing.focus();
            return;
        }

        const sessionId = `exec-${Date.now()}`;
        const titleParams = { titleKey: 'panels:title.exec', titleVars: { suffix: `${def.namespace}/${def.name}` } };
        const addOptions: any = {
            id: panelId,
            component: 'podExec',
            title: renderPanelTitle(t, titleParams),
            params: {
                ...titleParams,
                clusterName: def.clusterName,
                sessionId,
                name: def.name,
                namespace: def.namespace,
                container: def.container,
            },
        };

        const pos = positionAfter(api, def.referencePanel);
        if (pos) addOptions.position = pos;

        api.addPanel(addOptions);
    }, [t]);

    // One shell per node per cluster: the panel id carries both, so a second
    // click focuses the open tab instead of creating a second privileged pod.
    const openNodeShellPanel = useCallback((def: NodeShellDef) => {
        const api = apiRef.current;
        if (!api) return;

        const panelId = `nodeshell:${def.clusterName}:${def.nodeName}`;
        const existing = api.getPanel(panelId);
        if (existing) {
            existing.focus();
            return;
        }

        const sessionId = `nodeshell-${Date.now()}`;
        const titleParams = { titleKey: 'panels:title.nodeShell', titleVars: { suffix: def.nodeName } };
        const addOptions: any = {
            id: panelId,
            component: 'nodeShell',
            title: renderPanelTitle(t, titleParams),
            params: {
                ...titleParams,
                clusterName: def.clusterName,
                sessionId,
                nodeName: def.nodeName,
            },
        };

        const pos = positionAfter(api, def.referencePanel);
        if (pos) addOptions.position = pos;

        api.addPanel(addOptions);
    }, [t]);

    const openPolicyViewer = useCallback((def: PolicyViewerDef) => {
        const api = apiRef.current;
        if (!api) return;

        const panelId = `policy:${def.clusterName}:${def.namespace}/${def.name}`;
        const existing = api.getPanel(panelId);
        if (existing) {
            existing.focus();
            return;
        }

        const titleParams = { titleKey: 'panels:title.policy', titleVars: { suffix: `${def.namespace}/${def.name}` } };
        const addOptions: any = {
            id: panelId,
            component: 'policyViewer',
            title: renderPanelTitle(t, titleParams),
            params: { clusterName: def.clusterName, name: def.name, namespace: def.namespace , ...titleParams },
        };

        const pos = positionAfter(api, def.referencePanel);
        if (pos) addOptions.position = pos;

        api.addPanel(addOptions);
    }, [t]);

    const openConfigMapEditor = useCallback((def: ConfigMapEditorDef) => {
        const api = apiRef.current;
        if (!api) return;

        const panelId = `configmap-editor:${def.clusterName}:${def.namespace}/${def.name}`;
        const existing = api.getPanel(panelId);
        if (existing) {
            existing.focus();
            return;
        }

        const titleParams = { titleKey: 'panels:title.edit', titleVars: { suffix: `${def.namespace}/${def.name}` } };
        const addOptions: any = {
            id: panelId,
            component: 'configMapEditor',
            title: renderPanelTitle(t, titleParams),
            params: { clusterName: def.clusterName, name: def.name, namespace: def.namespace , ...titleParams },
        };

        const pos = positionAfter(api, def.referencePanel);
        if (pos) addOptions.position = pos;

        api.addPanel(addOptions);
    }, [t]);

    const openObjectYaml = useCallback((def: ObjectYamlDef) => {
        const api = apiRef.current;
        if (!api) return;

        const panelId = `object-yaml:${def.clusterName}:${def.group}/${def.resource}:${def.namespace}/${def.name}`;
        const existing = api.getPanel(panelId);
        if (existing) {
            existing.focus();
            return;
        }

        const titleParams = { titleKey: 'panels:title.edit', titleVars: { suffix: `${def.namespace ? def.namespace + '/' : ''}${def.name}` } };
        const addOptions: any = {
            id: panelId,
            component: 'objectYaml',
            title: renderPanelTitle(t, titleParams),
            params: {
                ...titleParams,
                clusterName: def.clusterName,
                kind: def.kind,
                group: def.group,
                resource: def.resource,
                name: def.name,
                namespace: def.namespace,
            },
        };

        const pos = positionAfter(api, def.referencePanel);
        if (pos) addOptions.position = pos;

        api.addPanel(addOptions);
    }, [t]);

    const openSecretEditor = useCallback((def: SecretEditorDef) => {
        const api = apiRef.current;
        if (!api) return;

        const panelId = `secret-editor:${def.clusterName}:${def.namespace}/${def.name}`;
        const existing = api.getPanel(panelId);
        if (existing) {
            existing.focus();
            return;
        }

        const titleParams = { titleKey: 'panels:title.edit', titleVars: { suffix: `${def.namespace}/${def.name}` } };
        const addOptions: any = {
            id: panelId,
            component: 'secretEditor',
            title: renderPanelTitle(t, titleParams),
            params: { clusterName: def.clusterName, name: def.name, namespace: def.namespace , ...titleParams },
        };

        const pos = positionAfter(api, def.referencePanel);
        if (pos) addOptions.position = pos;

        api.addPanel(addOptions);
    }, [t]);

    const openRoleEditor = useCallback((def: RoleEditorDef) => {
        const api = apiRef.current;
        if (!api) return;

        const panelId = `role-editor:${def.clusterName}:${def.namespace}/${def.name}`;
        const existing = api.getPanel(panelId);
        if (existing) {
            existing.focus();
            return;
        }

        const titleParams = { titleKey: 'panels:title.edit', titleVars: { suffix: `${def.namespace}/${def.name}` } };
        const addOptions: any = {
            id: panelId,
            component: 'roleEditor',
            title: renderPanelTitle(t, titleParams),
            params: { clusterName: def.clusterName, name: def.name, namespace: def.namespace , ...titleParams },
        };

        const pos = positionAfter(api, def.referencePanel);
        if (pos) addOptions.position = pos;

        api.addPanel(addOptions);
    }, [t]);

    const openRoleBindingEditor = useCallback((def: RoleBindingEditorDef) => {
        const api = apiRef.current;
        if (!api) return;

        const panelId = `rolebinding-editor:${def.clusterName}:${def.namespace}/${def.name}`;
        const existing = api.getPanel(panelId);
        if (existing) {
            existing.focus();
            return;
        }

        const titleParams = { titleKey: 'panels:title.edit', titleVars: { suffix: `${def.namespace}/${def.name}` } };
        const addOptions: any = {
            id: panelId,
            component: 'roleBindingEditor',
            title: renderPanelTitle(t, titleParams),
            params: { clusterName: def.clusterName, name: def.name, namespace: def.namespace , ...titleParams },
        };

        const pos = positionAfter(api, def.referencePanel);
        if (pos) addOptions.position = pos;

        api.addPanel(addOptions);
    }, [t]);

    const openClusterResourceView = useCallback((clusterName: string) => {
        const api = apiRef.current;
        if (!api) return;

        const panelId = `cluster-resource-view:${clusterName}`;
        const existing = api.getPanel(panelId);
        if (existing) {
            existing.focus();
            return;
        }

        const titleParams = { titleKey: 'panels:title.resourceGraph', titleVars: { suffix: clusterName } };
        api.addPanel({
            id: panelId,
            component: 'clusterResource',
            title: renderPanelTitle(t, titleParams),
            params: { clusterName, ...titleParams },
        });
    }, [t]);

    const openYamlPanel = useCallback((def: YamlPanelDef) => {
        const api = apiRef.current;
        if (!api) return;

        const panelId = `yaml:${def.resourceKind}:${def.clusterName}:${def.namespace}/${def.name}`;
        const existing = api.getPanel(panelId);
        if (existing) {
            existing.focus();
            return;
        }

        // referencePanel is now `${view}:${clusterName}` — extract the view key for the label
        const viewKey = def.referencePanel.split(':')[0];
        const titleParams = { titleKey: viewTitleKey(viewKey), titleVars: { suffix: `${def.namespace}/${def.name}` } };
        const addOptions: any = {
            id: panelId,
            component: 'yamlEditor',
            title: renderPanelTitle(t, titleParams),
            params: {
                ...titleParams,
                clusterName: def.clusterName,
                resourceKind: def.resourceKind,
                name: def.name,
                namespace: def.namespace,
            },
        };

        const pos = positionAfter(api, def.referencePanel);
        if (pos) addOptions.position = pos;

        api.addPanel(addOptions);
    }, [t]);

    const openDescribePanel = useCallback((def: DescribePanelDef) => {
        const api = apiRef.current;
        if (!api) return;

        const panelId = `describe:${def.clusterName}:${def.resource}:${def.namespace}/${def.name}`;
        const existing = api.getPanel(panelId);
        if (existing) {
            existing.focus();
            return;
        }

        const titleParams = { titleKey: 'panels:title.describe', titleVars: { name: def.name, suffix: def.clusterName } };
        const addOptions: any = {
            id: panelId,
            component: 'describe',
            title: renderPanelTitle(t, titleParams),
            params: {
                ...titleParams,
                clusterName: def.clusterName,
                resource: def.resource,
                name: def.name,
                namespace: def.namespace,
            },
        };

        const pos = positionAfter(api, def.referencePanel);
        if (pos) addOptions.position = pos;

        api.addPanel(addOptions);
    }, [t]);

    const openReceivedPanel = useCallback((panel: ReceivedPanel) => {
        const p = panel.params ?? {};
        const cn: string = p.clusterName ?? '';
        switch (panel.componentType) {
            case 'view': {
                // The sender's title string is deliberately ignored: openTab
                // rebuilds it from the view key, so a panel handed over from an
                // instance running another language arrives titled in ours.
                const view = p.view ?? 'pods';
                openTab({ view, clusterName: cn, icon: viewIcons[view] });
                break;
            }
            case 'yamlEditor':
                openYamlPanel({ clusterName: cn, resourceKind: p.resourceKind, name: p.name, namespace: p.namespace, referencePanel: '' });
                break;
            case 'logViewer':
                openLogPanel({ clusterName: cn, resourceKind: p.resourceKind, name: p.name, namespace: p.namespace, referencePanel: '' });
                break;
            case 'policyViewer':
                openPolicyViewer({ clusterName: cn, name: p.name, namespace: p.namespace, referencePanel: '' });
                break;
            case 'configMapEditor':
                openConfigMapEditor({ clusterName: cn, name: p.name, namespace: p.namespace, referencePanel: '' });
                break;
            case 'secretEditor':
                openSecretEditor({ clusterName: cn, name: p.name, namespace: p.namespace, referencePanel: '' });
                break;
            case 'roleEditor':
                openRoleEditor({ clusterName: cn, name: p.name, namespace: p.namespace, referencePanel: '' });
                break;
            case 'roleBindingEditor':
                openRoleBindingEditor({ clusterName: cn, name: p.name, namespace: p.namespace, referencePanel: '' });
                break;
            case 'objectYaml':
                openObjectYaml({ clusterName: cn, kind: p.kind, group: p.group, resource: p.resource, name: p.name, namespace: p.namespace, referencePanel: '' });
                break;
            case 'describe':
                openDescribePanel({ clusterName: cn, resource: p.resource, name: p.name, namespace: p.namespace, referencePanel: '' });
                break;
            case 'clusterResource':
                openClusterResourceView(cn);
                break;
            case 'applyYaml':
                openApplyYaml(cn);
                break;
            case 'portforwards':
                // Same rule as diagnostics: moving it shows THAT process's
                // tunnels, which is the only thing it could truthfully show.
                openPortForwards();
                break;
            case 'diagnostics':
                // Transferable on purpose: moving it to another instance shows
                // THAT instance's diagnostics, which is the useful behaviour.
                openDiagnostics();
                break;
        }
    }, [openTab, openYamlPanel, openLogPanel, openPolicyViewer, openConfigMapEditor, openSecretEditor, openRoleEditor, openRoleBindingEditor, openObjectYaml, openDescribePanel, openClusterResourceView, openApplyYaml, openDiagnostics, openPortForwards]);

    return (
        <TabContext.Provider value={{ registerApi, getApi, openTab, openYamlPanel, openLogPanel, openExecPanel, openNodeShellPanel, openPolicyViewer, openConfigMapEditor, openSecretEditor, openRoleEditor, openRoleBindingEditor, openObjectYaml, openDescribePanel, openTerminal, openApplyYaml, openClusterResourceView, openDiagnostics, openPortForwards, openReceivedPanel }}>
            {children}
        </TabContext.Provider>
    );
}

export function useTabContext() {
    const ctx = useContext(TabContext);
    if (!ctx) throw new Error('useTabContext must be used within TabProvider');
    return ctx;
}
