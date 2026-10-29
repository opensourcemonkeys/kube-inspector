import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { Calendar } from 'primereact/calendar';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { VscDesktopDownload, VscFilter, VscHistory, VscRefresh } from 'react-icons/vsc';
import { Menu } from 'primereact/menu';
import { ExportToolboxHistory, GetToolboxAttempts, GetToolboxChanges, GetToolboxUsers } from '../../../../wailsjs/go/controller_app/App';
import { models } from '../../../../wailsjs/go/models';
import { usePanelActive } from '../../../lib/usePanelActive';
import { useSplitPane } from '../../../lib/useSplitPane';
import { errText } from '../../../lib/errText';
import { useT } from '../../../i18n/useT';
import { HISTORY_VIEWS, DEFAULT_HISTORY_FILTERS, useHistoryStore, useHistoryTab, type HistoryFilters, type HistoryView } from '../../../stores/historyStore';
import Segmented from '../../shared/Segmented';
import RowAction from '../../shared/RowAction';
import StatusLamp from '../../shared/StatusLamp';
import ErrorBanner from '../../shared/ErrorBanner';
import { ListSkeleton } from '../../shared/PanelSkeleton';
import ChangeDiff from './ChangeDiff';
import HistoryOverview from './HistoryOverview';
import AttemptDetail from './AttemptDetail';
import Attribution, { ATTRIBUTIONS } from './Attribution';
import { AgeCell, verbLamp } from './format';
import { useRollbackFollowUp } from './useRollbackFollowUp';
import { useChangeStream } from './useChangeStream';
import { mergeChange } from './mergeChange';
import { GapText, isGapRow, useRecordingGaps, withGaps, type GapRow } from './gaps';

const PAGE = 100;
// New changes are only interesting on the first page; once the user has paged
// back, a poll would throw away what they loaded.
const POLL_MS = 15_000;
const DETAIL_WIDTH_KEY = 'kube-ins:history-detail-width';
const VERBS = ['create', 'update', 'delete', 'finalized'];
const SINCES = ['1h', '24h', '168h', '720h', 'all', 'custom'] as const;
// The same sortable shape as formatTime.
const DATE_FORMAT = 'yy-mm-dd';

/** The since/until pair a filter's time choice sends to toolbox. */
function timeRange(f: HistoryFilters): { since: string; until: string } {
    if (f.since === 'custom') return { since: f.from, until: f.to };
    return { since: f.since === 'all' ? '' : f.since, until: '' };
}

/** One free-text filter; `name` is its HistoryFilters key. */
function FilterField({ name, label, value, onChange, className = 'history-filters__field' }: {
    name: keyof HistoryFilters;
    label: string;
    value: string;
    onChange: (e: ChangeEvent<HTMLInputElement>) => void;
    className?: string;
}) {
    return <InputText className={`${className} p-inputtext-sm`} name={name} value={value} onChange={onChange} placeholder={label} aria-label={label} />;
}

/** A user's changes of one verb, or null from a toolbox without per-verb counts. */
function verbCount(u: models.ToolboxUser, verb: string): number | null {
    if (u.changes > 0 && u.creates + u.updates + u.deletes + u.finalized === 0) return null;
    return verb === 'create' ? u.creates : verb === 'update' ? u.updates : verb === 'delete' ? u.deletes : u.finalized;
}

/** A changes-table cell renderer that leaves gap rows empty. */
const onlyChanges = (render: (c: models.ToolboxChange) => ReactNode) =>
    (row: models.ToolboxChange | GapRow) => (isGapRow(row) ? null : render(row));

/**
 * A cell value with a "filter by this" button that shows on row hover or
 * keyboard focus. The button stops the click so the row does not also open.
 */
function Pivot({ label, onPivot, children }: { label: string; onPivot: () => void; children: ReactNode }) {
    return (
        <span className="history-cell">
            <span className="history-cell__value">{children}</span>
            <span className="history-cell__pivot">
                <RowAction icon={<VscFilter size={12} />} label={label} onClick={(e) => { e.stopPropagation(); onPivot(); }} />
            </span>
        </span>
    );
}

