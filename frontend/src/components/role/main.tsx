import type { DockviewPanelApi } from 'dockview';
import { VscSettings } from 'react-icons/vsc';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetRoles, DeleteRole } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { useT } from '../../i18n/useT';
import RowAction from '../shared/RowAction';

const defaultFilters: DataTableFilterMeta = {
    name:      { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace: { value: null, matchMode: FilterMatchMode.IN },
};

export default function RoleListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel, openRoleEditor } = useTabContext();
    const referencePanel = `roles:${clusterName}`;

    return (
        <ResourceListView<models.RoleInfo>
            title={t('resources:role.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetRoles}
            createFrom={models.RoleInfo.createFrom}
            pollInterval={10000}
            deleter={DeleteRole}
            deleteLabel="role"
            describeResource="roles"
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:role.empty')}
            onRowDoubleClick={(role) => openYamlPanel({ clusterName, resourceKind: 'role', name: role.name, namespace: role.namespace, referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column header={t('resources:column.rules')} body={(r: models.RoleInfo) => (r.rules ?? []).length} style={{ minWidth: '6rem' }} />
                    <Column field="created_at" header={t('resources:column.created')} sortable style={{ minWidth: '12rem' }} />
                    <Column header="" style={{ width: '4rem', textAlign: 'center' }}
                        body={(row: models.RoleInfo) => (
                            <RowAction icon={<VscSettings size={15} />} label={t('action.edit')}
                                onClick={() => openRoleEditor({ clusterName, name: row.name, namespace: row.namespace, referencePanel })} />
                        )} />
                </>
            )}
        />
    );
}
