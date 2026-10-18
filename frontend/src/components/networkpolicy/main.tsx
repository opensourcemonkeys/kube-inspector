import type { DockviewPanelApi } from 'dockview';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import { Tag } from 'primereact/tag';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetNetworkPolicies, DeleteNetworkPolicy } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { useT } from '../../i18n/useT';
import CountCell from '../shared/CountCell';

const defaultFilters: DataTableFilterMeta = {
    name:      { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace: { value: null, matchMode: FilterMatchMode.IN },
};

const policyTypesBody = (row: models.NetworkPolicyInfo) => {
    const types: string[] = row.policy_types ?? [];
    if (types.length === 0) return <Tag value="None" />;
    return (
        <div className="flex gap-1 flex-wrap">
            {types.map((t) => <Tag key={t} value={t} />)}
        </div>
    );
};

export default function NetworkPolicyListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openPolicyViewer } = useTabContext();
    const referencePanel = `networkpolicies:${clusterName}`;

    return (
        <ResourceListView<models.NetworkPolicyInfo>
            title={t('resources:networkpolicy.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetNetworkPolicies}
            createFrom={models.NetworkPolicyInfo.createFrom}
            deleter={DeleteNetworkPolicy}
            deleteLabel="network policy"
            pollInterval={2000}
            describeResource="networkpolicies"
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:networkpolicy.empty')}
            onRowDoubleClick={(policy) => openPolicyViewer({ clusterName, name: policy.name, namespace: policy.namespace, referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column bodyClassName="cell-mono" field="pod_selector" header={t('resources:column.podSelector')} sortable style={{ minWidth: '12rem' }} />
                    <Column header={t('resources:column.policyTypes')} style={{ minWidth: '12rem' }} body={policyTypesBody} />
                    <Column header={t('resources:column.ingress')} field="ingress_rule_count" sortable dataType="numeric" style={{ width: '6rem', textAlign: 'center' }}
                        body={(row: models.NetworkPolicyInfo) => <CountCell value={String(row.ingress_rule_count)} />} />
                    <Column header={t('resources:column.egress')} field="egress_rule_count" sortable dataType="numeric" style={{ width: '6rem', textAlign: 'center' }}
                        body={(row: models.NetworkPolicyInfo) => <CountCell value={String(row.egress_rule_count)} />} />
                </>
            )}
        />
    );
}
