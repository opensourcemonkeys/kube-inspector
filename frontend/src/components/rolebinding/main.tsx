import type { DockviewPanelApi } from 'dockview';
import { VscSettings } from 'react-icons/vsc';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetRoleBindings, DeleteRoleBinding } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { useT } from '../../i18n/useT';
import RowAction from '../shared/RowAction';

const defaultFilters: DataTableFilterMeta = {
    name:      { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace: { value: null, matchMode: FilterMatchMode.IN },
    // RoleRef iki alandan türetiliyor; filtre hücrede gösterilenin aynısı olan
    // sentetik skaler alana bakar (bkz. createFrom).
    _role_ref: { value: null, matchMode: FilterMatchMode.IN },
};

type RoleBindingRow = models.RoleBindingInfo & { _role_ref: string };

const createFrom = (raw: any): RoleBindingRow => {
    const rb = models.RoleBindingInfo.createFrom(raw) as RoleBindingRow;
    rb._role_ref = `${rb.role_ref_kind}/${rb.role_ref_name}`;
    return rb;
};

export default function RoleBindingListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel, openRoleBindingEditor } = useTabContext();
    const referencePanel = `rolebindings:${clusterName}`;

    return (
        <ResourceListView<RoleBindingRow>
            title={t('resources:rolebinding.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetRoleBindings}
            createFrom={createFrom}
            pollInterval={10000}
            deleter={DeleteRoleBinding}
            deleteLabel="role binding"
            describeResource="rolebindings"
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:rolebinding.empty')}
            onRowDoubleClick={(rb) => openYamlPanel({ clusterName, resourceKind: 'rolebinding', name: rb.name, namespace: rb.namespace, referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column header={t('resources:column.roleref')} filter filterField="_role_ref" showFilterMenu={false} style={{ minWidth: '12rem' }}
                        body={(rb: RoleBindingRow) => <span>{rb._role_ref}</span>}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('_role_ref')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column header={t('resources:column.subjects')} style={{ minWidth: '7rem' }} body={(rb: RoleBindingRow) => (rb.subjects ?? []).length} />
                    <Column field="created_at" header={t('resources:column.created')} sortable style={{ minWidth: '12rem' }} />
                    <Column header="" style={{ width: '4rem', textAlign: 'center' }}
                        body={(row: RoleBindingRow) => (
                            <RowAction icon={<VscSettings size={15} />} label={t('action.edit')}
                                onClick={() => openRoleBindingEditor({ clusterName, name: row.name, namespace: row.namespace, referencePanel })} />
                        )} />
                </>
            )}
        />
    );
}
