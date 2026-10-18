import type { DockviewPanelApi } from 'dockview';
import { VscListFlat } from 'react-icons/vsc';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import StatusLamp from '../shared/StatusLamp';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetStatefulSets, DeleteStatefulSet } from '../../../wailsjs/go/controller_app/App';
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
        case 'Progressing': return 'warning';
        case 'Degraded':    return 'danger';
        default:            return 'secondary';
    }
};

const defaultFilters: DataTableFilterMeta = {
    name:      { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace: { value: null, matchMode: FilterMatchMode.IN },
    status:    { value: null, matchMode: FilterMatchMode.IN },
};

export default function StatefulSetListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel, openLogPanel } = useTabContext();
    const referencePanel = `statefulsets:${clusterName}`;

    return (
        <ResourceListView<models.StatefulSetInfo>
            title={t('resources:statefulset.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetStatefulSets}
            createFrom={models.StatefulSetInfo.createFrom}
            deleter={DeleteStatefulSet}
            deleteLabel="statefulset"
            pollInterval={2000}
            describeResource="statefulsets"
            portForward={{ kind: 'statefulset' }}
            workloadActions={(row) => ({ scale: { kind: 'statefulset', replicas: row.replicas }, restart: { kind: 'statefulset' } })}
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:statefulset.empty')}
            onRowDoubleClick={(s) => openYamlPanel({ clusterName, resourceKind: 'statefulset', name: s.name, namespace: s.namespace, referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="status" header={t('resources:column.status')} sortable filter filterField="status" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        body={(row: models.StatefulSetInfo) => <StatusLamp label={row.status} severity={getStatusSeverity(row.status)} />}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('status')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column header={t('resources:column.replicas')} sortable sortField="replicas" style={{ minWidth: '9rem' }}
                        body={(row: models.StatefulSetInfo) => <CountCell value={`${row.ready_replicas} / ${row.replicas}`} severity={getReplicasSeverity(row.ready_replicas, row.replicas)} />} />
                    <Column header={t('resources:column.updated')} sortable sortField="updated_replicas" style={{ minWidth: '8rem' }}
                        body={(row: models.StatefulSetInfo) => <CountCell value={`${row.current_replicas} current / ${row.updated_replicas} updated`} severity={row.current_replicas === row.updated_replicas ? 'success' : 'warning'} />} />
                    <Column header="" style={{ width: '3rem', textAlign: 'center' }}
                        body={(row: models.StatefulSetInfo) => (
                            <RowAction icon={<VscListFlat size={15} />} label={t('action.logs')}
                                onClick={() => openLogPanel({ clusterName, resourceKind: 'statefulset', name: row.name, namespace: row.namespace, referencePanel })} />
                        )} />
                </>
            )}
        />
    );
}
