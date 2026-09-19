import { useEffect, useMemo, useRef, useState } from 'react';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Button } from 'primereact/button';
import { Checkbox } from 'primereact/checkbox';
import { InputText } from 'primereact/inputtext';
import { MultiSelect } from 'primereact/multiselect';
import { Tag } from 'primereact/tag';
import { VscInfo, VscNote, VscRefresh, VscTrash, VscTypeHierarchySub } from 'react-icons/vsc';
import { models } from '../../../wailsjs/go/models';
import { useT } from '../../i18n/useT';
import { ACTION_COLUMN_PROPS } from '../shared/actionColumn';

// Must match the fixed row height enforced by theme-monolith.css
// (.p-datatable-tbody > tr > td { height: 40px }).
const ROW_HEIGHT = 40;

export interface InstanceRow {
    /** Names can repeat across namespaces, so rows are keyed by both. */
    _uid: string;
    name: string;
    namespace: string;
    cells: string[];
}

interface InstanceTableProps {
    crd: models.CRDInfo | null;
    table: models.ResourceTable | null;
    loading: boolean;
    error: string | null;
    onRefresh: () => void;
    onOpenYaml: (row: InstanceRow) => void;
    onDescribe: (row: InstanceRow) => void;
    onDeleteRows: (rows: InstanceRow[]) => void;
    onEditCrd: () => void;
    onDeleteCrd: () => void;
}

/**
 * Right pane of the CRD explorer: the selected kind's instances, rendered with
 * the columns the apiserver itself produced (a CRD's own
 * additionalPrinterColumns), so the table matches `kubectl get <plural>`.
 */
