import type { DockviewPanelApi } from 'dockview';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import { Tag } from 'primereact/tag';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetIngressClasses, DeleteObject } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { useT } from '../../i18n/useT';

// Cluster-scoped and without a typed delete of its own: addressed
// generically by (group, resource, name) like the CRD view does.
const deleteEntry = (clusterName: string, name: string) =>
    DeleteObject(clusterName, 'networking.k8s.io', 'ingressclasses', '', name);

const defaultFilters: DataTableFilterMeta = {
    name:       { value: null, matchMode: FilterMatchMode.CONTAINS },
    controller: { value: null, matchMode: FilterMatchMode.IN },
};

export default function IngressClassListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel } = useTabContext();
    const referencePanel = `ingressclasses:${clusterName}`;

    return (
        <ResourceListView<models.IngressClassInfo>
            title={t('resources:ingressclass.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetIngressClasses}
            createFrom={models.IngressClassInfo.createFrom}
            pollInterval={5000}
            deleter={deleteEntry}
            deleteLabel="ingress class"
            describeResource="ingressclasses"
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:ingressclass.empty')}
            onRowDoubleClick={(ic) => openYamlPanel({ clusterName, resourceKind: 'ingressclass', name: ic.name, namespace: '', referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="controller" header={t('resources:column.controller')} sortable filter filterField="controller" showFilterMenu={false} style={{ minWidth: '20rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('controller')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="is_default" header={t('resources:column.default')} sortable style={{ minWidth: '8rem' }}
                        body={(row: models.IngressClassInfo) => (row.is_default ? <Tag value="Default" /> : <span className="cell-empty">—</span>)} />
                </>
            )}
        />
    );
}
