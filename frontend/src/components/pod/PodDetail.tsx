import { useCallback, useEffect, useState } from 'react';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Tag } from 'primereact/tag';
import { Button } from 'primereact/button';
import { ProgressSpinner } from 'primereact/progressspinner';
import { VscInfo, VscRefresh } from 'react-icons/vsc';
import { GetPodDetail } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext, type YamlPanelDef } from '../../contexts/TabContext';
import ErrorBanner from '../shared/ErrorBanner';
import { errText } from '../../lib/errText';
import { useT } from '../../i18n/useT';

const MONO = '"JetBrains Mono", "Cascadia Code", monospace';

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

interface Nav {
    clusterName: string;
    referencePanel: string;
}

/** A clickable reference: the name opens the object's YAML, the icon its describe. */
function RefLink({ r, nav, showKind = true }: { r: models.ObjectRef; nav: Nav; showKind?: boolean }) {
    const t = useT();
    const { openYamlPanel, openDescribePanel } = useTabContext();
    const target = KIND_TARGETS[r.kind];
    const label = (
        <>
            {showKind && <span className="pod-detail__ref-kind">{r.kind}</span>}
            <span className="pod-detail__ref-name">{r.name}</span>
        </>
    );
    if (!target) return <span className="pod-detail__ref pod-detail__ref--static">{label}</span>;
    return (
        <span className="pod-detail__ref">
            <button type="button" className="pod-detail__ref-open" title={t('resources:pod.detail.openYaml')}
                onClick={() => openYamlPanel({ clusterName: nav.clusterName, resourceKind: target.yaml, name: r.name, namespace: r.namespace, referencePanel: nav.referencePanel, titleView: target.view })}>
                {label}
            </button>
            <button type="button" className="pod-detail__ref-describe" title={t('action.describe')}
                onClick={() => openDescribePanel({ clusterName: nav.clusterName, resource: target.view, name: r.name, namespace: r.namespace, referencePanel: nav.referencePanel })}>
                <VscInfo size={13} />
            </button>
        </span>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="pod-detail__section">
            <h4 className="pod-detail__heading">{title}</h4>
            {children}
        </section>
    );
}

const list = (items: string[]) =>
    items.length === 0
        ? <span style={{ opacity: 0.5 }}>—</span>
        : <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{items.map((s) => <span key={s}>{s}</span>)}</div>;

/**
 * The pod list's expanded row. Fetched on mount rather than carried by
 * PodInfo, which is re-polled every two seconds; the expansion row is keyed by
 * the pod's `namespace/name`, so a poll re-renders this without remounting it.
 */
