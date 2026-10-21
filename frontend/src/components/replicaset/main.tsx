import type { DockviewPanelApi } from 'dockview';
import { VscListFlat } from 'react-icons/vsc';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import StatusLamp from '../shared/StatusLamp';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetReplicaSets, DeleteReplicaSet } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { useT } from '../../i18n/useT';
import CountCell from '../shared/CountCell';
import RowAction from '../shared/RowAction';

const getReplicasSeverity = (ready: number, total: number): 'success' | 'warning' | 'danger' => {
    if (total === 0) return 'warning';
    if (ready === total) return 'success';
    if (ready === 0) return 'danger';
    return 'warning';
};

const getStatusSeverity = (status: string): 'success' | 'warning' | 'danger' | 'secondary' => {
    switch (status) {
        case 'Available':   return 'success';
        case 'Degraded':    return 'danger';
        default:            return 'secondary';
    }
};

const defaultFilters: DataTableFilterMeta = {
    name:      { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace: { value: null, matchMode: FilterMatchMode.IN },
    status:    { value: null, matchMode: FilterMatchMode.IN },
};

export default function ReplicaSetListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel, openLogPanel } = useTabContext();
    const referencePanel = `replicasets:${clusterName}`;

    return (
        <ResourceListView<models.ReplicaSetInfo>
            title={t('resources:replicaset.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetReplicaSets}
            createFrom={models.ReplicaSetInfo.createFrom}
            deleter={DeleteReplicaSet}
            deleteLabel="replicaset"
            impactKind="ReplicaSet"
            pollInterval={2000}
            describeResource="replicasets"
            portForward={{ kind: 'replicaset' }}
            workloadActions={(row) => ({ scale: { kind: 'replicaset', replicas: row.replicas } })}
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:replicaset.empty')}
            onRowDoubleClick={(r) => openYamlPanel({ clusterName, resourceKind: 'replicaset', name: r.name, namespace: r.namespace, referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="status" header={t('resources:column.status')} sortable filter filterField="status" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        body={(row: models.ReplicaSetInfo) => <StatusLamp label={row.status} severity={getStatusSeverity(row.status)} />}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('status')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column header={t('resources:column.replicas')} sortable sortField="replicas" style={{ minWidth: '9rem' }}
                        body={(row: models.ReplicaSetInfo) => <CountCell value={`${row.ready_replicas} / ${row.replicas}`} severity={getReplicasSeverity(row.ready_replicas, row.replicas)} />} />
                    <Column header={t('resources:column.available')} sortable sortField="available_replicas" style={{ minWidth: '8rem' }}
                        body={(row: models.ReplicaSetInfo) => <CountCell value={`${row.available_replicas} available`} severity={row.available_replicas > 0 ? 'success' : 'danger'} />} />
                    {/* No Restart: a ReplicaSet has no rollout of its own — restarting is
                        an operation on its owning Deployment. */}
                    <Column header="" style={{ width: '3rem', textAlign: 'center' }}
                        body={(row: models.ReplicaSetInfo) => (
                            <RowAction icon={<VscListFlat size={15} />} label={t('action.logs')}
                                onClick={() => openLogPanel({ clusterName, resourceKind: 'replicaset', name: row.name, namespace: row.namespace, referencePanel })} />
                        )} />
                </>
            )}
        />
    );
}
