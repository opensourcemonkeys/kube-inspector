import React, { useLayoutEffect, useRef, useState } from 'react';
import type { DockviewPanelApi } from 'dockview';
import { VscClearAll, VscTrash, VscClose } from 'react-icons/vsc';
import { DataTable, DataTableFilterMeta } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { Toast } from 'primereact/toast';
import { ProgressSpinner } from 'primereact/progressspinner';
import { Menu } from 'primereact/menu';
import type { MenuItem } from 'primereact/menuitem';
import { VscInfo, VscArrowSwap, VscKebabVertical } from 'react-icons/vsc';
import { useResourceList, ResourceRow } from '../../lib/useResourceList';
import { useT } from '../../i18n/useT';
import { useTabContext } from '../../contexts/TabContext';
import ErrorBanner from './ErrorBanner';
import PortForwardDialog, { type ForwardableKind } from './PortForwardDialog';
import { useWorkloadActions, type WorkloadActionSpec } from './WorkloadActions';
import { ACTION_COLUMN_PROPS } from './actionColumn';

type CellRenderer = (row: any, options: any) => React.ReactNode;

/** One view-declared action column, reduced to what the merged column needs. */
interface ActionCell {
    body: CellRenderer | React.ReactNode;
    widthRem: number;
}

// PrimeReact cell padding is 12px per side (theme-monolith.css). Each view's
// action-column width already includes it, so merging N columns into one cell
// must count it once, not N times.
const CELL_PADDING_REM = 1.5;
const KEBAB_WIDTH_REM = 2.5;

const remOf = (style: React.CSSProperties | undefined): number => {
    const raw = style?.width ?? style?.minWidth;
    const m = typeof raw === 'string' ? /^([\d.]+)rem$/.exec(raw) : null;
    return m ? parseFloat(m[1]) : 3; // a one-button column, padding included
};

// Action columns (the control-button column) are declared with an empty
// header and carry no `field`.
const isActionColumn = (node: React.ReactNode) => {
    if (!React.isValidElement(node)) return false;
    const p = node.props as { header?: React.ReactNode; field?: string; selectionMode?: string };
    return (p.header === '' || p.header == null) && !p.field && !p.selectionMode;
};

// PrimeReact's DataTable finds its columns via React.Children.toArray(children),
// which flattens arrays but NOT Fragments. The `columns` render-prop returns a
// single <>…</> Fragment, so we must unwrap it into a keyed array here — otherwise
// the data columns are invisible and the table renders empty.
//
// The view's own action columns (logs, exec, …) are pulled *out* of the data
// columns so the caller can merge them with the built-in ⋮ menu into one
// right-frozen column: a sticky column has to be a single column, or the two
// halves of a row's actions would pin at different offsets and scroll apart.
function splitColumns(node: React.ReactNode): { data: React.ReactNode[]; actions: ActionCell[] } {
    const unwrapped =
        React.isValidElement(node) && node.type === React.Fragment
            ? (node as React.ReactElement<{ children?: React.ReactNode }>).props.children
            : node;
    const data: React.ReactNode[] = [];
    const actions: ActionCell[] = [];
    React.Children.toArray(unwrapped).forEach((child) => {
        if (isActionColumn(child)) {
            const p = (child as React.ReactElement<{ body?: CellRenderer; style?: React.CSSProperties }>).props;
            if (p.body) actions.push({ body: p.body, widthRem: remOf(p.style) });
        } else {
            data.push(child);
        }
    });
    return { data, actions };
}

// The action column has a fixed width and must not be user-resizable. In
// PrimeReact's default "fit" resize mode it is the last column (no resizer of
// its own), but dragging the column *before* it steals width from it — so the
// left neighbour is tagged too and both resize handles are hidden via theme CSS.
function tagLastForActions(data: React.ReactNode[]): React.ReactNode[] {
    const last = data.length - 1;
    return data.map((child, i) => {
        if (i !== last || !React.isValidElement(child)) return child;
        const props = child.props as { headerClassName?: string };
        return React.cloneElement(child as React.ReactElement<any>, {
            headerClassName: [props.headerClassName, 'ktable-actions-col'].filter(Boolean).join(' '),
        });
    });
}

// Must match the fixed row height enforced by theme-monolith.css
// (.p-datatable-tbody > tr > td { height: 40px }).
const ROW_HEIGHT = 40;

