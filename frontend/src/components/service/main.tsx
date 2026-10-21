import type { DockviewPanelApi } from 'dockview';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import StatusLamp from '../shared/StatusLamp';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetServices, DeleteService } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { ARRAY_IN } from '../../lib/tableFilters';
import { useT } from '../../i18n/useT';

type TagSeverity = 'success' | 'info' | 'warning' | 'danger' | 'secondary' | 'contrast';

const getStatusSeverity = (status: string): TagSeverity =>
    status === 'Active' ? 'success' : 'warning';

const formatPorts = (ports: models.ServicePortInfo[]): string => {
    if (!ports || ports.length === 0) return '-';
    return ports
        .map(p => p.node_port ? `${p.port}:${p.node_port}/${p.protocol}` : `${p.port}/${p.protocol}`)
        .join(', ');
};

const formatExternalIPs = (ips: string[]): string => {
    if (!ips || ips.length === 0) return '-';
    return ips.join(', ');
};

const defaultFilters: DataTableFilterMeta = {
    name:         { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace:    { value: null, matchMode: FilterMatchMode.IN },
    type:         { value: null, matchMode: FilterMatchMode.IN },
    cluster_ip:   { value: null, matchMode: FilterMatchMode.IN },
    // external_ips satırda bir dizi; yerleşik IN diziyle eşleşmez.
    external_ips: { value: null, matchMode: ARRAY_IN },
};

export default function ServiceListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel } = useTabContext();
    const referencePanel = `services:${clusterName}`;

    return (
        <ResourceListView<models.ServiceInfo>
            title={t('resources:service.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetServices}
            createFrom={models.ServiceInfo.createFrom}
            deleter={DeleteService}
            deleteLabel="service"
            impactKind="Service"
            pollInterval={2000}
            describeResource="services"
            portForward={{ kind: 'service' }}
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:service.empty')}
            onRowDoubleClick={(svc) => openYamlPanel({ clusterName, resourceKind: 'service', name: svc.name, namespace: svc.namespace, referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="status" header={t('resources:column.status')} sortable style={{ minWidth: '7rem' }}
                        body={(row: models.ServiceInfo) => <StatusLamp label={row.status} severity={getStatusSeverity(row.status)} />} />
                    <Column field="type" header={t('resources:column.type')} sortable filter filterField="type" showFilterMenu={false} style={{ minWidth: '9rem' }}
                        body={(row: models.ServiceInfo) => row.type}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('type')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column bodyClassName="cell-mono" field="cluster_ip" header={t('resources:column.clusterIp')} sortable filter filterField="cluster_ip" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('cluster_ip')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column bodyClassName="cell-mono" field="external_ips" header={t('resources:column.externalIp')} filter filterField="external_ips" showFilterMenu={false} style={{ minWidth: '12rem' }}
                        body={(row: models.ServiceInfo) => formatExternalIPs(row.external_ips)}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('external_ips')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column bodyClassName="cell-mono" header={t('resources:column.ports')} style={{ minWidth: '14rem' }} body={(row: models.ServiceInfo) => formatPorts(row.ports)} />
                </>
            )}
        />
    );
}
