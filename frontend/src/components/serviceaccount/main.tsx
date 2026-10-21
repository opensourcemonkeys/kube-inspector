import type { DockviewPanelApi } from 'dockview';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetServiceAccounts, DeleteServiceAccount } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { useT } from '../../i18n/useT';

const defaultFilters: DataTableFilterMeta = {
    name:      { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace: { value: null, matchMode: FilterMatchMode.IN },
};

export default function ServiceAccountListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel } = useTabContext();
    const referencePanel = `serviceaccounts:${clusterName}`;

    return (
        <ResourceListView<models.ServiceAccountInfo>
            title={t('resources:serviceaccount.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetServiceAccounts}
            createFrom={models.ServiceAccountInfo.createFrom}
            pollInterval={10000}
            deleter={DeleteServiceAccount}
            deleteLabel="service account"
            impactKind="ServiceAccount"
            describeResource="serviceaccounts"
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:serviceaccount.empty')}
            onRowDoubleClick={(sa) => openYamlPanel({ clusterName, resourceKind: 'serviceaccount', name: sa.name, namespace: sa.namespace, referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="secrets" header={t('resources:column.secrets')} sortable style={{ minWidth: '7rem' }} />
                    <Column field="created_at" header={t('resources:column.created')} sortable style={{ minWidth: '12rem' }} />
                </>
            )}
        />
    );
}
