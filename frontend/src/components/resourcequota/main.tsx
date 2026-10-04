import React from 'react';
import type { DockviewPanelApi } from 'dockview';
import { DataTable, DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import { Tag } from 'primereact/tag';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetResourceQuotas } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { useT } from '../../i18n/useT';
import { CssBar, getUsageColor } from '../../lib/usage';

const defaultFilters: DataTableFilterMeta = {
    name:      { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace: { value: null, matchMode: FilterMatchMode.IN },
};

/** An entry plus its usage percentage, so the sub-table can sort on it. */
type EntryRow = models.ResourceQuotaEntry & { pct: number | null };

/**
 * Unclamped, unlike `lib/usage.pct`: a quota lowered below current usage
 * reads 150%, and the status tag needs to see that. The bar clamps on its own.
 * `null` for a zero hard limit, where a percentage means nothing.
 */
const entryPct = (e: models.ResourceQuotaEntry) => (e.hard_num > 0 ? (e.used_num / e.hard_num) * 100 : null);

/** Same thresholds as `getUsageColor`, so the tag and the bar never disagree. */
function StatusTag({ p }: { p: number | null }) {
    const t = useT();
    if (p === null) return <span style={{ color: 'var(--ink3)' }}>—</span>;
    const [key, severity] =
        p >= 100 ? (['full', 'danger'] as const)
        : p >= 80 ? (['critical', 'danger'] as const)
        : p >= 60 ? (['warning', 'warning'] as const)
        : (['ok', 'success'] as const);
    return <Tag value={t(`resources:resourcequota.status.${key}`)} severity={severity} />;
}

/**
 * One quota's tracked resources, rendered under its expanded row. Module scope
 * and memoized: an unchanged poll keeps the same `entries` array, so an
 * expanded quota does not rebuild its sub-table every 10 seconds.
 */
const QuotaEntriesTable = React.memo(function QuotaEntriesTable({ entries }: { entries: models.ResourceQuotaEntry[] }) {
    const t = useT();
    const rows: EntryRow[] = entries.map((e) => ({ ...e, pct: entryPct(e) }));
    return (
        <DataTable value={rows} dataKey="resource" size="small" className="rlv-subtable" sortField="resource" sortOrder={1}>
            <Column field="resource" header={t('resources:column.resource')} sortable style={{ minWidth: '12rem' }} />
            <Column field="used" header={t('resources:column.used')} style={{ minWidth: '6rem' }} />
            <Column field="hard" header={t('resources:column.hard')} style={{ minWidth: '6rem' }} />
            <Column field="remaining" header={t('resources:column.remaining')} style={{ minWidth: '6rem' }}
                body={(e: EntryRow) => (
                    <span style={e.remaining.startsWith('-') ? { color: 'var(--red)', fontWeight: 600 } : undefined}>{e.remaining}</span>
                )} />
            <Column field="pct" header={t('resources:column.usage')} sortable style={{ minWidth: '14rem' }}
                body={(e: EntryRow) => {
                    if (e.pct === null) return <span style={{ color: 'var(--ink3)' }}>—</span>;
                    const shown = Math.min(e.pct, 100);
                    return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                            <CssBar p={shown} />
                            <span style={{ width: '3rem', textAlign: 'right', fontWeight: 700, color: getUsageColor(shown) }}>
                                {e.pct.toFixed(0)}%
                            </span>
                        </div>
                    );
                }} />
            <Column header={t('resources:column.status')} style={{ minWidth: '7rem' }}
                body={(e: EntryRow) => <StatusTag p={e.pct} />} />
        </DataTable>
    );
});

export default function ResourceQuotaListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel } = useTabContext();
    const referencePanel = `resourcequotas:${clusterName}`;

    return (
        <ResourceListView<models.NamespacedResourceQuota>
            title={t('resources:resourcequota.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetResourceQuotas}
            createFrom={models.NamespacedResourceQuota.createFrom}
            pollInterval={10000}
            describeResource="resourcequotas"
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:resourcequota.empty')}
            onRowDoubleClick={(row) => openYamlPanel({ clusterName, resourceKind: 'resourcequota', name: row.name, namespace: row.namespace, referencePanel })}
            rowExpansion={{
                template: (row) => <QuotaEntriesTable entries={row.entries} />,
                canExpand: (row) => (row.entries?.length ?? 0) > 0,
            }}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '12rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '16rem' }} />
                </>
            )}
        />
    );
}
