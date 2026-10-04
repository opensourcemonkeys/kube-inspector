import React from 'react';
import type { DockviewPanelApi } from 'dockview';
import { DataTable, DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnBodyOptions, ColumnFilterElementTemplateOptions } from 'primereact/column';
import { Tag } from 'primereact/tag';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { GetLimitRanges, DeleteLimitRange } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import ResourceListView from '../shared/ResourceListView';
import { useT } from '../../i18n/useT';
import { humanAge, absTime } from '../../lib/time';

const defaultFilters: DataTableFilterMeta = {
    name:      { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace: { value: null, matchMode: FilterMatchMode.IN },
};

function allKeys(item: models.LimitRangeItemInfo): string[] {
    const keys = new Set<string>();
    for (const m of [item.min, item.max, item.default, item.default_request, item.max_limit_request_ratio]) {
        if (m) Object.keys(m).forEach(k => keys.add(k));
    }
    return Array.from(keys).sort();
}

/** One (limit item, resource) pair: a row of the expanded sub-table. */
interface LimitRow {
    _key: string;
    /**
     * Rowspan group. Carries the item index, not just the type: a spec may
     * list the same type twice, and those must stay two groups.
     */
    _group: string;
    type: string;
    resource: string;
    min?: string;
    max?: string;
    defaultRequest?: string;
    default?: string;
    ratio?: string;
}

function flattenLimits(limits: models.LimitRangeItemInfo[]): LimitRow[] {
    return limits.flatMap((item, i) =>
        allKeys(item).map((resource) => ({
            _key: `${i}/${item.type}/${resource}`,
            _group: `${i}/${item.type}`,
            type: item.type,
            resource,
            min: item.min?.[resource],
            max: item.max?.[resource],
            defaultRequest: item.default_request?.[resource],
            default: item.default?.[resource],
            ratio: item.max_limit_request_ratio?.[resource],
        })),
    );
}

/** Shared body for the value columns: the column's own `field`, or a dim dash. */
const valueBody = (row: LimitRow, { field }: ColumnBodyOptions) =>
    row[field as keyof LimitRow] ?? <span style={{ color: 'var(--ink3)' }}>-</span>;

/**
 * The whole LimitRange spec under an expanded row. Module scope and memoized:
 * an unchanged poll keeps the same `limits` array. Unsortable on purpose —
 * rowspan merges *adjacent* rows, so a sort would split the type groups.
 */
const LimitItemsTable = React.memo(function LimitItemsTable({ limits }: { limits: models.LimitRangeItemInfo[] }) {
    const t = useT();
    return (
        <DataTable value={flattenLimits(limits)} dataKey="_key" size="small" className="rlv-subtable"
            rowGroupMode="rowspan" groupRowsBy="_group">
            <Column field="_group" header={t('resources:column.type')} bodyClassName="rlv-subtable__group" style={{ minWidth: '10rem' }}
                body={(row: LimitRow) => <Tag value={row.type} severity="info" />} />
            <Column field="resource" header={t('resources:column.resource')} style={{ minWidth: '10rem' }} />
            <Column field="min" header={t('panels:limitRange.min')} body={valueBody} style={{ minWidth: '6rem' }} />
            <Column field="max" header={t('panels:limitRange.max')} body={valueBody} style={{ minWidth: '6rem' }} />
            <Column field="defaultRequest" header={t('panels:limitRange.defaultRequest')} body={valueBody} style={{ minWidth: '8rem' }} />
            <Column field="default" header={t('panels:limitRange.defaultLimit')} body={valueBody} style={{ minWidth: '8rem' }} />
            <Column field="ratio" header={t('panels:limitRange.maxRatio')} body={valueBody} style={{ minWidth: '10rem' }} />
        </DataTable>
    );
});

export default function LimitRangeListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel } = useTabContext();
    const referencePanel = `limitranges:${clusterName}`;

    return (
        <ResourceListView<models.LimitRangeInfo>
            title={t('resources:limitrange.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetLimitRanges}
            createFrom={models.LimitRangeInfo.createFrom}
            pollInterval={5000}
            deleter={DeleteLimitRange}
            deleteLabel="limit range"
            describeResource="limitranges"
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:limitrange.empty')}
            onRowDoubleClick={(row) => openYamlPanel({ clusterName, resourceKind: 'limitrange', name: row.name, namespace: row.namespace, referencePanel })}
            rowExpansion={{
                template: (row) => <LimitItemsTable limits={row.limits} />,
                canExpand: (row) => (row.limits?.length ?? 0) > 0,
            }}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterField="namespace" showFilterMenu={false} style={{ minWidth: '10rem' }}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('namespace')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                    <Column header={t('resources:column.types')} style={{ minWidth: '14rem' }}
                        body={(row: models.LimitRangeInfo) => {
                            if (!row.limits || row.limits.length === 0) return '-';
                            return <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>{row.limits.map((l, i) => <Tag key={i} value={l.type} severity="info" />)}</div>;
                        }} />
                    <Column field="created_at" header={t('resources:column.age')} sortable style={{ minWidth: '5rem' }}
                        body={(row: models.LimitRangeInfo) => <span title={absTime(row.created_at)}>{humanAge(row.created_at)}</span>} />
                </>
            )}
        />
    );
}
