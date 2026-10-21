import type { DockviewPanelApi } from 'dockview';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import StatusLamp from '../shared/StatusLamp';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetPersistentVolumeClaims, DeletePersistentVolumeClaim } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { ARRAY_IN } from '../../lib/tableFilters';
import { useT } from '../../i18n/useT';

type TagSeverity = 'success' | 'info' | 'warning' | 'danger' | 'secondary' | 'contrast';

const getStatusSeverity = (status: string): TagSeverity => {
    switch (status) {
        case 'Bound':   return 'success';
        case 'Pending': return 'warning';
        case 'Lost':    return 'danger';
        default:        return 'secondary';
    }
};

const defaultFilters: DataTableFilterMeta = {
    name:               { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace:          { value: null, matchMode: FilterMatchMode.IN },
    status:             { value: null, matchMode: FilterMatchMode.IN },
    storage_class_name: { value: null, matchMode: FilterMatchMode.IN },
    volume_name:        { value: null, matchMode: FilterMatchMode.IN },
    // access_modes satırda bir dizi; yerleşik IN diziyle eşleşmez.
    access_modes:       { value: null, matchMode: ARRAY_IN },
};

export default function PersistentVolumeClaimListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel } = useTabContext();
    const referencePanel = `persistentvolumeclaims:${clusterName}`;

    return (
        <ResourceListView<models.PersistentVolumeClaimInfo>
            title={t('resources:persistentvolumeclaim.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetPersistentVolumeClaims}
            createFrom={models.PersistentVolumeClaimInfo.createFrom}
            deleter={DeletePersistentVolumeClaim}
            deleteLabel="volume claim"
            impactKind="PersistentVolumeClaim"
            pollInterval={5000}
            describeResource="persistentvolumeclaims"
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:persistentvolumeclaim.empty')}
            onRowDoubleClick={(pvc) => openYamlPanel({ clusterName, resourceKind: 'persistentvolumeclaim', name: pvc.name, namespace: pvc.namespace, referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="status" header={t('resources:column.status')} sortable filter filterField="status" showFilterMenu={false} style={{ minWidth: '8rem' }}
                        body={(row: models.PersistentVolumeClaimInfo) => <StatusLamp label={row.status} severity={getStatusSeverity(row.status)} />}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('status')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="request" header={t('resources:column.request')} sortable style={{ minWidth: '8rem' }} />
                    <Column field="limit" header={t('resources:column.limit')} sortable style={{ minWidth: '8rem' }} />
                    <Column header={t('resources:column.accessModes')} filter filterField="access_modes" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        body={(row: models.PersistentVolumeClaimInfo) => (row.access_modes ?? []).join(', ') || '-'}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('access_modes')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="storage_class_name" header={t('resources:column.storageClass')} sortable filter filterField="storage_class_name" showFilterMenu={false} style={{ minWidth: '12rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('storage_class_name')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="volume_name" header={t('resources:column.volume')} filter filterField="volume_name" showFilterMenu={false} style={{ minWidth: '14rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('volume_name')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                </>
            )}
        />
    );
}
