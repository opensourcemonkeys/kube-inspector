import type { DockviewPanelApi } from 'dockview';
import { VscListFlat } from 'react-icons/vsc';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import StatusLamp from '../shared/StatusLamp';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetDaemonSets, DeleteDaemonSet } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { useT } from '../../i18n/useT';
import CountCell from '../shared/CountCell';
import RowAction from '../shared/RowAction';

const getReadySeverity = (ready: number, desired: number): 'success' | 'warning' | 'danger' => {
    if (desired === 0) return 'warning';
    if (ready === desired) return 'success';
    if (ready === 0) return 'danger';
    return 'warning';
};

const getStatusSeverity = (status: string): 'success' | 'warning' | 'danger' | 'secondary' => {
    switch (status) {
        case 'Available':     return 'success';
        case 'Degraded':      return 'danger';
        case 'Not Scheduled': return 'secondary';
        default:              return 'secondary';
    }
};

const defaultFilters: DataTableFilterMeta = {
    name:      { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace: { value: null, matchMode: FilterMatchMode.IN },
    status:    { value: null, matchMode: FilterMatchMode.IN },
};

export default function DaemonSetListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel, openLogPanel } = useTabContext();
    const referencePanel = `daemonsets:${clusterName}`;

    return (
        <ResourceListView<models.DaemonSetInfo>
            title={t('resources:daemonset.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetDaemonSets}
            createFrom={models.DaemonSetInfo.createFrom}
            deleter={DeleteDaemonSet}
            deleteLabel="daemonset"
            impactKind="DaemonSet"
            pollInterval={2000}
            describeResource="daemonsets"
            workloadActions={() => ({ restart: { kind: 'daemonset' } })}
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:daemonset.empty')}
            onRowDoubleClick={(d) => openYamlPanel({ clusterName, resourceKind: 'daemonset', name: d.name, namespace: d.namespace, referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="status" header={t('resources:column.status')} sortable filter filterField="status" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        body={(row: models.DaemonSetInfo) => <StatusLamp label={row.status} severity={getStatusSeverity(row.status)} />}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('status')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column header={t('resources:column.desiredReady')} sortable sortField="desired_number_scheduled" style={{ minWidth: '11rem' }}
                        body={(row: models.DaemonSetInfo) => <CountCell value={`${row.number_ready} / ${row.desired_number_scheduled}`} severity={getReadySeverity(row.number_ready, row.desired_number_scheduled)} />} />
                    <Column header={t('resources:column.currentAvailable')} sortable sortField="current_number_scheduled" style={{ minWidth: '12rem' }}
                        body={(row: models.DaemonSetInfo) => <CountCell value={`${row.current_number_scheduled} current / ${row.number_available} available`} severity={row.number_available === row.desired_number_scheduled ? 'success' : 'warning'} />} />
                    {/* No Scale: a DaemonSet's replica count is the node count, not a
                        settable field — it has no scale subresource. */}
                    <Column header="" style={{ width: '3rem', textAlign: 'center' }}
                        body={(row: models.DaemonSetInfo) => (
                            <RowAction icon={<VscListFlat size={15} />} label={t('action.logs')}
                                onClick={() => openLogPanel({ clusterName, resourceKind: 'daemonset', name: row.name, namespace: row.namespace, referencePanel })} />
                        )} />
                </>
            )}
        />
    );
}
