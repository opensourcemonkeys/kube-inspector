import { useCallback, useEffect, useRef, useState } from 'react';
import type { DockviewPanelApi } from 'dockview';
import { Button } from 'primereact/button';
import { Menu } from 'primereact/menu';
import { ProgressSpinner } from 'primereact/progressspinner';
import type { MenuItem } from 'primereact/menuitem';
import { VscClose, VscEdit, VscListFlat, VscTerminal, VscTrash } from 'react-icons/vsc';
import { DeletePod, GetPodContainerUsage, GetPodDetail } from '../../../../wailsjs/go/controller_app/App';
import { models } from '../../../../wailsjs/go/models';
import { useTabContext } from '../../../contexts/TabContext';
import ErrorBanner from '../../shared/ErrorBanner';
import ConfirmActionDialog from '../../shared/ConfirmActionDialog';
import { errText } from '../../../lib/errText';
import { absTime, humanAge } from '../../../lib/time';
import { usePanelActive } from '../../../lib/usePanelActive';
import { useT } from '../../../i18n/useT';
import { getStatusSeverity } from '../podStatus';
import { Badges, Expandable, Item, Muted, Section } from './DrawerItems';
import { RefLink, RefList, type Nav } from './refs';
import ContainerSection from './ContainerSection';
import UsageChart, { type UsagePoint } from './UsageChart';

// metrics-server samples every ~15s by default; polling faster only re-reads
// the same value, slower makes the chart look frozen.
const POLL_MS = 5000;
// Ten minutes of history at the poll rate.
const MAX_POINTS = 120;

const SEVERITY_COLOR: Record<string, string> = {
    success: 'var(--green)', warning: 'var(--amber)', danger: 'var(--red)', info: 'var(--blue)', secondary: 'var(--ink2)',
};

/** A pod-wide limit exists only when every regular container sets one. */
const podLimit = (containers: models.PodContainerDetail[], pick: (c: models.PodContainerDetail) => number) => {
    const regular = containers.filter((c) => !c.init);
    return regular.length > 0 && regular.every((c) => pick(c) > 0) ? regular.reduce((sum, c) => sum + pick(c), 0) : 0;
};

/**
 * The pod detail panel beside the pod list, after Lens: a usage chart, the
 * pod's properties as a label/value list, then a section per container and
 * the volumes. Every object it names is a link to that object's YAML.
 *
 * The detail and the usage are both re-polled while the list's tab is on
 * screen, so status, conditions and restarts stay live and the chart grows;
 * the parent keys this component by pod, so switching pods starts clean.
 */
