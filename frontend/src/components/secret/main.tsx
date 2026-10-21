import type { DockviewPanelApi } from 'dockview';
import { VscSettings } from 'react-icons/vsc';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetSecrets, DeleteSecret } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { useT } from '../../i18n/useT';
import CountCell from '../shared/CountCell';
import RowAction from '../shared/RowAction';

const defaultFilters: DataTableFilterMeta = {
    name:       { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace:  { value: null, matchMode: FilterMatchMode.IN },
    type:       { value: null, matchMode: FilterMatchMode.IN },
    data_count: { value: null, matchMode: FilterMatchMode.EQUALS },
};

export default function SecretListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel, openSecretEditor } = useTabContext();
    const referencePanel = `secrets:${clusterName}`;

    return (
        <ResourceListView<models.SecretInfo>
            title={t('resources:secret.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetSecrets}
            createFrom={models.SecretInfo.createFrom}
            deleter={DeleteSecret}
            deleteLabel="secret"
            impactKind="Secret"
            pollInterval={2000}
            describeResource="secrets"
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:secret.empty')}
            onRowDoubleClick={(s) => openYamlPanel({ clusterName, resourceKind: 'secret', name: s.name, namespace: s.namespace, referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="type" header={t('resources:column.type')} sortable filter filterField="type" showFilterMenu={false} style={{ minWidth: '12rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('type')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="data_count" header={t('resources:column.dataKeys')} sortable filter filterField="data_count" filterPlaceholder={t('resources:column.count')} showFilterMenu={false} dataType="numeric" style={{ minWidth: '8rem' }}
                        body={(row: models.SecretInfo) => <CountCell value={row.data_count} severity={row.data_count > 0 ? 'info' : 'secondary'} />} />
                    <Column header="" style={{ width: '4rem', textAlign: 'center' }}
                        body={(row: models.SecretInfo) => (
                            <RowAction icon={<VscSettings size={15} />} label={t('action.edit')}
                                onClick={() => openSecretEditor({ clusterName, name: row.name, namespace: row.namespace, referencePanel })} />
                        )} />
                </>
            )}
        />
    );
}
