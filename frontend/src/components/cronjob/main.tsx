import type { DockviewPanelApi } from 'dockview';
import { VscListFlat } from 'react-icons/vsc';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetCronJobs, DeleteCronJob } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { useT } from '../../i18n/useT';
import StatusLamp from '../shared/StatusLamp';
import RowAction from '../shared/RowAction';

const defaultFilters: DataTableFilterMeta = {
    name:      { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace: { value: null, matchMode: FilterMatchMode.IN },
    schedule:  { value: null, matchMode: FilterMatchMode.IN },
};

export default function CronJobListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel, openLogPanel } = useTabContext();
    const referencePanel = `cronjobs:${clusterName}`;

    return (
        <ResourceListView<models.CronJobInfo>
            title={t('resources:cronjob.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetCronJobs}
            createFrom={models.CronJobInfo.createFrom}
            deleter={DeleteCronJob}
            deleteLabel="cronjob"
            pollInterval={10000}
            describeResource="cronjobs"
            workloadActions={(row) => ({ suspend: { suspended: row.suspend } })}
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:cronjob.empty')}
            onRowDoubleClick={(cj) => openYamlPanel({ clusterName, resourceKind: 'cronjob', name: cj.name, namespace: cj.namespace, referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="schedule" header={t('resources:column.schedule')} sortable filter filterField="schedule" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('schedule')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column header={t('resources:column.status')} sortable sortField="suspend" style={{ minWidth: '8rem' }}
                        body={(row: models.CronJobInfo) => <StatusLamp label={row.suspend ? t('resources:cronjob.stateSuspended') : t('resources:cronjob.stateActive')} tone={row.suspend ? 'idle' : 'ok'} />} />
                    <Column field="active_count" header={t('resources:column.activeJobs')} sortable style={{ minWidth: '8rem' }} body={(row: models.CronJobInfo) => row.active_count} />
                    <Column header="" style={{ width: '3rem', textAlign: 'center' }}
                        body={(row: models.CronJobInfo) => (
                            <RowAction icon={<VscListFlat size={15} />} label={t('action.logs')}
                                onClick={() => openLogPanel({ clusterName, resourceKind: 'cronjob', name: row.name, namespace: row.namespace, referencePanel })} />
                        )} />
                </>
            )}
        />
    );
}