export interface ColumnsContext<T extends ResourceRow> {
    items: T[];
    /**
     * Unique IN-filter options ({label,value}) for a given row field.
     * Array-valued fields are flattened (pair them with `ARRAY_IN`).
     */
    buildInOptions: (field: keyof T) => { label: string; value: string }[];
    /**
     * Refetches the list. Row actions that mutate the object (scale, restart,
     * suspend) call this so the change shows immediately instead of waiting out
     * the poll interval.
     */
    reload: () => Promise<void>;
    /** The list's own toast, so row actions report success/failure in the same place deletes do. */
    toastRef: React.RefObject<Toast>;
}

export interface ResourceListViewProps<T extends ResourceRow> {
    title: string;
    clusterName: string;
    api?: DockviewPanelApi;
    fetcher: (clusterName: string) => Promise<any[]>;
    createFrom: (raw: any) => T;
    /** When provided, enables multi-select + Delete Selected + confirmation dialog. */
    deleter?: (clusterName: string, name: string, namespace: string) => Promise<void>;
    /** Singular label for delete UI, e.g. "pod". */
    deleteLabel?: string;
    /**
     * DataTable row key. Defaults to the `__rowKey` (`namespace/name`) that
     * `useResourceList` stamps on every row, which is unique because a panel
     * lists exactly one kind. Only override it for a view whose rows are *not*
     * `namespace/name`-unique.
     */
    dataKey?: string;
    /**
     * Plural resource name (e.g. "pods"). When set, a Describe button column is
     * appended automatically — one prop instead of a hand-written button in
     * every view. The strings match the sidebar/TUI view keys and are resolved
     * to a GroupKind server-side by the REST mapper.
     */
    describeResource?: string;
    /**
     * Enables the port-forward button in the same trailing column, for kinds a
     * tunnel can be opened against. `kind` is the backend's lowercase singular
     * vocabulary.
     */
    portForward?: { kind: ForwardableKind };
    /**
     * Per-row mutating workload actions (scale / rollout restart / cronjob
     * suspend). Returns the spec for a row, or undefined for a row that offers
     * none. Their entries join Describe and Port forward in the same ⋮ menu,
     * and their dialogs are mounted once for the whole list — see
     * `useWorkloadActions`.
     */
    workloadActions?: (row: T) => WorkloadActionSpec | undefined;
    defaultFilters: DataTableFilterMeta;
    pollInterval?: number;
    emptyMessage: string;
    onRowDoubleClick?: (row: T) => void;
    /**
     * Extra toolbar content, rendered left of Delete Selected. Receives `reload`
     * so a create action can refresh immediately instead of waiting out a poll.
     */
    toolbarExtra?: (ctx: { reload: () => Promise<void> }) => React.ReactNode;
    /** Returns the <Column> elements for this resource (excluding the selection column). */
    columns: (ctx: ColumnsContext<T>) => React.ReactNode;
}