export default function PodDetailPanel({ clusterName, name, namespace, referencePanel, api, onClose }: {
    clusterName: string;
    name: string;
    namespace: string;
    referencePanel: string;
    api?: DockviewPanelApi;
    onClose: () => void;
}) {
    const t = useT();
    const { openYamlPanel, openLogPanel, openExecPanel } = useTabContext();
    const nav: Nav = { clusterName, referencePanel };
    const active = usePanelActive(api);
    const execMenuRef = useRef<Menu>(null);
    const [execItems, setExecItems] = useState<MenuItem[]>([]);
    const [confirmDelete, setConfirmDelete] = useState(false);

    const [detail, setDetail] = useState<models.PodDetailInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [usage, setUsage] = useState<Map<string, models.ContainerUsage> | null | undefined>(undefined);
    const [points, setPoints] = useState<UsagePoint[]>([]);

    const loadDetail = useCallback(async () => {
        try {
            setDetail(models.PodDetailInfo.createFrom(await GetPodDetail(clusterName, name, namespace)));
            setError(null);
        } catch (e) {
            // Keep the last good detail on screen; the banner says it is stale.
            setError(errText(e));
        }
    }, [clusterName, name, namespace]);

    const loadUsage = useCallback(async () => {
        try {
            const rows = await GetPodContainerUsage(clusterName, name, namespace);
            const byName = new Map((rows ?? []).map((u) => [u.name, u]));
            setUsage(byName);
            let cpu = 0, mem = 0;
            byName.forEach((u) => { cpu += u.cpuMillis; mem += u.memMi; });
            setPoints((prev) => [...prev, { t: Date.now(), cpu, mem }].slice(-MAX_POINTS));
        } catch {
            // No metrics-server, or no sample for a pod this young.
            setUsage(null);
        }
    }, [clusterName, name, namespace]);

    useEffect(() => {
        if (!active) return;
        loadDetail();
        loadUsage();
        const id = window.setInterval(() => { loadDetail(); loadUsage(); }, POLL_MS);
        return () => window.clearInterval(id);
    }, [active, loadDetail, loadUsage]);

    // Esc closes, unless a dialog or menu above the panel is taking it.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !confirmDelete && !document.querySelector('.p-dialog-mask, .p-menu-overlay')) onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose, confirmDelete]);

    const containers = detail?.containers ?? [];
    const regular = containers.filter((c) => !c.init);
    const init = containers.filter((c) => c.init);

    const openExec = (e: React.MouseEvent) => {
        const names = regular.map((c) => c.name);
        if (names.length <= 1) {
            openExecPanel({ clusterName, name, namespace, container: names[0] || '', referencePanel });
            return;
        }
        setExecItems(names.map((c) => ({ label: c, command: () => openExecPanel({ clusterName, name, namespace, container: c, referencePanel }) })));
        execMenuRef.current?.toggle(e);
    };

    const header = (
        <header className="pd-header">
            <span className="pd-header__title" title={`${namespace}/${name}`}>
                <span className="pd-header__kind">{t('resources:pod.detail.title')}</span> {name}
            </span>
            <div className="pd-header__actions">
                <Button text size="small" severity="secondary" onClick={openExec} tooltip={t('resources:pod.detail.exec')} tooltipOptions={{ position: 'bottom' }} icon={<VscTerminal size={16} />} />
                <Button text size="small" severity="secondary" tooltip={t('resources:pod.detail.logs')} tooltipOptions={{ position: 'bottom' }} icon={<VscListFlat size={16} />}
                    onClick={() => openLogPanel({ clusterName, resourceKind: 'pod', name, namespace, referencePanel })} />
                <Button text size="small" severity="secondary" tooltip={t('resources:pod.detail.edit')} tooltipOptions={{ position: 'bottom' }} icon={<VscEdit size={16} />}
                    onClick={() => openYamlPanel({ clusterName, resourceKind: 'pod', name, namespace, referencePanel })} />
                <Button text size="small" severity="danger" tooltip={t('action.delete')} tooltipOptions={{ position: 'bottom' }} icon={<VscTrash size={16} />}
                    onClick={() => setConfirmDelete(true)} />
                <Button text size="small" severity="secondary" tooltip={t('resources:pod.detail.close')} tooltipOptions={{ position: 'bottom' }} icon={<VscClose size={16} />}
                    onClick={onClose} />
            </div>
        </header>
    );

    let body: React.ReactNode;
    if (!detail) {
        body = error
            ? <div className="pd-body"><ErrorBanner message={error} onRetry={loadDetail} /></div>
            : <div className="pd-body pd-loading"><ProgressSpinner style={{ width: 22, height: 22 }} strokeWidth="6" /> {t('resources:pod.detail.loading')}</div>;
    } else {
        const d = detail;
        const labels = Object.entries(d.labels ?? {}).sort(([a], [b]) => a.localeCompare(b));
        const annotations = Object.entries(d.annotations ?? {}).sort(([a], [b]) => a.localeCompare(b));
        const owners = d.owners ?? [];
        const conditions = d.conditions ?? [];
        const tolerations = d.tolerations ?? [];
        const volumes = d.volumes ?? [];
        const services = d.services ?? [];
        const secrets = d.secrets ?? [];
        const configMaps = d.config_maps ?? [];
        const pvcs = d.persistent_volume_claims ?? [];
        const usageFor = (c: string) => (usage === undefined ? undefined : usage?.get(c) ?? null);

        body = (
            <div className="pd-body">
                {error && <ErrorBanner message={error} onRetry={loadDetail} stale />}
                <UsageChart points={points} unavailable={usage === null}
                    cpuLimit={podLimit(containers, (c) => c.cpu_limit_millis)} memLimit={podLimit(containers, (c) => c.mem_limit_mi)} />

                <div className="pd-list">
                    <Item label={t('resources:pod.detail.created')}>
                        {t('resources:pod.detail.ago', { age: humanAge(d.created_at) })} <Muted>{`(${absTime(d.created_at)})`}</Muted>
                    </Item>
                    <Item label={t('resources:column.name')}>{d.name}</Item>
                    <Item label={t('resources:column.namespace')}>{d.namespace}</Item>
                    {labels.length > 0 && <Item label={t('resources:pod.detail.labels')}><Badges entries={labels} /></Item>}
                    {annotations.length > 0 && <Item label={t('resources:pod.detail.annotations')}><Badges entries={annotations} /></Item>}
                    {owners.length > 0 && (
                        <Item label={t('resources:pod.detail.controlledBy')}>
                            <RefLink r={owners[0]} nav={nav} showKind />
                            {/* The top of the chain is what a user thinks of as the owner. */}
                            {owners.length > 1 && (
                                <span className="pd-paren"><RefLink r={owners[owners.length - 1]} nav={nav} showKind /></span>
                            )}
                        </Item>
                    )}
                    <Item label={t('resources:column.status')}>
                        <span style={{ color: SEVERITY_COLOR[getStatusSeverity(d.status)] }}>{d.status}</span>
                    </Item>
                    {d.node && <Item label={t('resources:column.node')}><RefLink r={d.node} nav={nav} /></Item>}
                    {(d.pod_ips ?? []).length > 0 && <Item label={t('resources:column.podIp')}>{d.pod_ips.join(', ')}</Item>}
                    {d.service_account && <Item label={t('resources:pod.detail.serviceAccount')}><RefLink r={d.service_account} nav={nav} /></Item>}
                    {d.priority_class && <Item label={t('resources:pod.detail.priorityClass')}>{d.priority_class}</Item>}
                    {d.qos_class && <Item label={t('resources:pod.detail.qosClass')}>{d.qos_class}</Item>}
                    {conditions.length > 0 && (
                        <Item label={t('resources:pod.detail.conditions')}>
                            <div className="pd-badges">
                                {conditions.map((c) => (
                                    <span key={c.type} className={`pd-badge pd-badge--static${c.status === 'True' ? '' : ' pd-badge--warn'}`}
                                        title={[c.status, c.reason, c.message].filter(Boolean).join(' · ')}>{c.type}</span>
                                ))}
                            </div>
                        </Item>
                    )}
                    {tolerations.length > 0 && (
                        <Item label={t('resources:pod.detail.tolerations')}>
                            <Expandable count={tolerations.length}>
                                <table className="pd-table">
                                    <thead><tr>
                                        <th>{t('resources:column.key')}</th><th>{t('resources:pod.detail.operator')}</th>
                                        <th>{t('resources:pod.detail.value')}</th><th>{t('resources:pod.detail.effect')}</th><th>{t('resources:pod.detail.seconds')}</th>
                                    </tr></thead>
                                    <tbody>
                                        {tolerations.map((tl, i) => (
                                            <tr key={i}><td>{tl.key}</td><td>{tl.operator}</td><td>{tl.value}</td><td>{tl.effect}</td><td>{tl.seconds}</td></tr>
                                        ))}
                                    </tbody>
                                </table>
                            </Expandable>
                        </Item>
                    )}
                    {d.affinity_count > 0 && (
                        <Item label={t('resources:pod.detail.affinities')}>
                            <Expandable count={d.affinity_count}><pre className="pd-pre">{d.affinity}</pre></Expandable>
                        </Item>
                    )}
                    {services.length > 0 && <Item label={t('resources:pod.detail.services')}><RefList refs={services} nav={nav} /></Item>}
                    {secrets.length > 0 && <Item label={t('resources:pod.detail.secrets')}><RefList refs={secrets} nav={nav} /></Item>}
                    {configMaps.length > 0 && <Item label={t('resources:pod.detail.configMaps')}><RefList refs={configMaps} nav={nav} /></Item>}
                    {pvcs.length > 0 && <Item label={t('resources:pod.detail.pvcs')}><RefList refs={pvcs} nav={nav} /></Item>}
                </div>

                {init.length > 0 && (
                    <Section title={t('resources:pod.detail.initContainers')}>
                        {init.map((c) => <ContainerSection key={c.name} c={c} volumes={volumes} usage={usageFor(c.name)} nav={nav} />)}
                    </Section>
                )}
                <Section title={t('resources:column.containers')}>
                    {regular.map((c) => <ContainerSection key={c.name} c={c} volumes={volumes} usage={usageFor(c.name)} nav={nav} />)}
                </Section>
                {volumes.length > 0 && (
                    <Section title={t('resources:pod.detail.volumes')}>
                        {volumes.map((v) => (
                            <div key={v.name} className="pd-container">
                                <div className="pd-container__title"><span className="pd-container__name">{v.name}</span></div>
                                <Item label={t('resources:column.type')}>{v.type}</Item>
                                {(v.refs ?? []).length > 0 && <Item label={t('resources:pod.detail.source')}><RefList refs={v.refs} nav={nav} /></Item>}
                                {v.detail && <Item label={t('resources:pod.detail.details')}>{v.detail}</Item>}
                            </div>
                        ))}
                    </Section>
                )}
            </div>
        );
    }

    return (
        <div className="pd-panel">
            <Menu model={execItems} popup ref={execMenuRef} />
            {header}
            {body}
            <ConfirmActionDialog
                visible={confirmDelete}
                header={t('resources:delete.header', { kind: 'Pod' })}
                message={<>{t('resources:delete.body', { label: 'pod' })} <strong>{`${namespace}/${name}`}</strong></>}
                confirmLabel={t('action.delete')}
                severity="danger"
                onHide={() => setConfirmDelete(false)}
                onConfirm={async () => {
                    await DeletePod(clusterName, name, namespace);
                    onClose();
                }}
            />
        </div>
    );
}
