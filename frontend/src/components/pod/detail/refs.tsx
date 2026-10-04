import { VscInfo } from 'react-icons/vsc';
import { models } from '../../../../wailsjs/go/models';
import { useTabContext, type YamlPanelDef } from '../../../contexts/TabContext';
import { useT } from '../../../i18n/useT';

// Kinds a pod can point at, mapped to the YAML panel kind and the plural that
// is both the sidebar view key (titling the YAML tab) and the resource the
// Describe panel resolves through the REST mapper. A kind missing here (an
// owner that is a custom resource, say) is shown as plain text.
const KIND_TARGETS: Record<string, { yaml: YamlPanelDef['resourceKind']; view: string }> = {
    ConfigMap:             { yaml: 'configmap',             view: 'configmaps' },
    Secret:                { yaml: 'secret',                view: 'secrets' },
    PersistentVolumeClaim: { yaml: 'persistentvolumeclaim', view: 'persistentvolumeclaims' },
    ServiceAccount:        { yaml: 'serviceaccount',        view: 'serviceaccounts' },
    Node:                  { yaml: 'node',                  view: 'nodes' },
    Service:               { yaml: 'service',               view: 'services' },
    ReplicaSet:            { yaml: 'replicaset',            view: 'replicasets' },
    Deployment:            { yaml: 'deployment',            view: 'deployments' },
    StatefulSet:           { yaml: 'statefulset',           view: 'statefulsets' },
    DaemonSet:             { yaml: 'daemonset',             view: 'daemonsets' },
    Job:                   { yaml: 'job',                   view: 'jobs' },
    CronJob:               { yaml: 'cronjob',               view: 'cronjobs' },
};

export interface Nav {
    clusterName: string;
    referencePanel: string;
}

/**
 * A link to another object: the name opens its YAML panel beside the pod
 * list, the trailing icon (shown on hover) its describe. `showKind` prefixes
 * the kind, as in "DaemonSet kube-proxy".
 */
export function RefLink({ r, nav, showKind = false }: { r: models.ObjectRef; nav: Nav; showKind?: boolean }) {
    const t = useT();
    const { openYamlPanel, openDescribePanel } = useTabContext();
    const target = KIND_TARGETS[r.kind];
    return (
        <span className="pd-ref">
            {showKind && <span className="pd-ref__kind">{r.kind}</span>}
            {target ? (
                <>
                    <button type="button" className="pd-ref__name" title={t('resources:pod.detail.openYaml')}
                        onClick={() => openYamlPanel({ clusterName: nav.clusterName, resourceKind: target.yaml, name: r.name, namespace: r.namespace, referencePanel: nav.referencePanel, titleView: target.view })}>
                        {r.name}
                    </button>
                    <button type="button" className="pd-ref__describe" title={t('action.describe')} aria-label={t('action.describe')}
                        onClick={() => openDescribePanel({ clusterName: nav.clusterName, resource: target.view, name: r.name, namespace: r.namespace, referencePanel: nav.referencePanel })}>
                        <VscInfo />
                    </button>
                </>
            ) : (
                <span className="pd-ref__plain">{r.name}</span>
            )}
        </span>
    );
}

/** A column of links, one per line — Lens' "Secrets" block. */
export function RefList({ refs, nav }: { refs: models.ObjectRef[]; nav: Nav }) {
    return (
        <div className="pd-stack">
            {refs.map((r) => <RefLink key={`${r.kind}/${r.name}`} r={r} nav={nav} />)}
        </div>
    );
}