export default function ResourceListView<T extends ResourceRow>(props: ResourceListViewProps<T>) {
    const t = useT();
    const {
        title,
        clusterName,
        api,
        fetcher,
        createFrom,
        deleter,
        deleteLabel = 'resource',
        dataKey = '__rowKey',
        describeResource,
        portForward,
        workloadActions,
        defaultFilters,
        pollInterval,
        emptyMessage,
        onRowDoubleClick,
        toolbarExtra,
        columns,
    } = props;

    const {
        items,
        error,
        loading,
        refreshing,
        selected,
        setSelected,
        filters,
        setFilters,
        deleting,
        deleteDialogVisible,
        openDeleteDialog,
        closeDeleteDialog,
        handleDeleteSelected,
        reload,
        toastRef,
        buildInOptions,
    } = useResourceList<T>({
        clusterName,
        fetcher,
        createFrom,
        deleter,
        deleteLabel,
        defaultFilters,
        pollInterval,
        api,
    });

    const deletable = !!deleter;
    const { openDescribePanel } = useTabContext();

    // Every built-in row action lives in one ⋮ (kebab) popup menu instead of a
    // row of icon buttons. A list has ~8 columns of real data in a panel that is
    // often only half the window wide, so up to five always-visible action
    // buttons were the widest thing on the row that carried no information.
    //
    // It shares one right-frozen column with the view's own action buttons
    // (see `splitColumns`), so a row's actions stay on screen however far the
    // table is scrolled sideways.
    //
    // One Menu for the whole list, not one per row: the body renderer runs for
    // every visible row, so a per-row Menu (and, before this, a per-row set of
    // WorkloadActions dialogs) multiplied by the virtual scroller's row count.
    // The ⋮ button fills the model for its own row on click — the same pattern
    // the pod list's exec container picker uses.
    const [pfRow, setPfRow] = useState<{ name: string; namespace: string } | null>(null);
    const rowMenuRef = useRef<Menu>(null);
    const [rowMenuItems, setRowMenuItems] = useState<MenuItem[]>([]);
    // Which row the open menu belongs to. `toggle()` is wrong here: the button
    // stops propagation (so a click on it never reaches the row underneath),
    // which also keeps it from reaching PrimeReact's document-level
    // close-on-outside-click listener — so clicking a *second* row's ⋮ while the
    // menu is open would close it instead of re-opening it there.
    const openRowRef = useRef<string | null>(null);
    const { menuItems: workloadMenuItems, dialogs: workloadDialogs } = useWorkloadActions({
        clusterName,
        reload,
        toastRef,
    });

    const buildRowMenu = (row: T): MenuItem[] => {
        const items: MenuItem[] = [];
        if (describeResource) {
            items.push({
                label: t('action.describe'),
                icon: <VscInfo size={13} />,
                command: () =>
                    openDescribePanel({
                        clusterName,
                        resource: describeResource,
                        name: row.name,
                        namespace: row.namespace ?? '',
                        referencePanel: `${describeResource}:${clusterName}`,
                    }),
            });
        }
        if (portForward) {
            items.push({
                label: t('action.portForward'),
                icon: <VscArrowSwap size={13} />,
                command: () => setPfRow({ name: row.name, namespace: row.namespace ?? '' }),
            });
        }
        const workload = workloadMenuItems({ name: row.name, namespace: row.namespace ?? '' }, workloadActions?.(row));
        // The separator only earns its line when both groups are present:
        // above it, actions that read the object; below it, actions that change it.
        if (items.length > 0 && workload.length > 0) items.push({ separator: true });
        return [...items, ...workload];
    };

    const hasRowMenu = !!describeResource || !!portForward || !!workloadActions;
    const renderKebab = (row: T) => {
        // A row whose capabilities add up to nothing gets no button at
        // all, rather than one that opens an empty menu.
        const items = buildRowMenu(row);
        if (items.length === 0) return null;
        const key = `${row.namespace ?? ''}/${row.name}`;
        return (
            <Button
                icon={<VscKebabVertical size={16} />}
                text
                size="small"
                severity="secondary"
                style={{ padding: '0.2rem' }}
                aria-label={t('action.more')}
                aria-haspopup
                onClick={(e) => {
                    e.stopPropagation();
                    setRowMenuItems(items);
                    if (openRowRef.current === key) {
                        rowMenuRef.current?.hide(e);
                        openRowRef.current = null;
                    } else {
                        openRowRef.current = key;
                        rowMenuRef.current?.show(e);
                    }
                }}
            />
        );
    };

    const { data: dataColumns, actions: viewActions } = splitColumns(columns({ items, buildInOptions, reload, toastRef }));
    const hasActions = viewActions.length > 0 || hasRowMenu;
    let actionsWidth = 0;
    if (hasActions) {
        const widths = [...viewActions.map((a) => a.widthRem), ...(hasRowMenu ? [KEBAB_WIDTH_REM + CELL_PADDING_REM] : [])];
        actionsWidth = widths.reduce((sum, w) => sum + w, 0) - CELL_PADDING_REM * (widths.length - 1);
    }
    const actionsColumn = hasActions ? (
        <Column
            key="__actions"
            header=""
            {...ACTION_COLUMN_PROPS}
            headerStyle={{ width: `${actionsWidth}rem` }}
            style={{ width: `${actionsWidth}rem`, minWidth: `${actionsWidth}rem`, maxWidth: `${actionsWidth}rem` }}
            body={(row: T, options: any) => (
                <div className="ktable-actions">
                    {viewActions.map((a, i) => (
                        <React.Fragment key={i}>{typeof a.body === 'function' ? (a.body as CellRenderer)(row, options) : a.body}</React.Fragment>
                    ))}
                    {hasRowMenu && renderKebab(row)}
                </div>
            )}
        />
    ) : null;

    // PrimeReact's VirtualScroller derives its visible row count from the viewport
    // height captured at init() time. With scrollHeight="flex" that height is
    // purely CSS-flex-derived and the scroller only re-measures on a *window*
    // resize whose pixel height actually differs (virtualscroller.js onResize:
    // `isDiffHeight = height !== defaultHeight`). Inside a Dockview panel the flex
    // height is stable after the first paint, so when the panel is wide the
    // scroller measures once (often before data arrives) and never re-renders —
    // the table stays empty until the window is resized. Feeding an *explicit*
    // measured pixel scrollHeight instead makes every height change re-run the
    // scroller's init() (useUpdateEffect on props.scrollHeight), and ResizeObserver
    // — unlike window.resize — also fires on Dockview splitter drags / tab show.
    const tableWrapRef = useRef<HTMLDivElement>(null);
    const [scrollHeight, setScrollHeight] = useState<string>('flex');
    useLayoutEffect(() => {
        const el = tableWrapRef.current;
        if (!el) return;
        let last = -1;
        const apply = (height: number) => {
            // Ignore 0 (tab backgrounded/hidden) so we keep the last good height.
            if (height === 0 || height === last) return;
            last = height;
            setScrollHeight(`${height}px`);
        };
        // Measured synchronously in a *layout* effect, before the browser paints.
        // `observe()` delivers its first callback a frame later, which was late
        // enough for the table to paint at the 'flex' height and then be torn down
        // by the `key` below — the visible flicker on a panel's first load. The
        // wrapper is rendered unconditionally (the first-load spinner sits *inside*
        // it) precisely so this can run while the first fetch is still in flight,
        // leaving the table nothing to re-measure by the time it mounts.
        apply(Math.round(el.clientHeight));
        const observer = new ResizeObserver((entries) => {
            apply(Math.round(entries[0]?.contentRect.height ?? 0));
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // PrimeReact's DataTable selection props are a discriminated union; spreading a
    // conditionally-typed object keeps TS from trying to resolve `selectionMode` as
    // `'multiple' | undefined` (which fails overload resolution).
    const selectionProps: any = deletable
        ? {
              selectionMode: 'multiple',
              selection: selected,
              onSelectionChange: (e: any) => setSelected(Array.isArray(e.value) ? e.value : []),
          }
        : {};

    const deleteDialogFooter = (
        <div className="flex justify-content-end gap-2">
            <Button label={t('action.cancel')} icon={<VscClose size={16} />} text onClick={closeDeleteDialog} disabled={deleting} />
            <Button label={t('action.delete')} icon={<VscTrash size={16} />} severity="danger" onClick={handleDeleteSelected} loading={deleting} />
        </div>
    );

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <Toast ref={toastRef} position="bottom-right" />

            {/* Appended to <body>: the panel root and the table wrapper are both
                overflow:hidden, so an inline popup would be clipped by the row it
                belongs to. */}
            <Menu
                model={rowMenuItems}
                popup
                ref={rowMenuRef}
                className="row-actions-menu"
                appendTo={document.body}
                onHide={() => {
                    openRowRef.current = null;
                }}
            />

            <div className="rlv-toolbar" style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.6rem 1rem', borderBottom: '1px solid var(--surface-border)', flexShrink: 0 }}>
                {/* `title` so the ellipsis (theme-monolith.css) never hides the
                    panel's identity: German and Russian list titles run 20-35%
                    longer than the English these widths were chosen for. */}
                <h3 className="rlv-toolbar__title" style={{ margin: 0 }} title={title}>{title}</h3>
                <div className="rlv-toolbar__actions" style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    {toolbarExtra?.({ reload })}
                    <Button
                        icon={<VscClearAll size={16} />}
                        text
                        severity="secondary"
                        onClick={() => setFilters(defaultFilters)}
                        tooltip={t('action.clearFilters')}
                        tooltipOptions={{ position: 'left' }}
                    />
                    {deletable && (
                        <Button
                            label={t('action.deleteSelected')}
                            icon={<VscTrash size={16} />}
                            severity="danger"
                            onClick={openDeleteDialog}
                            disabled={selected.length === 0 || deleting}
                        />
                    )}
                </div>
            </div>

            {/* Three distinct outcomes, deliberately not collapsed into one
                "nothing here" state (beta-plan S8): still loading, failed, or
                genuinely empty. `error` with rows behind it means stale, not gone. */}
            <ErrorBanner
                message={error}
                onRetry={reload}
                busy={refreshing}
                stale={items.length > 0}
                context={`${title} (${clusterName})`}
            />

            {/* The wrapper is never conditional: it is what the layout effect above
                measures, and it has to exist (and have its final height) while the
                first fetch is still running so the table can mount already knowing
                its height. Only its *contents* swap from spinner to table. */}
            <div
                ref={tableWrapRef}
                className="ktable-fill"
                style={{
                    flex: 1,
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    ...(loading ? { alignItems: 'center', justifyContent: 'center' } : null),
                }}
            >
                {loading ? (
                    <ProgressSpinner style={{ width: 40, height: 40 }} strokeWidth="4" />
                ) : (
                <DataTable
                    // The virtual scroller captures its viewport height once at init time.
                    // When a panel is auto-opened during app launch, that init can run before
                    // the flex layout has a real height (scrollHeight still "flex"), so rows
                    // render into the DOM but are clipped/hidden and never recover. Remounting
                    // once a measured pixel height is available forces a fresh init with the
                    // correct height, after which normal value updates render rows. (Manually
                    // opened panels already mount into a settled layout, so they never hit this.)
                    // This flips exactly once, and because the wrapper is measured in a
                    // layout effect it flips *before* the table has ever painted, so the
                    // remount is invisible. Never key this to the live height: that would
                    // remount on every resize, and PrimeReact's VirtualScroller already
                    // re-runs init() when its scrollHeight prop changes (useUpdateEffect on
                    // [itemSize, scrollHeight, scrollWidth]) — no remount needed for that.
                    key={scrollHeight === 'flex' ? 'measuring' : 'measured'}
                    value={items}
                    dataKey={dataKey}
                    {...selectionProps}
                    onRowDoubleClick={onRowDoubleClick ? (e: any) => onRowDoubleClick(e.data as T) : undefined}
                    filters={filters}
                    onFilter={(e) => setFilters(e.filters)}
                    filterDisplay="row"
                    stripedRows
                    showGridlines
                    resizableColumns
                    scrollable
                    scrollHeight={scrollHeight}
                    virtualScrollerOptions={{ itemSize: ROW_HEIGHT }}
                    // A failed fetch must not read as "there are none of these":
                    // the banner above is the message in that case.
                    emptyMessage={error ? ' ' : emptyMessage}
                >
                    {deletable && (
                        <Column selectionMode="multiple" headerStyle={{ width: '3rem' }} style={{ minWidth: '3rem', maxWidth: '3rem' }} />
                    )}
                    {hasActions ? tagLastForActions(dataColumns) : dataColumns}
                    {actionsColumn}
                </DataTable>
                )}
            </div>

            {deletable && (
                <Dialog
                    // `deleteLabel` is a Kubernetes kind noun ("pod", "network
                    // policy") and stays English in every locale — see
                    // locales/GLOSSARY.md. Only the frame around it is translated.
                    header={t('resources:delete.header', { kind: deleteLabel.charAt(0).toUpperCase() + deleteLabel.slice(1) })}
                    visible={deleteDialogVisible}
                    style={{ width: '30rem' }}
                    modal
                    footer={deleteDialogFooter}
                    onHide={closeDeleteDialog}
                >
                    <p className="m-0 mb-3">{t('resources:delete.body', { label: deleteLabel })}</p>
                    <ul className="m-0 pl-3">
                        {selected.map((row) => (
                            <li key={`${row.namespace ?? ''}-${row.name}`}>{row.namespace ? `${row.namespace}/` : ''}{row.name}</li>
                        ))}
                    </ul>
                </Dialog>
            )}

            {workloadDialogs}

            {portForward && pfRow && (
                <PortForwardDialog
                    visible
                    clusterName={clusterName}
                    kind={portForward.kind}
                    name={pfRow.name}
                    namespace={pfRow.namespace}
                    onHide={() => setPfRow(null)}
                    onStarted={(info) =>
                        toastRef.current?.show({
                            severity: 'success',
                            summary: t('panels:portForward.startedSummary'),
                            detail: `${info.address}:${info.local_port} → ${pfRow.name}:${info.remote_port}`,
                            life: 5000,
                        })
                    }
                />
            )}
        </div>
    );
}