/**
 * toolbox's change history for one cluster: changes, rejected requests and
 * users, with a selected change opening as a YAML diff beside the list.
 *
 * Not a ResourceListView: filtering happens in toolbox (server-side, over
 * every recorded row) and the list pages by cursor. The filters and view live
 * in historyStore, so they survive the tab being closed and reopened.
 */
export default function ClusterHistoryPanel({ params, api }: IDockviewPanelProps<{ clusterName: string }>) {
    const t = useT();
    const { clusterName } = params;
    const storeKey = `history:${clusterName}`;
    const active = usePanelActive(api);
    const toast = useRef<Toast>(null);
    const { splitRef, width, startResize } = useSplitPane(DETAIL_WIDTH_KEY, 760, 360);

    const { view, filters } = useHistoryTab(storeKey);
    const setViewInStore = useHistoryStore((s) => s.setView);
    const patchFilters = useHistoryStore((s) => s.patchFilters);
    // Typing goes to `filters`; requests follow `query`, 300ms behind.
    const [query, setQuery] = useState<HistoryFilters>(filters);
    const [changes, setChanges] = useState<models.ToolboxChange[]>([]);
    const [cursor, setCursor] = useState('');
    const [pages, setPages] = useState(1);
    const [attempts, setAttempts] = useState<models.ToolboxAttempt[]>([]);
    const [attemptsCursor, setAttemptsCursor] = useState('');
    const [attemptPages, setAttemptPages] = useState(1);
    const [selectedAttempt, setSelectedAttempt] = useState<string | null>(null);
    const [exporting, setExporting] = useState(false);
    const exportMenu = useRef<Menu>(null);
    const [users, setUsers] = useState<models.ToolboxUser[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [tick, setTick] = useState(0);
    // Only the latest request may write state: a slow response for an old
    // filter must not land over a newer one.
    const reqId = useRef(0);

    useEffect(() => {
        const h = setTimeout(() => setQuery(filters), 300);
        return () => clearTimeout(h);
    }, [filters]);

    const filterModel = (f: HistoryFilters, after = '') => models.ToolboxChangeFilter.createFrom({
        q: f.q, namespace: f.namespace, resource: f.resource, kind: f.kind, name: f.name, user: f.user,
        verb: f.verb, attribution: f.attribution, path: f.path,
        ...timeRange(f),
        cursor: after,
        limit: PAGE,
    });

    const fetchView = useCallback(async (background: boolean) => {
        // The overview fetches its own data.
        if (view === 'overview') { setLoading(false); return; }
        const id = ++reqId.current;
        if (background) setRefreshing(true); else setLoading(true);
        try {
            if (view === 'changes') {
                const page = await GetToolboxChanges(clusterName, filterModel(query));
                if (id !== reqId.current) return;
                setChanges(page.items ?? []);
                setCursor(page.nextCursor ?? '');
                setPages(1);
            } else if (view === 'attempts') {
                const page = await GetToolboxAttempts(clusterName, filterModel(query));
                if (id !== reqId.current) return;
                setAttempts(page.items ?? []);
                setAttemptsCursor(page.nextCursor ?? '');
                setAttemptPages(1);
            } else {
                // toolbox reads an empty since as "the last 7 days" here, and
                // the users summary has no upper bound.
                const items = await GetToolboxUsers(clusterName, timeRange(query).since || '87600h');
                if (id !== reqId.current) return;
                setUsers(items ?? []);
            }
            setError(null);
        } catch (e) {
            if (id === reqId.current) setError(errText(e));
        } finally {
            if (id === reqId.current) {
                setLoading(false);
                setRefreshing(false);
            }
        }
    }, [clusterName, view, query]);

    useEffect(() => { void fetchView(false); }, [fetchView]);
    useEffect(() => { if (tick > 0) void fetchView(true); }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps

    // Live while the first page of changes is on screen and the range runs to
    // now; a paged-back list or a past range has nothing new to show.
    const streamFilter = useMemo(
        () => (active && view === 'changes' && pages === 1 && !timeRange(query).until ? filterModel(query) : null),
        [active, view, pages, query],
    );
    const stream = useChangeStream(clusterName, streamFilter, (c) => setChanges((prev) => mergeChange(prev, c)));
    const streaming = stream === 'live' || stream === 'connecting';

    useEffect(() => {
        if (!active || view === 'overview' || (view === 'changes' && (pages > 1 || streaming)) || (view === 'attempts' && attemptPages > 1)) return;
        const h = setInterval(() => setTick((n) => n + 1), POLL_MS);
        return () => clearInterval(h);
    }, [active, view, pages, attemptPages, streaming]);

    // Back from the background: catch up once. The stream only looks a few
    // minutes back, and a poll would wait out its interval first.
    const wasActive = useRef(active);
    useEffect(() => {
        if (active && !wasActive.current) setTick((n) => n + 1);
        wasActive.current = active;
    }, [active]);

    // Stretches with no recording leader, shown in the list where they fall.
    // toolbox keeps heartbeats 30 days, so "all time" asks for that much.
    const range = timeRange(query);
    const gaps = useRecordingGaps(clusterName, range.since || '720h', range.until, active && view === 'changes');
    const rows = useMemo(() => withGaps(changes, gaps, !cursor), [changes, gaps, cursor]);

    // After a rollback the list refreshes until the rollback's own change
    // shows up, and marks it.
    const followUp = useRollbackFollowUp(() => void fetchView(true), changes);

    const loadMore = async () => {
        const id = ++reqId.current;
        setLoadingMore(true);
        try {
            if (view === 'attempts') {
                const page = await GetToolboxAttempts(clusterName, filterModel(query, attemptsCursor));
                if (id !== reqId.current) return;
                setAttempts((prev) => prev.concat(page.items ?? []));
                setAttemptsCursor(page.nextCursor ?? '');
                setAttemptPages((n) => n + 1);
                return;
            }
            const page = await GetToolboxChanges(clusterName, filterModel(query, cursor));
            if (id !== reqId.current) return;
            setChanges((prev) => prev.concat(page.items ?? []));
            setCursor(page.nextCursor ?? '');
            setPages((n) => n + 1);
        } catch (e) {
            if (id === reqId.current) setError(errText(e));
        } finally {
            setLoadingMore(false);
        }
    };

    // Everything the current filter matches, not just the loaded pages; the
    // backend asks where to save first and then pages through toolbox.
    const runExport = async (format: 'csv' | 'json') => {
        if (view !== 'changes' && view !== 'attempts') return;
        setExporting(true);
        try {
            const res = await ExportToolboxHistory(clusterName, view, filterModel(query), format);
            if (!res.path) return; // cancelled
            toast.current?.show(res.truncated ? {
                severity: 'warn', summary: t('panels:clusterHistory.export.truncated', { count: res.rows }),
                detail: t('panels:clusterHistory.export.truncatedDetail', { limit: res.limit, path: res.path }), life: 8000,
            } : {
                severity: 'success', summary: t('panels:clusterHistory.export.done', { count: res.rows }), detail: res.path, life: 4000,
            });
        } catch (e) {
            toast.current?.show({ severity: 'error', summary: t('panels:clusterHistory.export.failed'), detail: errText(e), life: 6000 });
        } finally {
            setExporting(false);
        }
    };
    const exportItems = [
        { label: t('panels:clusterHistory.export.csv'), command: () => void runExport('csv') },
        { label: t('panels:clusterHistory.export.json'), command: () => void runExport('json') },
    ];

    const setView = (v: HistoryView) => {
        setViewInStore(storeKey, v);
        setError(null);
    };
    const patch = (p: Partial<HistoryFilters>) => patchFilters(storeKey, p);
    // Every filter input is named after its HistoryFilters key.
    const onField = (e: ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        patch({ [name]: value });
    };
    const onSelect = (e: { target: { name: string }; value: string | null }) => {
        const name = e.target.name as keyof HistoryFilters;
        patch({ [name]: e.value ?? DEFAULT_HISTORY_FILTERS[name] });
    };
    // Calendar's time picker reads the first date unguarded, so an empty range
    // is null rather than [null, null]; [from, null] is its own half-picked state.
    const rangeValue = useMemo(
        () => (filters.from ? [new Date(filters.from), filters.to ? new Date(filters.to) : null] : null),
        [filters.from, filters.to],
    );
    const onRange = (value: (Date | null)[] | null | undefined) => {
        const [from, to] = value ?? [];
        patch({ from: from ? from.toISOString() : '', to: to ? to.toISOString() : '' });
    };
    const showUser = (u: models.ToolboxUser) => {
        patch({ user: u.username });
        setView('changes');
    };

    const viewOptions = HISTORY_VIEWS.map((v) => ({ value: v, label: t(`panels:clusterHistory.view.${v}`) }));
    const context = `${t('panels:clusterHistory.label')} (${clusterName})`;
    const sinceOptions = SINCES.map((v) => ({ value: v, label: t(`panels:clusterHistory.since.${v}`) }));
    const verbOptions = [{ value: '', label: t('panels:clusterHistory.filter.anyVerb') }, ...VERBS.map((v) => ({ value: v, label: v }))];
    const attributionOptions = [
        { value: '', label: t('panels:clusterHistory.filter.anySource') },
        ...ATTRIBUTIONS.map((v) => ({ value: v, label: t(`panels:clusterHistory.via.${v}`) })),
    ];

    const [emptyChanges, emptyAttempts, emptyUsers] = (['changes', 'attempts', 'users'] as const).map((v) => (
        <div className="rlv-empty" key={v}><span>{t(`panels:clusterHistory.empty.${v}`)}</span></div>
    ));
    const nsCell = (v: string) => (v
        ? <Pivot label={t('panels:clusterHistory.pivot.namespace')} onPivot={() => patch({ namespace: v })}>{v}</Pivot>
        : <span className="cell-empty">—</span>);
    const objectCell = (kind: ReactNode, resource: string, name: string) => (
        name ? (
            <Pivot label={t('panels:clusterHistory.pivot.object')} onPivot={() => patch({ resource, name })}>
                <span className="history-kind">{kind}</span> {name}
            </Pivot>
        ) : <><span className="history-kind">{kind}</span> —</>
    );
    const userCell = (user: string, rest?: ReactNode) => (
        <Pivot label={t('panels:clusterHistory.pivot.user')} onPivot={() => patch({ user })}>{user}{rest}</Pivot>
    );

    const changesTable = (
        <div className="history-list">
            <div className="history-list__table">
                <DataTable
                    value={rows}
                    dataKey="eventId"
                    scrollable
                    scrollHeight="flex"
                    size="small"
                    onRowClick={(e) => { if (!isGapRow(e.data)) setSelected((e.data as models.ToolboxChange).eventId); }}
                    rowClassName={(c: models.ToolboxChange | GapRow) => (isGapRow(c) ? 'history-row--gap' : {
                        'rlv-row--active': c.eventId === selected, 'history-row': true, 'history-row--rolled': c.eventId === followUp.found,
                    })}
                    emptyMessage={emptyChanges}
                >
                    <Column header={t('panels:clusterHistory.col.time')} bodyClassName="cell-mono history-time" style={{ minWidth: '5rem' }}
                        body={(c: models.ToolboxChange | GapRow) => (isGapRow(c) ? <AgeCell iso={c.gap.to} /> : <AgeCell iso={c.time} />)} />
                    <Column header={t('panels:clusterHistory.col.verb')} style={{ minWidth: '7rem' }} body={onlyChanges((c: models.ToolboxChange) => verbLamp(c.verb))} />
                    <Column header={t('panels:clusterHistory.col.object')} style={{ minWidth: '12rem' }}
                        body={(c: models.ToolboxChange | GapRow) => (isGapRow(c) ? <GapText gap={c.gap} /> : objectCell(c.kind, c.resource, c.name))} />
                    <Column header={t('panels:clusterHistory.col.namespace')} style={{ minWidth: '8rem' }} body={onlyChanges((c: models.ToolboxChange) => nsCell(c.namespace))} />
                    <Column header={t('panels:clusterHistory.col.user')} style={{ minWidth: '12rem' }} body={onlyChanges((c: models.ToolboxChange) => (
                        c.actor?.username ? userCell(c.actor.username, c.actor.impersonatedBy && (
                            <span className="history-kind"> {t('panels:clusterHistory.by', { user: c.actor.impersonatedBy })}</span>
                        )) : (
                            <span className="cell-empty">{c.fieldManager ? `(${c.fieldManager})` : '—'}</span>
                        )
                    ))} />
                    <Column header={t('panels:clusterHistory.col.via')} style={{ minWidth: '9rem' }} body={onlyChanges((c: models.ToolboxChange) => <Attribution value={c.attribution} />)} />
                    <Column header={t('panels:clusterHistory.col.changed')} bodyClassName="cell-mono history-paths" style={{ minWidth: '12rem' }}
                        body={onlyChanges((c: models.ToolboxChange) => (
                            <span title={(c.changedPaths ?? []).join('\n')}>{(c.changedPaths ?? []).slice(0, 3).join('  ')}</span>
                        ))} />
                </DataTable>
            </div>
            {cursor && (
                <div className="history-list__more">
                    <Button label={t('panels:clusterHistory.loadMore')} text size="small" loading={loadingMore} onClick={() => void loadMore()} />
                </div>
            )}
        </div>
    );

    const attemptsTable = (
        <div className="history-list">
            <div className="history-list__table">
                <DataTable
                    value={attempts}
                    dataKey="auditId"
                    scrollable
                    scrollHeight="flex"
                    size="small"
                    emptyMessage={emptyAttempts}
                    onRowClick={(e) => setSelectedAttempt((e.data as models.ToolboxAttempt).auditId ?? null)}
                    rowClassName={(r: models.ToolboxAttempt) => ({ 'rlv-row--active': r.auditId === selectedAttempt, 'history-row': true })}
                >
                    <Column header={t('panels:clusterHistory.col.time')} bodyClassName="cell-mono history-time" style={{ minWidth: '5rem' }}
                        body={(r: models.ToolboxAttempt) => <AgeCell iso={r.time} />} />
                    <Column header={t('panels:clusterHistory.col.response')} style={{ minWidth: '9rem' }}
                        body={(r: models.ToolboxAttempt) => <StatusLamp label={`${r.responseCode} ${r.responseReason ?? ''}`} tone="err" />} />
                    <Column header={t('panels:clusterHistory.col.verb')} style={{ minWidth: '6rem' }} field="verb" />
                    <Column header={t('panels:clusterHistory.col.object')} style={{ minWidth: '12rem' }} body={(r: models.ToolboxAttempt) => (
                        objectCell(r.resource + (r.subresource ? '/' + r.subresource : ''), r.resource, r.name)
                    )} />
                    <Column header={t('panels:clusterHistory.col.namespace')} style={{ minWidth: '8rem' }} body={(r: models.ToolboxAttempt) => nsCell(r.namespace)} />
                    <Column header={t('panels:clusterHistory.col.user')} style={{ minWidth: '10rem' }}
                        body={(r: models.ToolboxAttempt) => (r.username ? userCell(r.username) : <span className="cell-empty">—</span>)} />
                    <Column header={t('panels:clusterHistory.col.message')} style={{ minWidth: '16rem' }}
                        body={(r: models.ToolboxAttempt) => <span className="history-paths" title={r.responseMessage}>{r.responseMessage}</span>} />
                </DataTable>
            </div>
            {attemptsCursor && (
                <div className="history-list__more">
                    <Button label={t('panels:clusterHistory.loadMore')} text size="small" loading={loadingMore} onClick={() => void loadMore()} />
                </div>
            )}
        </div>
    );

    const usersTable = (
        <div className="history-list">
            <div className="history-list__table">
                <DataTable
                    value={users}
                    dataKey="username"
                    scrollable
                    scrollHeight="flex"
                    size="small"
                    emptyMessage={emptyUsers}
                    // A user row is a shortcut to that user's changes.
                    onRowClick={(e) => showUser(e.data as models.ToolboxUser)}
                    rowClassName={() => 'history-row'}
                >
                    <Column header={t('panels:clusterHistory.col.user')} style={{ minWidth: '14rem' }} field="username" />
                    <Column header={t('panels:clusterHistory.col.changes')} style={{ minWidth: '6rem' }} bodyClassName="cell-mono" field="changes" />
                    {/* Verbs are data (the API verb class), shown as recorded. */}
                    {VERBS.map((v) => (
                        <Column key={v} header={verbLamp(v)} style={{ minWidth: '6rem' }} bodyClassName="cell-mono"
                            body={(u: models.ToolboxUser) => {
                                const n = verbCount(u, v);
                                // An older toolbox sends no per-verb counts.
                                return n === null ? <span className="cell-empty">—</span> : n || <span className="cell-empty">0</span>;
                            }} />
                    ))}
                    <Column header={t('panels:clusterHistory.col.lastSeen')} bodyClassName="cell-mono history-time" style={{ minWidth: '6rem' }}
                        body={(u: models.ToolboxUser) => <AgeCell iso={u.lastSeen} />} />
                    <Column header={t('panels:clusterHistory.col.userAgents')} style={{ minWidth: '16rem' }} body={(u: models.ToolboxUser) => (
                        <span className="history-paths" title={(u.userAgents ?? []).join('\n')}>{(u.userAgents ?? []).join(', ')}</span>
                    )} />
                </DataTable>
            </div>
        </div>
    );

    // A drill from the overview starts from what the overview shows (its
    // namespace and period) plus the one value clicked: a list filter left
    // over from earlier would make the changes disagree with the number that
    // was clicked.
    const drill = (p: Partial<HistoryFilters>, v: HistoryView) => {
        patch({ q: '', resource: '', kind: '', name: '', user: '', verb: '', attribution: '', path: '', ...p });
        setView(v);
    };

    const body = view === 'overview' ? (
        <HistoryOverview clusterName={clusterName} filters={query} active={active}
            onDrill={drill} onBucket={(b) => patch({ bucket: b })} />
    ) : loading ? (
        <ListSkeleton />
    ) : error && (view === 'changes' ? changes : view === 'attempts' ? attempts : users).length === 0 ? (
        <ErrorBanner block message={error} onRetry={() => void fetchView(false)} busy={refreshing} cluster={clusterName} context={context} />
    ) : view === 'changes' ? changesTable : view === 'attempts' ? attemptsTable : usersTable;

    const shownAttempt = view === 'attempts' && selectedAttempt !== null ? attempts.find((a) => a.auditId === selectedAttempt) : undefined;
    const showDetail = (view === 'changes' && selected !== null) || shownAttempt !== undefined;

    return (
        <div className="history-panel">
            <Toast ref={toast} position="bottom-right" />

            <div className="panel-toolbar">
                <span className="panel-toolbar__label">
                    <VscHistory size={14} aria-hidden />
                    {t('panels:clusterHistory.label')}
                </span>
                <div className="panel-toolbar__actions">
                    <Segmented<HistoryView>
                        value={view}
                        onChange={setView}
                        ariaLabel={t('panels:clusterHistory.viewAria')}
                        options={viewOptions}
                    />
                    {followUp.waiting && <span className="obj-history__waiting">{t('panels:objectHistory.waiting')}</span>}
                    {view === 'changes' && stream === 'live' && (
                        <span title={t('panels:clusterHistory.liveHint')}><StatusLamp label={t('panels:clusterHistory.live')} tone="ok" /></span>
                    )}
                    {(view === 'changes' || view === 'attempts') && (
                        <>
                            <Menu model={exportItems} popup ref={exportMenu} />
                            <Button label={t('panels:clusterHistory.export.button')} icon={<VscDesktopDownload size={14} />} text size="small"
                                loading={exporting} aria-haspopup onClick={(e) => exportMenu.current?.toggle(e)} />
                        </>
                    )}
                    <RowAction icon={<VscRefresh size={14} />} label={t('panels:clusterHistory.refresh')} loading={refreshing} onClick={() => void fetchView(true)} />
                </div>
            </div>

            <div className="history-filters">
                {view === 'changes' && <FilterField name="q" label={t('panels:clusterHistory.filter.search')} value={filters.q} onChange={onField} className="history-filters__search" />}
                {view === 'overview' && (
                    <FilterField name="namespace" label={t('panels:clusterHistory.filter.namespace')} value={filters.namespace} onChange={onField} />
                )}
                {(view === 'changes' || view === 'attempts') && (
                    <>
                        <FilterField name="namespace" label={t('panels:clusterHistory.filter.namespace')} value={filters.namespace} onChange={onField} />
                        <FilterField name="resource" label={t('panels:clusterHistory.filter.resource')} value={filters.resource} onChange={onField} />
                        {view === 'changes' && <FilterField name="kind" label={t('panels:clusterHistory.filter.kind')} value={filters.kind} onChange={onField} />}
                        <FilterField name="name" label={t('panels:clusterHistory.filter.name')} value={filters.name} onChange={onField} />
                        <FilterField name="user" label={t('panels:clusterHistory.filter.user')} value={filters.user} onChange={onField} />
                    </>
                )}
                {view === 'changes' && (
                    <>
                        <FilterField name="path" label={t('panels:clusterHistory.filter.path')} value={filters.path} onChange={onField} className="history-filters__field history-filters__path" />
                        <Dropdown className="history-filters__select p-inputtext-sm" name="verb" value={filters.verb} options={verbOptions} placeholder={t('panels:clusterHistory.filter.anyVerb')}
                            onChange={onSelect} aria-label={t('panels:clusterHistory.col.verb')} />
                        <Dropdown className="history-filters__select p-inputtext-sm" name="attribution" value={filters.attribution} options={attributionOptions}
                            placeholder={t('panels:clusterHistory.filter.anySource')} onChange={onSelect} aria-label={t('panels:clusterHistory.col.via')} />
                    </>
                )}
                <Dropdown className="history-filters__select p-inputtext-sm" name="since" value={filters.since} options={sinceOptions}
                    onChange={onSelect} aria-label={t('panels:clusterHistory.filter.sinceAria')} />
                {filters.since === 'custom' && (
                    <Calendar
                        className="history-filters__range p-inputtext-sm"
                        value={rangeValue}
                        onChange={(e) => onRange(e.value as (Date | null)[] | null)}
                        selectionMode="range"
                        showTime
                        hourFormat="24"
                        dateFormat={DATE_FORMAT}
                        readOnlyInput
                        showButtonBar
                        placeholder={t('panels:clusterHistory.filter.range')}
                        aria-label={t('panels:clusterHistory.filter.range')}
                    />
                )}
            </div>

            {error && !loading && view !== 'overview' && (view === 'changes' ? changes : view === 'attempts' ? attempts : users).length > 0 && (
                <ErrorBanner message={error} onRetry={() => void fetchView(true)} busy={refreshing} stale context={context} />
            )}

            <div className="pod-split history-split" ref={splitRef}>
                <div className="pod-split__list">{body}</div>
                {showDetail && (
                    <>
                        <div className="pod-split__handle" role="separator" aria-orientation="vertical" onPointerDown={startResize} />
                        <div className="pod-split__detail" style={{ width }}>
                            {shownAttempt ? <AttemptDetail attempt={shownAttempt} onClose={() => setSelectedAttempt(null)} /> : selected && <ChangeDiff
                                key={selected}
                                clusterName={clusterName}
                                eventId={selected}
                                onClose={() => setSelected(null)}
                                onRolledBack={(msg, at) => {
                                    toast.current?.show({ severity: 'success', summary: t('panels:clusterHistory.rollback.done'), detail: msg, life: 3000 });
                                    const c = changes.find((x) => x.eventId === selected);
                                    if (c) followUp.follow({ at, resource: c.resource, namespace: c.namespace, name: c.name });
                                }}
                            />}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
