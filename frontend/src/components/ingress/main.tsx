import type { DockviewPanelApi } from 'dockview';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetIngresses, DeleteIngress } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { ARRAY_IN } from '../../lib/tableFilters';
import { useT } from '../../i18n/useT';

const defaultFilters: DataTableFilterMeta = {
    name:       { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace:  { value: null, matchMode: FilterMatchMode.IN },
    class_name: { value: null, matchMode: FilterMatchMode.IN },
    address:    { value: null, matchMode: FilterMatchMode.IN },
    // Hosts/Paths are not plain row fields; they are derived from `rules`, so
    // the filter reads the synthetic arrays on the row (see createFrom).
    _hosts:     { value: null, matchMode: ARRAY_IN },
    _paths:     { value: null, matchMode: ARRAY_IN },
};

const hostsOf = (rules: models.IngressRuleInfo[]): string[] => {
    if (!rules || rules.length === 0) return ['*'];
    return rules.map(r => r.host || '*');
};

/** Host-prefixed path labels as shown in the cell (`example.com/api`). */
const pathLabelsOf = (rules: models.IngressRuleInfo[]): string[] => {
    const labels: string[] = [];
    for (const r of rules ?? []) {
        for (const p of r.paths ?? []) labels.push(r.host ? `${r.host}${p}` : p);
    }
    return labels;
};

/**
 * Filter options are the raw paths (`/api`), without the host prefix: that
 * keeps the dropdown short and actually groupable, and filtering by host
 * already has its own Hosts filter.
 */
const pathsOf = (rules: models.IngressRuleInfo[]): string[] => {
    const paths: string[] = [];
    for (const r of rules ?? []) {
        for (const p of r.paths ?? []) if (!paths.includes(p)) paths.push(p);
    }
    return paths;
};

type IngressRow = models.IngressInfo & { _hosts: string[]; _paths: string[] };

const createFrom = (raw: any): IngressRow => {
    const ing = models.IngressInfo.createFrom(raw) as IngressRow;
    ing._hosts = hostsOf(ing.rules);
    ing._paths = pathsOf(ing.rules);
    return ing;
};

export default function IngressListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel } = useTabContext();
    const referencePanel = `ingresses:${clusterName}`;

    return (
        <ResourceListView<IngressRow>
            title={t('resources:ingress.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetIngresses}
            createFrom={createFrom}
            deleter={DeleteIngress}
            deleteLabel="ingress"
            impactKind="Ingress"
            pollInterval={2000}
            describeResource="ingresses"
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:ingress.empty')}
            onRowDoubleClick={(ing) => openYamlPanel({ clusterName, resourceKind: 'ingress', name: ing.name, namespace: ing.namespace, referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="class_name" header={t('resources:column.class')} sortable filter filterField="class_name" showFilterMenu={false} style={{ minWidth: '9rem' }}
                        body={(row: IngressRow) => row.class_name || '-'}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('class_name')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column header={t('resources:column.hosts')} filter filterField="_hosts" showFilterMenu={false} style={{ minWidth: '16rem' }}
                        body={(row: IngressRow) => hostsOf(row.rules).join(', ')}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('_hosts')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column header={t('resources:column.paths')} filter filterField="_paths" showFilterMenu={false} style={{ minWidth: '18rem' }}
                        body={(row: IngressRow) => pathLabelsOf(row.rules).join(', ') || '-'}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('_paths')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column bodyClassName="cell-mono" field="address" header={t('resources:column.address')} sortable filter filterField="address" showFilterMenu={false} style={{ minWidth: '12rem' }}
                        body={(row: IngressRow) => row.address || '-'}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('address')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="tls" header={t('resources:column.tls')} sortable style={{ minWidth: '6rem' }}
                        body={(row: IngressRow) => (row.tls ? t('value.yes') : t('value.no'))} />
                </>
            )}
        />
    );
}
