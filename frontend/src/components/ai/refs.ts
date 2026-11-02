import type { AiRef } from '../../stores/aiChatStore';

/**
 * Object references in the assistant's answers. The system prompt asks the
 * model to write a specific object as `kind/namespace/name` (or `kind/name`
 * when cluster-scoped) in backticks; a code span of that shape whose kind we
 * know becomes a link that opens the object. Anything else stays plain code —
 * a guess at an unknown kind would open a panel that can only fail.
 */

// Singular kind (and the usual short names) → [plural resource, group].
const KINDS: Record<string, [string, string]> = {
    pod: ['pods', ''], po: ['pods', ''],
    service: ['services', ''], svc: ['services', ''],
    configmap: ['configmaps', ''], cm: ['configmaps', ''],
    secret: ['secrets', ''],
    namespace: ['namespaces', ''], ns: ['namespaces', ''],
    node: ['nodes', ''], no: ['nodes', ''],
    persistentvolumeclaim: ['persistentvolumeclaims', ''], pvc: ['persistentvolumeclaims', ''],
    persistentvolume: ['persistentvolumes', ''], pv: ['persistentvolumes', ''],
    serviceaccount: ['serviceaccounts', ''], sa: ['serviceaccounts', ''],
    endpoints: ['endpoints', ''],
    deployment: ['deployments', 'apps'], deploy: ['deployments', 'apps'],
    statefulset: ['statefulsets', 'apps'], sts: ['statefulsets', 'apps'],
    daemonset: ['daemonsets', 'apps'], ds: ['daemonsets', 'apps'],
    replicaset: ['replicasets', 'apps'], rs: ['replicasets', 'apps'],
    job: ['jobs', 'batch'],
    cronjob: ['cronjobs', 'batch'], cj: ['cronjobs', 'batch'],
    ingress: ['ingresses', 'networking.k8s.io'], ing: ['ingresses', 'networking.k8s.io'],
    networkpolicy: ['networkpolicies', 'networking.k8s.io'], netpol: ['networkpolicies', 'networking.k8s.io'],
    role: ['roles', 'rbac.authorization.k8s.io'],
    rolebinding: ['rolebindings', 'rbac.authorization.k8s.io'],
    clusterrole: ['clusterroles', 'rbac.authorization.k8s.io'],
    clusterrolebinding: ['clusterrolebindings', 'rbac.authorization.k8s.io'],
    horizontalpodautoscaler: ['horizontalpodautoscalers', 'autoscaling'], hpa: ['horizontalpodautoscalers', 'autoscaling'],
    storageclass: ['storageclasses', 'storage.k8s.io'],
};

// Plural resource → its full singular kind: the first key listed for it above.
const SINGULAR: Record<string, string> = {};
for (const [k, [res]] of Object.entries(KINDS)) SINGULAR[res] ??= k;

const NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** Parses `kind/namespace/name` or `kind/name`; null when it is not one. */
export function parseObjectRef(text: string): AiRef | null {
    const parts = text.trim().split('/');
    if (parts.length < 2 || parts.length > 3) return null;
    const kind = parts[0].toLowerCase();
    const known = KINDS[kind] ?? (SINGULAR[kind] ? KINDS[SINGULAR[kind]] : undefined);
    if (!known) return null;
    const [namespace, name] = parts.length === 3 ? [parts[1], parts[2]] : ['', parts[1]];
    if (!NAME.test(name) || (namespace && !NAME.test(namespace))) return null;
    return { resource: known[0], group: known[1], namespace, name };
}

/** The short kind a ref is shown with: "deployment/shop/api". */
export function refLabel(ref: AiRef): string {
    const kind = SINGULAR[ref.resource] ?? ref.resource;
    const path = ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
    return ref.container ? `${kind}/${path} · ${ref.container}` : `${kind}/${path}`;
}

/** The ref a tool call targets, when its arguments name one object. */
export function refFromToolArgs(name: string, args?: Record<string, unknown>): AiRef | null {
    if (!args) return null;
    const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
    if (name === 'get_pod_logs' && s('pod')) {
        return { resource: 'pods', group: '', namespace: s('namespace'), name: s('pod'), container: s('container') || undefined };
    }
    if ((name === 'scale_workload' || name === 'restart_workload') && s('name')) {
        return parseObjectRef(`${s('kind')}/${s('namespace')}/${s('name')}`);
    }
    if (s('resource') && s('name')) {
        return { resource: s('resource'), group: s('group'), namespace: s('namespace'), name: s('name') };
    }
    return null;
}
