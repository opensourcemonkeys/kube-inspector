import type { DockviewPanelApi } from 'dockview';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import { Tag } from 'primereact/tag';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetStorageClasses, DeleteObject } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { useT } from '../../i18n/useT';

// Cluster-scoped and without a typed delete of its own: addressed
// generically by (group, resource, name) like the CRD view does.
const deleteEntry = (clusterName: string, name: string) =>
    DeleteObject(clusterName, 'storage.k8s.io', 'storageclasses', '', name);

const defaultFilters: DataTableFilterMeta = {
    name:                { value: null, matchMode: FilterMatchMode.CONTAINS },
    provisioner:         { value: null, matchMode: FilterMatchMode.IN },
    reclaim_policy:      { value: null, matchMode: FilterMatchMode.IN },
    volume_binding_mode: { value: null, matchMode: FilterMatchMode.IN },
};

export default function StorageClassListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel } = useTabContext();
    const referencePanel = `storageclasses:${clusterName}`;

    return (
        <ResourceListView<models.StorageClassInfo>
            title={t('resources:storageclass.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetStorageClasses}
            createFrom={models.StorageClassInfo.createFrom}
            pollInterval={10000}
            deleter={deleteEntry}
            deleteLabel="storage class"
            describeResource="storageclasses"
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:storageclass.empty')}
            onRowDoubleClick={(sc) => openYamlPanel({ clusterName, resourceKind: 'storageclass', name: sc.name, namespace: '', referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '16rem' }} />
                    <Column header={t('resources:column.default')} style={{ minWidth: '7rem' }}
                        body={(row: models.StorageClassInfo) => (row.is_default ? <Tag value="Default" /> : <span className="cell-empty">—</span>)} />
                    <Column field="provisioner" header={t('resources:column.provisioner')} sortable filter filterField="provisioner" showFilterMenu={false} style={{ minWidth: '20rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('provisioner')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="reclaim_policy" header={t('resources:column.reclaimPolicy')} sortable filter filterField="reclaim_policy" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('reclaim_policy')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="volume_binding_mode" header={t('resources:column.bindingMode')} sortable filter filterField="volume_binding_mode" showFilterMenu={false} style={{ minWidth: '12rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('volume_binding_mode')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                </>
            )}
        />
    );
}