export default function PodDetail({ clusterName, pod, referencePanel }: { clusterName: string; pod: models.PodInfo; referencePanel: string }) {
    const t = useT();
    const nav: Nav = { clusterName, referencePanel };
    const [detail, setDetail] = useState<models.PodDetailInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setDetail(models.PodDetailInfo.createFrom(await GetPodDetail(clusterName, pod.name, pod.namespace)));
            setError(null);
        } catch (e) {
            setError(errText(e));
        } finally {
            setLoading(false);
        }
    }, [clusterName, pod.name, pod.namespace]);

    useEffect(() => { load(); }, [load]);

    if (!detail) {
        return error
            ? <ErrorBanner message={error} onRetry={load} busy={loading} />
            : <div className="pod-detail__loading"><ProgressSpinner style={{ width: 18, height: 18 }} strokeWidth="6" /> {t('resources:pod.detail.loading')}</div>;
    }

    const owners = detail.owners ?? [];
    const services = detail.services ?? [];
    const pullSecrets = detail.image_pull_secrets ?? [];
    const volumes = detail.volumes ?? [];
    const envRefs = detail.env_refs ?? [];

    return (
        <div className="pod-detail">
            {error && <ErrorBanner message={error} onRetry={load} busy={loading} stale />}

            <div className="pod-detail__relations">
                {owners.length > 0 && (
                    <div className="pod-detail__relation">
                        <span className="pod-detail__label">{t('resources:pod.detail.ownedBy')}</span>
                        {/* Farthest first, so the chain reads Deployment ← ReplicaSet. */}
                        {[...owners].reverse().map((o, i) => (
                            <span key={`${o.kind}/${o.name}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                {i > 0 && <span className="pod-detail__arrow" aria-hidden />}
                                <RefLink r={o} nav={nav} />
                            </span>
                        ))}
                    </div>
                )}
                {detail.service_account && (
                    <div className="pod-detail__relation">
                        <span className="pod-detail__label">{t('resources:pod.detail.serviceAccount')}</span>
                        <RefLink r={detail.service_account} nav={nav} showKind={false} />
                    </div>
                )}
                {detail.node && (
                    <div className="pod-detail__relation">
                        <span className="pod-detail__label">{t('resources:column.node')}</span>
                        <RefLink r={detail.node} nav={nav} showKind={false} />
                    </div>
                )}
                {services.length > 0 && (
                    <div className="pod-detail__relation">
                        <span className="pod-detail__label">{t('resources:pod.detail.services')}</span>
                        {services.map((s) => <RefLink key={s.name} r={s} nav={nav} showKind={false} />)}
                    </div>
                )}
                {pullSecrets.length > 0 && (
                    <div className="pod-detail__relation">
                        <span className="pod-detail__label">{t('resources:pod.detail.imagePullSecrets')}</span>
                        {pullSecrets.map((s) => <RefLink key={s.name} r={s} nav={nav} showKind={false} />)}
                    </div>
                )}
                <Button text size="small" severity="secondary" className="pod-detail__refresh" onClick={load} disabled={loading}
                    tooltip={t('resources:pod.detail.refresh')} tooltipOptions={{ position: 'left' }}
                    icon={<VscRefresh size={14} />} />
            </div>

            <Section title={t('resources:column.containers')}>
                <DataTable value={detail.containers ?? []} dataKey="name" size="small" className="rlv-subtable">
                    <Column header={t('resources:column.name')} style={{ width: '12rem' }}
                        body={(c: models.PodContainerDetail) => (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ fontFamily: MONO, fontSize: '0.8rem' }}>{c.name}</span>
                                {c.init && <Tag value="init" severity="secondary" />}
                            </span>
                        )} />
                    <Column header={t('resources:column.image')}
                        body={(c: models.PodContainerDetail) => <span title={c.image} className="pod-detail__mono-ellipsis">{c.image}</span>} />
                    <Column header={t('resources:column.ports')} body={(c: models.PodContainerDetail) => list(c.ports ?? [])} />
                    <Column header={t('resources:pod.detail.requests')} body={(c: models.PodContainerDetail) => c.requests || <span style={{ opacity: 0.5 }}>—</span>} />
                    <Column header={t('resources:pod.detail.limits')} body={(c: models.PodContainerDetail) => c.limits || <span style={{ opacity: 0.5 }}>—</span>} />
                    <Column header={t('resources:pod.detail.probes')} body={(c: models.PodContainerDetail) => list(c.probes ?? [])} />
                </DataTable>
            </Section>

            {volumes.length > 0 && (
                <Section title={t('resources:pod.detail.volumes')}>
                    <DataTable value={volumes} dataKey="name" size="small" className="rlv-subtable">
                        <Column header={t('resources:column.name')} style={{ width: '12rem' }}
                            body={(v: models.PodVolumeInfo) => <span style={{ fontFamily: MONO, fontSize: '0.8rem' }}>{v.name}</span>} />
                        <Column header={t('resources:column.type')} style={{ width: '11rem' }}
                            body={(v: models.PodVolumeInfo) => <Tag value={v.type} severity="info" />} />
                        <Column header={t('resources:pod.detail.source')}
                            body={(v: models.PodVolumeInfo) => (
                                <div className="pod-detail__refs">
                                    {(v.refs ?? []).map((r) => <RefLink key={`${r.kind}/${r.name}`} r={r} nav={nav} />)}
                                    {v.detail && <span className="pod-detail__muted">{v.detail}</span>}
                                    {(v.refs ?? []).length === 0 && !v.detail && <span style={{ opacity: 0.5 }}>—</span>}
                                </div>
                            )} />
                        <Column header={t('resources:pod.detail.mounts')}
                            body={(v: models.PodVolumeInfo) => {
                                const ms = v.mounts ?? [];
                                if (ms.length === 0) return <span className="pod-detail__muted">{t('resources:pod.detail.notMounted')}</span>;
                                return (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                        {ms.map((m) => (
                                            <span key={`${m.container}:${m.mount_path}:${m.sub_path}`} style={{ fontFamily: MONO, fontSize: '0.78rem' }}>
                                                <span className="pod-detail__muted">{m.container} → </span>
                                                {m.mount_path}{m.sub_path ? ` (${m.sub_path})` : ''}
                                                {m.read_only && <span className="pod-detail__muted"> · {t('resources:pod.detail.readOnly')}</span>}
                                            </span>
                                        ))}
                                    </div>
                                );
                            }} />
                    </DataTable>
                </Section>
            )}

            {envRefs.length > 0 && (
                <Section title={t('resources:pod.detail.envRefs')}>
                    <DataTable value={envRefs} size="small" className="rlv-subtable">
                        <Column header={t('resources:pod.detail.container')} style={{ width: '12rem' }}
                            body={(e: models.PodEnvRef) => <span style={{ fontFamily: MONO, fontSize: '0.8rem' }}>{e.container}</span>} />
                        <Column header={t('resources:pod.detail.variable')}
                            body={(e: models.PodEnvRef) => e.variable
                                ? <span style={{ fontFamily: MONO, fontSize: '0.8rem' }}>{e.variable}</span>
                                : <span className="pod-detail__muted">{t('resources:pod.detail.allKeys')}{e.prefix ? ` · ${t('resources:pod.detail.prefix', { prefix: e.prefix })}` : ''}</span>} />
                        <Column header={t('resources:pod.detail.source')} body={(e: models.PodEnvRef) => <RefLink r={e.ref} nav={nav} />} />
                        <Column header={t('resources:column.key')}
                            body={(e: models.PodEnvRef) => (
                                <span>
                                    {e.key ? <span style={{ fontFamily: MONO, fontSize: '0.8rem' }}>{e.key}</span> : <span style={{ opacity: 0.5 }}>—</span>}
                                    {e.optional && <span className="pod-detail__muted"> · {t('resources:pod.detail.optional')}</span>}
                                </span>
                            )} />
                    </DataTable>
                </Section>
            )}
        </div>
    );
}
