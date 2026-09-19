import { useRef, useState } from 'react';
import type { DockviewPanelApi } from 'dockview';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import { Tag } from 'primereact/tag';
import { Button } from 'primereact/button';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { Menu } from 'primereact/menu';
import type { MenuItem, MenuItemOptions } from 'primereact/menuitem';
import { VscTerminal, VscListFlat } from 'react-icons/vsc';
import { GetPods, DeletePod } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { humanAge, absTime } from '../../lib/time';
import { useT } from '../../i18n/useT';

// Waiting reasons that mean "on its way", not "broken". Anything else a
// container waits on (CrashLoopBackOff, ImagePullBackOff, ...) is a fault.
const BENIGN_WAITING = new Set(['', 'ContainerCreating', 'PodInitializing']);

// The backend reports kubectl's STATUS (see services.getPodStatus), so the
// status is a container reason as often as a pod phase.
const getStatusSeverity = (status: string) => {
    if (status === 'Running') return 'success';
    if (status === 'Completed' || status === 'Succeeded') return 'secondary';
    if (status === 'Pending' || status === 'Terminating' || BENIGN_WAITING.has(status)) return 'warning';
    // Init:1/3 is progress; Init:CrashLoopBackOff is not.
    if (/^Init:\d+\/\d+$/.test(status)) return 'warning';
    if (status === 'Unknown') return 'info';
    return 'danger';
};

const getReadySeverity = (ready: number, total: number) => {
    if (total === 0) return 'secondary';
    if (ready === total) return 'success';
    return ready === 0 ? 'danger' : 'warning';
};

const getOwnerSeverity = (kind: string) => {
    switch (kind) {
        case 'Deployment':  return 'info';
        case 'ReplicaSet':  return 'info';
        case 'StatefulSet': return 'warning';
        case 'DaemonSet':   return 'success';
        case 'Job':         return 'secondary';
        case 'CronJob':     return 'secondary';
        default:            return 'contrast'; // bare pod
    }
};

// Per-container status color:
//   green  ready
//   amber  running but not (yet) ready — probe failing or still warming up
//   blue   waiting for a normal reason (ContainerCreating, PodInitializing)
//   grey   finished cleanly (a completed init container or job)
//   red    waiting on a fault (CrashLoopBackOff, ImagePullBackOff, ...) or exited with an error
const containerDotColor = (c: models.ContainerStatusInfo) => {
    if (c.ready) return 'var(--green)';
    if (c.state === 'Terminated') return c.reason === 'Completed' ? 'var(--ink3)' : 'var(--red)';
    if (c.state === 'Running') return 'var(--amber)';
    if (c.state === 'Waiting' && BENIGN_WAITING.has(c.reason)) return 'var(--blue)';
    return 'var(--red)';
};

const MONO = '"JetBrains Mono", "Cascadia Code", monospace';

// Live usage formatting, mirroring the Monitoring dashboard.
// usage < 0 means metrics-server is unavailable.
const fmtCpu = (m: number) => (m < 0 ? '—' : m >= 1000 ? `${(m / 1000).toFixed(2)} cores` : `${m} m`);
const fmtMem = (mi: number) => (mi < 0 ? '—' : mi >= 1024 ? `${(mi / 1024).toFixed(1)} GiB` : `${mi} MiB`);

