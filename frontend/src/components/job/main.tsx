import type { DockviewPanelApi } from 'dockview';
import { VscListFlat } from 'react-icons/vsc';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import StatusLamp from '../shared/StatusLamp';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetJobs, DeleteJob } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { useT } from '../../i18n/useT';
import CountCell from '../shared/CountCell';
import RowAction from '../shared/RowAction';

const getStatusSeverity = (status: string): 'success' | 'warning' | 'danger' | 'info' | 'secondary' => {
    switch (status) {
        case 'Succeeded': return 'success';
        case 'Running':   return 'warning';
        case 'Failed':    return 'danger';
        case 'Pending':   return 'secondary';
        default:          return 'info';
    }
};

const getCompletionSeverity = (succeeded: number, completions: number, failed: number): 'success' | 'warning' | 'danger' => {
    if (failed > 0) return 'danger';
    if (succeeded >= completions) return 'success';
    return 'warning';
};

const defaultFilters: DataTableFilterMeta = {
    name:      { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace: { value: null, matchMode: FilterMatchMode.IN },
    status:    { value: null, matchMode: FilterMatchMode.IN },
};

export default function JobListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel, openLogPanel } = useTabContext();
    const referencePanel = `jobs:${clusterName}`;

    return (
        <ResourceListView<models.JobInfo>
            title={t('resources:job.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetJobs}
            createFrom={models.JobInfo.createFrom}
            deleter={DeleteJob}
            deleteLabel="job"
            pollInterval={5000}
            describeResource="jobs"
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:job.empty')}
            onRowDoubleClick={(job) => openYamlPanel({ clusterName, resourceKind: 'job', name: job.name, namespace: job.namespace, referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="status" header={t('resources:column.status')} sortable filter filterField="status" showFilterMenu={false} style={{ minWidth: '9rem' }}
                        body={(row: models.JobInfo) => <StatusLamp label={row.status} severity={getStatusSeverity(row.status)} />}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('status')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column header={t('resources:column.completions')} sortable sortField="succeeded" style={{ minWidth: '10rem' }}
                        body={(row: models.JobInfo) => <CountCell value={`${row.succeeded} / ${row.completions}`} severity={getCompletionSeverity(row.succeeded, row.completions, row.failed)} />} />
                    <Column field="active" header={t('resources:column.active')} sortable style={{ minWidth: '6rem' }} body={(row: models.JobInfo) => row.active} />
                    <Column header="" style={{ width: '4rem', textAlign: 'center' }}
                        body={(row: models.JobInfo) => (
                            <RowAction icon={<VscListFlat size={15} />} label={t('action.logs')}
                                onClick={() => openLogPanel({ clusterName, resourceKind: 'job', name: row.name, namespace: row.namespace, referencePanel })} />
                        )} />
                </>
            )}
        />
    );
}
