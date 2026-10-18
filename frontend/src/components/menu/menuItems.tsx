import React from 'react';
import type navEn from '../../locales/en/nav.json';
import { VscCircleLarge, VscCopy, VscLayers, VscDatabase, VscDesktopDownload, VscPlay, VscCalendar, VscSync, VscGlobe, VscSymbolClass, VscGitCompare, VscShield, VscBug, VscNote, VscKey, VscAccount, VscLock, VscLink, VscOrganization, VscFolder, VscInbox, VscBriefcase, VscServer, VscBell, VscGraph, VscSymbolRuler, VscSymbolNamespace, VscPulse, VscListTree, VscDashboard } from 'react-icons/vsc';


// Labels are i18n keys, not text: the sidebar, the Dockview tab title and the
// YAML/describe panel headings all resolve them at render time, so a language
// switch re-labels every one of them without reopening anything.
// Deriving the view names from the catalog rather than declaring them here is
// what keeps `labelKey` a finite union of literal keys instead of `string` —
// which is the only form i18next's typed `t` will accept. Adding a view without
// its nav:item.* entry is therefore a compile error, not a raw key on screen.
export type ViewKey = keyof (typeof navEn)['item'];
export type GroupKey = keyof (typeof navEn)['group'];

export type NavItem = { labelKey: `nav:item.${ViewKey}`; view: ViewKey; icon: React.ReactNode };
export type NavGroup = { key: GroupKey; labelKey: `nav:group.${GroupKey}`; items: NavItem[] };

// The start screen, outside every group: it is where the app opens and the one
// view that is about the whole cluster rather than one kind of object.
export const HOME_ITEM: NavItem = { labelKey: 'nav:item.overview', view: 'overview', icon: <VscDashboard size={14} /> };

// Every icon is unique across the sidebar — several kinds used to share one,
// so the icon on a tab could not say which list it was.
export const NAV_GROUPS: NavGroup[] = [

    { key: 'workloads', labelKey: 'nav:group.workloads', items: [
        { labelKey: 'nav:item.pods', view: 'pods',         icon: <VscCircleLarge size={14} /> },
        { labelKey: 'nav:item.deployments', view: 'deployments',  icon: <VscLayers size={14} /> },
        { labelKey: 'nav:item.statefulsets', view: 'statefulsets', icon: <VscDatabase size={14} /> },
        { labelKey: 'nav:item.replicasets', view: 'replicasets',  icon: <VscCopy size={14} /> },
        { labelKey: 'nav:item.daemonsets', view: 'daemonsets',   icon: <VscDesktopDownload size={14} /> },
        { labelKey: 'nav:item.jobs', view: 'jobs',         icon: <VscPlay size={14} /> },
        { labelKey: 'nav:item.cronjobs', view: 'cronjobs',     icon: <VscCalendar size={14} /> },
    ]},
    { key: 'networking', labelKey: 'nav:group.networking', items: [
        { labelKey: 'nav:item.services', view: 'services',        icon: <VscSync size={14} /> },
        { labelKey: 'nav:item.ingresses', view: 'ingresses',       icon: <VscGlobe size={14} /> },
        { labelKey: 'nav:item.ingressclasses', view: 'ingressclasses',  icon: <VscSymbolClass size={14} /> },
        { labelKey: 'nav:item.endpoints', view: 'endpoints',       icon: <VscGitCompare size={14} /> },
        { labelKey: 'nav:item.networkpolicies', view: 'networkpolicies', icon: <VscShield size={14} /> },
    ]},
    { key: 'config', labelKey: 'nav:group.config', items: [
        { labelKey: 'nav:item.configmaps', view: 'configmaps',          icon: <VscNote size={14} /> },
        { labelKey: 'nav:item.secrets', view: 'secrets',             icon: <VscKey size={14} /> },
    ]},
    { key: 'security', labelKey: 'nav:group.security', items: [
        { labelKey: 'nav:item.serviceaccounts', view: 'serviceaccounts', icon: <VscAccount size={14} /> },
        { labelKey: 'nav:item.roles', view: 'roles',           icon: <VscLock size={14} /> },
        { labelKey: 'nav:item.rolebindings', view: 'rolebindings',    icon: <VscLink size={14} /> },
        { labelKey: 'nav:item.securityrolemap', view: 'securityrolemap', icon: <VscOrganization size={14} /> },
        { labelKey: 'nav:item.trivy', view: 'trivy',         icon: <VscBug size={14} /> },
    ]},
    { key: 'storage', labelKey: 'nav:group.storage', items: [
        { labelKey: 'nav:item.persistentvolumes', view: 'persistentvolumes',      icon: <VscFolder size={14} /> },
        { labelKey: 'nav:item.persistentvolumeclaims', view: 'persistentvolumeclaims', icon: <VscInbox size={14} /> },
        { labelKey: 'nav:item.storageclasses', view: 'storageclasses',         icon: <VscBriefcase size={14} /> },
    ]},
    { key: 'cluster', labelKey: 'nav:group.cluster', items: [
        { labelKey: 'nav:item.monitoring', view: 'monitoring',     icon: <VscPulse size={14} /> },
        { labelKey: 'nav:item.nodes', view: 'nodes',          icon: <VscServer size={14} /> },
        { labelKey: 'nav:item.namespaces', view: 'namespaces',     icon: <VscSymbolNamespace size={14} /> },
        { labelKey: 'nav:item.events', view: 'events',         icon: <VscBell size={14} /> },
        { labelKey: 'nav:item.resourcequotas', view: 'resourcequotas', icon: <VscGraph size={14} /> },
        { labelKey: 'nav:item.limitranges', view: 'limitranges',    icon: <VscSymbolRuler size={14} /> },
        { labelKey: 'nav:item.crds', view: 'crds',           icon: <VscListTree size={14} /> },
    ]},
];

export const VIEW_GROUP: Record<string, string> = Object.fromEntries(
    NAV_GROUPS.flatMap(g => g.items.map(item => [item.view, g.key]))
);

/** Every sidebar entry, grouped or not — for lookups by view. */
export const NAV_ITEMS: NavItem[] = [HOME_ITEM, ...NAV_GROUPS.flatMap(g => g.items)];