export default function InstanceTable(props: InstanceTableProps) {
    const t = useT();
    const { crd, table, loading, error, onRefresh, onOpenYaml, onDescribe, onDeleteRows, onEditCrd, onDeleteCrd } = props;

    const [nameFilter, setNameFilter] = useState('');
    const [namespaceFilter, setNamespaceFilter] = useState<string[]>([]);
    const [wide, setWide] = useState(false);
    const [selected, setSelected] = useState<InstanceRow[]>([]);

    const namespaced = crd?.scope === 'Namespaced';

    // Switching kinds invalidates every per-kind view choice.
    useEffect(() => {
        setNameFilter('');
        setNamespaceFilter([]);
        setSelected([]);
    }, [crd?.name]);

    const rows = useMemo<InstanceRow[]>(
        () =>
            (table?.rows ?? []).map((r) => ({
                _uid: `${r.namespace}/${r.name}`,
                name: r.name,
                namespace: r.namespace,
                cells: r.cells ?? [],
            })),
        [table],
    );

    const namespaceOptions = useMemo(
        () =>
            Array.from(new Set(rows.map((r) => r.namespace).filter(Boolean)))
                .sort()
                .map((ns) => ({ label: ns, value: ns })),
        [rows],
    );

    const visibleRows = useMemo(() => {
        const needle = nameFilter.trim().toLowerCase();
        return rows.filter(
            (r) =>
                (!needle || r.name.toLowerCase().includes(needle)) &&
                (namespaceFilter.length === 0 || namespaceFilter.includes(r.namespace)),
        );
    }, [rows, nameFilter, namespaceFilter]);

    const hasWideColumns = useMemo(
        () => (table?.columns ?? []).some((c) => (c.priority ?? 0) > 0),
        [table],
    );

    // Columns come from the data, so they are described here rather than
    // declared as JSX and mapped at render time.
    const displayColumns = useMemo(() => {
        const cols = (table?.columns ?? [])
            .map((c, index) => ({ c, index }))
            .filter(({ c }) => wide || (c.priority ?? 0) === 0)
            .map(({ c, index }) => ({
                key: `cell-${index}`,
                header: c.name,
                // Kept tight so the common case (a handful of printer columns
                // plus the action buttons) fits the pane without horizontal
                // scrolling. Column-heavy CRDs still scroll, exactly as
                // `kubectl get` wraps them.
                minWidth: index === 0 ? '12rem' : '8rem',
                render: (row: InstanceRow) => row.cells[index] ?? '',
            }));

        // A cross-namespace listing carries no NAMESPACE column — kubectl adds
        // it client-side too — so it is injected right after the name column.
        if (namespaced) {
            cols.splice(Math.min(1, cols.length), 0, {
                key: 'namespace',
                header: 'Namespace',
                minWidth: '10rem',
                render: (row: InstanceRow) => row.namespace,
            });
        }
        return cols;
    }, [table, wide, namespaced]);

    // PrimeReact's VirtualScroller reads its viewport height once at init() and
    // only re-measures on *window* resize. Inside a Splitter the height changes
    // on gutter drags instead, so an explicit measured pixel height plus a
    // ResizeObserver is what keeps rows from vanishing. Same pattern as
    // ResourceListView.
    const tableWrapRef = useRef<HTMLDivElement>(null);
    const [scrollHeight, setScrollHeight] = useState<string>('flex');
    useEffect(() => {
        const el = tableWrapRef.current;
        if (!el) return;
        let last = -1;
        const observer = new ResizeObserver((entries) => {
            const height = Math.round(entries[0]?.contentRect.height ?? 0);
            // Ignore 0 (tab backgrounded/hidden) so we keep the last good height.
            if (height === 0 || height === last) return;
            last = height;
            setScrollHeight(`${height}px`);
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    if (!crd) {
        return (
            <div className="crd-detail crd-detail--empty">
                <VscTypeHierarchySub size={28} />
                <p>{t('panels:crd.selectKind')}</p>
            </div>
        );
    }

    const qualified = `${crd.plural}${crd.group ? '.' + crd.group : ''}`;

    return (
        <div className="crd-detail">
            <div className="crd-detail__header">
                <h3>{crd.kind}</h3>
                <code className="crd-detail__qualified">{qualified}</code>
                <Tag value={crd.scope} severity={namespaced ? 'info' : 'warning'} style={{ fontSize: '0.68rem' }} />
                <Tag value={crd.version} style={{ fontSize: '0.68rem' }} />
                <div className="crd-detail__header-actions">
                    <Button label={t('panels:crd.crdYaml')} icon={<VscNote size={15} />} text size="small" severity="secondary" onClick={onEditCrd} />
                    <Button
                        label={t('panels:crd.deleteCrd')}
                        icon={<VscTrash size={15} />}
                        text
                        size="small"
                        severity="danger"
                        onClick={onDeleteCrd}
                        tooltip={t('panels:crd.deleteCrdTooltip')}
                        tooltipOptions={{ position: 'left' }}
                    />
                </div>
            </div>

            <div className="crd-detail__toolbar">
                <InputText
                    value={nameFilter}
                    onChange={(e) => setNameFilter(e.target.value)}
                    placeholder={t('panels:crd.filterByName')}
                    className="p-inputtext-sm"
                    style={{ width: '14rem' }}
                />
                {namespaced && (
                    <MultiSelect
                        value={namespaceFilter}
                        options={namespaceOptions}
                        onChange={(e) => setNamespaceFilter(e.value ?? [])}
                        placeholder={t('panels:crd.allNamespaces')}
                        filter
                        maxSelectedLabels={1}
                        className="p-inputtext-sm"
                        style={{ minWidth: '12rem' }}
                    />
                )}
                {hasWideColumns && (
                    <label className="crd-checkbox" title={t('panels:crd.wideTooltip')}>
                        <Checkbox inputId="crd-wide" checked={wide} onChange={(e) => setWide(!!e.checked)} />
                        <span>{t('panels:crd.wide')}</span>
                    </label>
                )}
                <Tag
                    value={visibleRows.length === rows.length ? `${rows.length}` : `${visibleRows.length} / ${rows.length}`}
                    severity="info"
                    style={{ fontSize: '0.68rem' }}
                />
                <div className="crd-detail__toolbar-actions">
                    <Button
                        label={t('action.deleteSelected')}
                        icon={<VscTrash size={15} />}
                        size="small"
                        severity="danger"
                        disabled={selected.length === 0}
                        onClick={() => onDeleteRows(selected)}
                    />
                    <Button
                        icon={<VscRefresh size={15} />}
                        text
                        size="small"
                        severity="secondary"
                        loading={loading}
                        onClick={onRefresh}
                        tooltip={t('panels:crd.refreshInstances')}
                        tooltipOptions={{ position: 'left' }}
                    />
                </div>
            </div>

            {error && <div className="crd-detail__error">{t('panels:crd.listFailed', { kind: crd.kind, error })}</div>}

            <div
                ref={tableWrapRef}
                className="ktable-fill"
                style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            >
                <DataTable
                    // Re-initialises the virtual scroller once a measured height
                    // is available, and again per kind so a new column set never
                    // renders against the previous dataset's scroll state.
                    key={`${crd.name}:${scrollHeight === 'flex' ? 'measuring' : 'measured'}`}
                    value={visibleRows}
                    dataKey="_uid"
                    selectionMode="multiple"
                    selection={selected}
                    onSelectionChange={(e: any) => setSelected(Array.isArray(e.value) ? e.value : [])}
                    onRowDoubleClick={(e: any) => onOpenYaml(e.data as InstanceRow)}
                    stripedRows
                    showGridlines
                    resizableColumns
                    scrollable
                    scrollHeight={scrollHeight}
                    virtualScrollerOptions={{ itemSize: ROW_HEIGHT }}
                    emptyMessage={loading ? t('panels:crd.instancesLoading') : t('panels:crd.noInstances', { kind: crd.kind })}
                >
                    <Column selectionMode="multiple" headerStyle={{ width: '3rem' }} style={{ minWidth: '3rem', maxWidth: '3rem' }} />
                    {displayColumns.map((col) => (
                        <Column key={col.key} header={col.header} style={{ minWidth: col.minWidth }} body={col.render} />
                    ))}
                    <Column
                        header=""
                        {...ACTION_COLUMN_PROPS}
                        style={{ width: '9.5rem' }}
                        body={(row: InstanceRow) => (
                            <div style={{ display: 'flex', gap: '0.25rem', justifyContent: 'flex-end' }}>
                                <Button
                                    icon={<VscInfo size={16} />}
                                    text
                                    size="small"
                                    severity="secondary"
                                    onClick={() => onDescribe(row)}
                                    tooltip={t('action.describe')}
                                    tooltipOptions={{ position: 'top' }}
                                />
                                <Button
                                    icon={<VscNote size={16} />}
                                    text
                                    size="small"
                                    severity="secondary"
                                    onClick={() => onOpenYaml(row)}
                                    tooltip={t('panels:crd.editYaml')}
                                    tooltipOptions={{ position: 'top' }}
                                />
                                <Button
                                    icon={<VscTrash size={16} />}
                                    text
                                    size="small"
                                    severity="danger"
                                    onClick={() => onDeleteRows([row])}
                                    tooltip={t('action.delete')}
                                    tooltipOptions={{ position: 'top' }}
                                />
                            </div>
                        )}
                    />
                </DataTable>
            </div>
        </div>
    );
}
