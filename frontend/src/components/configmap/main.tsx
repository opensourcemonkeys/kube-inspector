import type { DockviewPanelApi } from 'dockview';
import { VscSettings } from 'react-icons/vsc';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetConfigMaps, DeleteConfigMap } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { useT } from '../../i18n/useT';
import CountCell from '../shared/CountCell';
import RowAction from '../shared/RowAction';

const defaultFilters: DataTableFilterMeta = {
    name:       { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace:  { value: null, matchMode: FilterMatchMode.IN },
    data_count: { value: null, matchMode: FilterMatchMode.EQUALS },
};

type ConfigMapRow = models.ConfigMapInfo & { _uid: string };

const createFrom = (raw: any): ConfigMapRow => {
    const cm = models.ConfigMapInfo.createFrom(raw) as ConfigMapRow;
    cm._uid = `${cm.namespace}/${cm.name}`;
    return cm;
};

export default function ConfigMapListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel, openConfigMapEditor } = useTabContext();
    const referencePanel = `configmaps:${clusterName}`;

    return (
        <ResourceListView<ConfigMapRow>
            title={t('resources:configmap.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetConfigMaps}
            createFrom={createFrom}
            deleter={DeleteConfigMap}
            deleteLabel="configmap"
            impactKind="ConfigMap"
            dataKey="_uid"
            pollInterval={2000}
            describeResource="configmaps"
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:configmap.empty')}
            onRowDoubleClick={(cm) => openYamlPanel({ clusterName, resourceKind: 'configmap', name: cm.name, namespace: cm.namespace, referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="data_count" header={t('resources:column.dataKeys')} sortable filter filterField="data_count" filterPlaceholder={t('resources:filter.count')} showFilterMenu={false} dataType="numeric" style={{ minWidth: '8rem' }}
                        body={(row: models.ConfigMapInfo) => <CountCell value={row.data_count} severity={row.data_count > 0 ? 'info' : 'secondary'} />} />
                    <Column header="" style={{ width: '4rem', textAlign: 'center' }}
                        body={(row: models.ConfigMapInfo) => (
                            <RowAction icon={<VscSettings size={15} />} label={t('action.edit')}
                                onClick={() => openConfigMapEditor({ clusterName, name: row.name, namespace: row.namespace, referencePanel })} />
                        )} />
                </>
            )}
        />
    );
}
