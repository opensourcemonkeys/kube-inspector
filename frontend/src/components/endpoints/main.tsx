import type { DockviewPanelApi } from 'dockview';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import { MultiSelect } from 'primereact/multiselect';
import { FilterMatchMode } from 'primereact/api';
import { GetEndpoints, DeleteEndpoint } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { ARRAY_IN } from '../../lib/tableFilters';
import { useT } from '../../i18n/useT';
import CountCell from '../shared/CountCell';

const defaultFilters: DataTableFilterMeta = {
    name:       { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace:  { value: null, matchMode: FilterMatchMode.IN },
    // Addresses/Ports are not plain row fields; they are derived from `subsets`,
    // so the filter reads the synthetic arrays on the row (see createFrom).
    _addresses: { value: null, matchMode: ARRAY_IN },
    _ports:     { value: null, matchMode: ARRAY_IN },
};

const addressesOf = (subsets: models.EndpointSubsetInfo[]): string[] => {
    const ips: string[] = [];
    for (const s of subsets ?? []) {
        for (const a of s.addresses ?? []) ips.push(a.ip);
    }
    return ips;
};

const portsOf = (subsets: models.EndpointSubsetInfo[]): string[] => {
    const ports: string[] = [];
    for (const s of subsets ?? []) {
        for (const p of s.ports ?? []) {
            const label = p.name ? `${p.name}:${p.port}/${p.protocol}` : `${p.port}/${p.protocol}`;
            if (!ports.includes(label)) ports.push(label);
        }
    }
    return ports;
};

type EndpointRow = models.EndpointInfo & { _addresses: string[]; _ports: string[] };

const createFrom = (raw: any): EndpointRow => {
    const ep = models.EndpointInfo.createFrom(raw) as EndpointRow;
    ep._addresses = addressesOf(ep.subsets);
    ep._ports = portsOf(ep.subsets);
    return ep;
};

export default function EndpointListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel } = useTabContext();
    const referencePanel = `endpoints:${clusterName}`;

    return (
        <ResourceListView<EndpointRow>
            title={t('resources:endpoints.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetEndpoints}
            createFrom={createFrom}
            pollInterval={2000}
            deleter={DeleteEndpoint}
            deleteLabel="endpoint"
            describeResource="endpoints"
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:endpoints.empty')}
            onRowDoubleClick={(ep) => openYamlPanel({ clusterName, resourceKind: 'endpoint', name: ep.name, namespace: ep.namespace, referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column bodyClassName="cell-mono" header={t('resources:column.addresses')} filter filterField="_addresses" showFilterMenu={false} style={{ minWidth: '18rem' }}
                        body={(row: EndpointRow) => addressesOf(row.subsets).join(', ') || '-'}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('_addresses')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column bodyClassName="cell-mono" header={t('resources:column.ports')} filter filterField="_ports" showFilterMenu={false} style={{ minWidth: '16rem' }}
                        body={(row: EndpointRow) => portsOf(row.subsets).join(', ') || '-'}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('_ports')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="ready" header={t('resources:column.ready')} sortable style={{ minWidth: '7rem' }}
                        body={(row: EndpointRow) => <CountCell value={String(row.ready)} severity={row.ready > 0 ? 'success' : 'secondary'} />} />
                    <Column field="not_ready" header={t('resources:column.notReady')} sortable style={{ minWidth: '7rem' }}
                        body={(row: EndpointRow) => (row.not_ready > 0 ? <CountCell value={String(row.not_ready)} severity="warning" /> : <span className="cell-empty">0</span>)} />
                </>
            )}
        />
    );
}