const defaultFilters: DataTableFilterMeta = {
    name:       { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace:  { value: null, matchMode: FilterMatchMode.IN },
    status:     { value: null, matchMode: FilterMatchMode.IN },
    owner_kind: { value: null, matchMode: FilterMatchMode.IN },
    pod_ip:     { value: null, matchMode: FilterMatchMode.IN },
    node_name:  { value: null, matchMode: FilterMatchMode.IN },
};

// Menu item body for the exec container picker: a glowing status dot (matched from
// the pod's container_statuses, same colour logic as the Containers column), the
// container name in mono, and a right-aligned state label + restart badge.
// `options.onClick` must be wired so the item's `command` still fires with a custom template.
const renderContainerItem = (row: models.PodInfo, name: string, options: MenuItemOptions) => {
    const cs = (row.container_statuses || []).find((c) => !c.init && c.name === name);
    const color = cs ? containerDotColor(cs) : 'var(--ink2)';
    const stateText = cs ? (cs.ready ? 'Ready' : (cs.reason || cs.state || 'Unknown')) : '';
    return (
        <a className={options.className} role="menuitem" onClick={options.onClick}
            style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', width: '100%' }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0, boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 22%, transparent)` }} />
            <span style={{ fontFamily: MONO, fontSize: '12.5px', fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
            {stateText && (
                <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: '10px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--ink3)' }}>{stateText}</span>
            )}
        </a>
    );
};

export default function DataTableComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel, openLogPanel, openExecPanel } = useTabContext();
    const referencePanel = `pods:${clusterName}`;
    const execMenuRef = useRef<Menu>(null);
    const [execMenuItems, setExecMenuItems] = useState<MenuItem[]>([]);

    return (
      <>
        <Menu model={execMenuItems} popup ref={execMenuRef} className="exec-container-menu" />
        <ResourceListView<models.PodInfo>
            title={t('resources:pod.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetPods}
            createFrom={models.PodInfo.createFrom}
            deleter={DeletePod}
            deleteLabel="pod"
            pollInterval={2000}
            describeResource="pods"
            portForward={{ kind: 'pod' }}
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:pod.empty')}
            onRowDoubleClick={(pod) => openYamlPanel({ clusterName, resourceKind: 'pod', name: pod.name, namespace: pod.namespace, referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '13rem', maxWidth: '13rem' }}
                        body={(row: models.PodInfo) => <span title={row.name} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>} />
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '8rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="status" header={t('resources:column.status')} sortable filter filterField="status" showFilterMenu={false} style={{ minWidth: '9rem' }}
                        body={(row: models.PodInfo) => <Tag value={row.status} severity={getStatusSeverity(row.status)} />}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('status')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="ready_count" header={t('resources:column.ready')} sortable style={{ minWidth: '5rem' }}
                        body={(row: models.PodInfo) => (
                            <Tag value={`${row.ready_count}/${row.total_count}`} severity={getReadySeverity(row.ready_count, row.total_count)} />
                        )} />
                    <Column field="owner_kind" header={t('resources:column.owner')} sortable filter filterField="owner_kind" showFilterMenu={false} style={{ minWidth: '7.5rem' }}
                        body={(row: models.PodInfo) => <Tag value={row.owner_kind || 'Pod'} severity={getOwnerSeverity(row.owner_kind)} />}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('owner_kind')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="cpu_millis" header={t('resources:column.cpu')} sortable style={{ minWidth: '5.5rem' }}
                        body={(row: models.PodInfo) => fmtCpu(row.cpu_millis)} />
                    <Column field="mem_mi" header={t('resources:column.memory')} sortable style={{ minWidth: '5.5rem' }}
                        body={(row: models.PodInfo) => fmtMem(row.mem_mi)} />
                    <Column field="pod_ip" header={t('resources:column.podIp')} sortable filter filterField="pod_ip" showFilterMenu={false} style={{ minWidth: '8rem' }}
                        body={(row: models.PodInfo) => <span style={{  fontSize: '0.8rem' }}>{row.pod_ip || '—'}</span>} 
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('pod_ip')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )}
                        />
                    <Column field="node_name" header={t('resources:column.node')} sortable filter filterField="node_name" showFilterMenu={false} style={{ minWidth: '9rem', maxWidth: '12rem' }}
                        body={(row: models.PodInfo) => row.node_name
                            ? <span title={row.node_name} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: MONO, fontSize: '0.8rem' }}>{row.node_name}</span>
                            : <span style={{ opacity: 0.5 }} title={t('resources:pod.notScheduled')}>—</span>}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('node_name')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column header={t('resources:column.containers')} style={{ minWidth: '7rem' }}
                        body={(row: models.PodInfo) => {
                            const cs = row.container_statuses || [];
                            if (cs.length === 0) return <span style={{ opacity: 0.5 }}>—</span>;
                            return (
                                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                                    {cs.map((c) => {
                                        const color = containerDotColor(c);
                                        return (
                                            <span key={(c.init ? 'init:' : '') + c.name}
                                                title={
                                                    // The container name, state and reason come
                                                    // straight from the cluster and stay verbatim;
                                                    // only the frame around them is translated.
                                                    `${c.init ? t('resources:pod.containerInitPrefix') : ''}${c.name}\n` +
                                                    `${c.state || t('resources:pod.containerUnknownState')}` +
                                                    `${c.reason ? ` (${c.reason})` : ''}` +
                                                    ` · ${c.ready ? t('resources:pod.containerReady') : t('resources:pod.containerNotReady')}` +
                                                    `${c.restart_count > 0 ? t('resources:pod.containerRestarts', { count: c.restart_count }) : ''}`
                                                }
                                                style={{
                                                    position: 'relative', flexShrink: 0, display: 'inline-block', width: 12, height: 12,
                                                    // Init containers are squares, regular ones circles.
                                                    borderRadius: c.init ? 3 : '50%',
                                                    background: color,
                                                    boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 22%, transparent)`,
                                                }}>
                                                {/* A container that has restarted gets an amber corner mark
                                                    even while it is currently ready — the restart count is
                                                    the first thing to check when a pod "works but flaps". */}
                                                {c.restart_count > 0 && (
                                                    <span style={{ position: 'absolute', top: -4, right: -4, width: 6, height: 6, borderRadius: '50%', background: 'var(--amber)', boxShadow: '0 0 0 1.5px var(--app)' }} />
                                                )}
                                            </span>
                                        );
                                    })}
                                </div>
                            );
                        }} />
                    <Column field="restarts" header={t('resources:column.restarts')} sortable style={{ minWidth: '5.5rem' }}
                        body={(row: models.PodInfo) => (
                            <span style={{ color: row.restarts > 0 ? 'var(--amber)' : 'inherit', fontWeight: row.restarts > 0 ? 600 : 400 }}>{row.restarts}</span>
                        )} />
                    <Column field="created_at" header={t('resources:column.age')} sortable style={{ minWidth: '5rem' }}
                        body={(row: models.PodInfo) => <span title={absTime(row.created_at)}>{humanAge(row.created_at)}</span>} />
                    <Column field="last_restart_at" header={t('resources:column.lastRestart')} sortable style={{ minWidth: '7.5rem' }}
                        body={(row: models.PodInfo) => (
                            <span title={absTime(row.last_restart_at)}
                                style={{ color: row.last_restart_at ? 'var(--amber)' : undefined, opacity: row.last_restart_at ? 1 : 0.5 }}>
                                {humanAge(row.last_restart_at)}
                            </span>
                        )} />
                    <Column header="" style={{ width: '5rem', textAlign: 'center' }}
                        body={(row: models.PodInfo) => (
                            <div style={{ display: 'flex', gap: '0.2rem', justifyContent: 'center' }}>
                                <Button text size="small" severity="secondary" style={{ padding: '0.2rem' }}
                                    onClick={() => openLogPanel({ clusterName, resourceKind: 'pod', name: row.name, namespace: row.namespace, referencePanel })}>
                                    <VscListFlat size={16} />
                                </Button>
                                <Button text size="small" severity="secondary" style={{ padding: '0.2rem' }}
                                    onClick={(e) => {
                                        const cs = row.containers || [];
                                        if (cs.length <= 1) {
                                            openExecPanel({ clusterName, name: row.name, namespace: row.namespace, container: cs[0] || '', referencePanel });
                                            return;
                                        }
                                        setExecMenuItems([{
                                            label: `Exec into · ${cs.length} containers`,
                                            items: cs.map((name) => ({
                                                label: name,
                                                template: (_item, options) => renderContainerItem(row, name, options),
                                                command: () => openExecPanel({ clusterName, name: row.name, namespace: row.namespace, container: name, referencePanel }),
                                            })),
                                        }]);
                                        execMenuRef.current?.toggle(e);
                                    }}>
                                    <VscTerminal size={16} />
                                </Button>
                            </div>
                        )} />
                </>
            )}
        />
      </>
    );
}
