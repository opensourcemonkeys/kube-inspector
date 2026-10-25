import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { VscHistory, VscRefresh } from 'react-icons/vsc';
import { GetToolboxAttempts, GetToolboxChanges, GetToolboxUsers } from '../../../../wailsjs/go/controller_app/App';
import { models } from '../../../../wailsjs/go/models';
import { usePanelActive } from '../../../lib/usePanelActive';
import { useSplitPane } from '../../../lib/useSplitPane';
import { errText } from '../../../lib/errText';
import { useT } from '../../../i18n/useT';
import Segmented from '../../shared/Segmented';
import RowAction from '../../shared/RowAction';
import StatusLamp from '../../shared/StatusLamp';
import ErrorBanner from '../../shared/ErrorBanner';
import { ListSkeleton } from '../../shared/PanelSkeleton';
import ChangeDiff from './ChangeDiff';
import { formatTime, verbLamp } from './format';

const VIEWS = ['changes', 'attempts', 'users'] as const;
type View = typeof VIEWS[number];

interface Filters {
    q: string;
    namespace: string;
    resource: string;
    user: string;
    verb: string;
    since: string;
}

const DEFAULT_FILTERS: Filters = { q: '', namespace: '', resource: '', user: '', verb: '', since: '24h' };
const PAGE = 100;
// New changes are only interesting on the first page; once the user has paged
// back, a poll would throw away what they loaded.
const POLL_MS = 15_000;
const DETAIL_WIDTH_KEY = 'kube-ins:history-detail-width';
const VERBS = ['create', 'update', 'delete', 'finalized'];
const SINCES = ['1h', '24h', '168h', '720h', 'all'] as const;

/**
 * toolbox's change history for one cluster: the same three views as its own
 * web UI (changes, rejected requests, users), with a selected change opening
 * as a YAML diff beside the list.
 *
 * Not a ResourceListView: filtering happens in toolbox (server-side, over
 * every recorded row) and the list pages by cursor.
 */
export default function ClusterHistoryPanel({ params, api }: IDockviewPanelProps<{ clusterName: string }>) {
    const t = useT();
    const { clusterName } = params;
    const active = usePanelActive(api);
    const toast = useRef<Toast>(null);
    const { splitRef, width, startResize } = useSplitPane(DETAIL_WIDTH_KEY, 760, 360);

    const [view, setView] = useState<View>('changes');
    const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
    // Typing goes to `filters`; requests follow `query`, 300ms behind.
    const [query, setQuery] = useState<Filters>(DEFAULT_FILTERS);
    const [changes, setChanges] = useState<models.ToolboxChange[]>([]);
    const [cursor, setCursor] = useState('');
    const [pages, setPages] = useState(1);
    const [attempts, setAttempts] = useState<models.ToolboxAttempt[]>([]);
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

    const filterModel = (f: Filters, after = '') => models.ToolboxChangeFilter.createFrom({
        ...f,
        since: f.since === 'all' ? '' : f.since,
        cursor: after,
        limit: PAGE,
    });

    const fetchView = useCallback(async (background: boolean) => {
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
                const items = await GetToolboxAttempts(clusterName, filterModel(query));
                if (id !== reqId.current) return;
                setAttempts(items ?? []);
            } else {
                // toolbox reads an empty since as "the last 7 days" here.
                const items = await GetToolboxUsers(clusterName, query.since === 'all' ? '87600h' : query.since);
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

    useEffect(() => {
        if (!active || (view === 'changes' && pages > 1)) return;
        const h = setInterval(() => setTick((n) => n + 1), POLL_MS);
        return () => clearInterval(h);
    }, [active, view, pages]);

    const loadMore = async () => {
        const id = ++reqId.current;
        setLoadingMore(true);
        try {
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

    // Every filter input is named after its Filters key.
    const onField = (e: ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setFilters((f) => ({ ...f, [name]: value }));
    };
    const onSelect = (e: { target: { name: string }; value: string | null }) => {
        const name = e.target.name as keyof Filters;
        setFilters((f) => ({ ...f, [name]: e.value ?? DEFAULT_FILTERS[name] }));
    };
    const showUser = (u: models.ToolboxUser) => {
        setFilters((f) => ({ ...f, user: u.username }));
        setView(VIEWS[0]);
    };
    const viewOptions = VIEWS.map((v) => ({ value: v, label: t(`panels:clusterHistory.view.${v}`) }));
    const context = `${t('panels:clusterHistory.label')} (${clusterName})`;
    const sinceOptions = SINCES.map((v) => ({ value: v, label: t(`panels:clusterHistory.since.${v}`) }));
    const verbOptions = [{ value: '', label: t('panels:clusterHistory.filter.anyVerb') }, ...VERBS.map((v) => ({ value: v, label: v }))];

    const [emptyChanges, emptyAttempts, emptyUsers] = VIEWS.map((v) => (
        <div className="rlv-empty" key={v}><span>{t(`panels:clusterHistory.empty.${v}`)}</span></div>
    ));
    const ips = (list?: string[]) => (list?.length ? list.join(', ') : <span className="cell-empty">—</span>);
    const ns = (v: string) => v || <span className="cell-empty">—</span>;

    const changesTable = (
        <div className="history-list">
            <div className="history-list__table">
                <DataTable
                    value={changes}
                    dataKey="eventId"
                    scrollable
                    scrollHeight="flex"
                    size="small"
                    onRowClick={(e) => setSelected((e.data as models.ToolboxChange).eventId)}
                    rowClassName={(c: models.ToolboxChange) => ({ 'rlv-row--active': c.eventId === selected, 'history-row': true })}
                    emptyMessage={emptyChanges}
                >
                    <Column header={t('panels:clusterHistory.col.time')} bodyClassName="cell-mono history-time" style={{ minWidth: '10.5rem' }}
                        body={(c: models.ToolboxChange) => formatTime(c.time)} />
                    <Column header={t('panels:clusterHistory.col.verb')} style={{ minWidth: '7rem' }} body={(c: models.ToolboxChange) => verbLamp(c.verb)} />
                    <Column header={t('panels:clusterHistory.col.object')} style={{ minWidth: '12rem' }}
                        body={(c: models.ToolboxChange) => <><span className="history-kind">{c.kind}</span> {c.name}</>} />
                    <Column header={t('panels:clusterHistory.col.namespace')} style={{ minWidth: '8rem' }} body={(c: models.ToolboxChange) => ns(c.namespace)} />
                    <Column header={t('panels:clusterHistory.col.user')} style={{ minWidth: '12rem' }} body={(c: models.ToolboxChange) => (
                        c.actor?.username ? (
                            <>
                                {c.actor.username}
                                {c.actor.impersonatedBy && <span className="history-kind"> {t('panels:clusterHistory.by', { user: c.actor.impersonatedBy })}</span>}
                            </>
                        ) : (
                            <span className="cell-empty">{c.fieldManager ? `(${c.fieldManager})` : '—'}</span>
                        )
                    )} />
                    <Column header={t('panels:clusterHistory.col.sourceIp')} bodyClassName="cell-mono" style={{ minWidth: '8rem' }}
                        body={(c: models.ToolboxChange) => ips(c.actor?.sourceIPs)} />
                    <Column header={t('panels:clusterHistory.col.via')} style={{ minWidth: '7rem' }} body={(c: models.ToolboxChange) => c.attribution} />
                    <Column header={t('panels:clusterHistory.col.changed')} bodyClassName="cell-mono history-paths" style={{ minWidth: '12rem' }}
                        body={(c: models.ToolboxChange) => (
                            <span title={(c.changedPaths ?? []).join('\n')}>{(c.changedPaths ?? []).slice(0, 3).join('  ')}</span>
                        )} />
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
                <DataTable value={attempts} scrollable scrollHeight="flex" size="small" emptyMessage={emptyAttempts}>
                    <Column header={t('panels:clusterHistory.col.time')} bodyClassName="cell-mono history-time" style={{ minWidth: '10.5rem' }}
                        body={(r: models.ToolboxAttempt) => formatTime(r.time)} />
                    <Column header={t('panels:clusterHistory.col.response')} style={{ minWidth: '9rem' }}
                        body={(r: models.ToolboxAttempt) => <StatusLamp label={`${r.responseCode} ${r.responseReason ?? ''}`} tone="err" />} />
                    <Column header={t('panels:clusterHistory.col.verb')} style={{ minWidth: '6rem' }} field="verb" />
                    <Column header={t('panels:clusterHistory.col.object')} style={{ minWidth: '12rem' }} body={(r: models.ToolboxAttempt) => (
                        <><span className="history-kind">{r.resource}{r.subresource ? '/' + r.subresource : ''}</span> {r.name || '—'}</>
                    )} />
                    <Column header={t('panels:clusterHistory.col.namespace')} style={{ minWidth: '8rem' }} body={(r: models.ToolboxAttempt) => ns(r.namespace)} />
                    <Column header={t('panels:clusterHistory.col.user')} style={{ minWidth: '10rem' }} field="username" />
                    <Column header={t('panels:clusterHistory.col.sourceIp')} bodyClassName="cell-mono" style={{ minWidth: '8rem' }}
                        body={(r: models.ToolboxAttempt) => ips(r.sourceIPs)} />
                    <Column header={t('panels:clusterHistory.col.message')} style={{ minWidth: '16rem' }}
                        body={(r: models.ToolboxAttempt) => <span className="history-paths" title={r.responseMessage}>{r.responseMessage}</span>} />
                </DataTable>
            </div>
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
                    <Column header={t('panels:clusterHistory.col.lastSeen')} bodyClassName="cell-mono history-time" style={{ minWidth: '10.5rem' }}
                        body={(u: models.ToolboxUser) => formatTime(u.lastSeen)} />
                    <Column header={t('panels:clusterHistory.col.sourceIp')} bodyClassName="cell-mono" style={{ minWidth: '10rem' }}
                        body={(u: models.ToolboxUser) => ips(u.sourceIPs)} />
                    <Column header={t('panels:clusterHistory.col.userAgents')} style={{ minWidth: '16rem' }} body={(u: models.ToolboxUser) => (
                        <span className="history-paths" title={(u.userAgents ?? []).join('\n')}>{(u.userAgents ?? []).join(', ')}</span>
                    )} />
                </DataTable>
            </div>
        </div>
    );

    const body = loading ? (
        <ListSkeleton />
    ) : error && (view === 'changes' ? changes : view === 'attempts' ? attempts : users).length === 0 ? (
        <ErrorBanner block message={error} onRetry={() => void fetchView(false)} busy={refreshing} cluster={clusterName} context={context} />
    ) : view === 'changes' ? changesTable : view === 'attempts' ? attemptsTable : usersTable;

    const showDetail = view === 'changes' && selected !== null;

    return (
        <div className="history-panel">
            <Toast ref={toast} position="bottom-right" />

            <div className="panel-toolbar">
                <span className="panel-toolbar__label">
                    <VscHistory size={14} aria-hidden />
                    {t('panels:clusterHistory.label')}
                </span>
                <div className="panel-toolbar__actions">
                    <Segmented<View>
                        value={view}
                        onChange={(v) => { setView(v); setError(null); }}
                        ariaLabel={t('panels:clusterHistory.viewAria')}
                        options={viewOptions}
                    />
                    <RowAction icon={<VscRefresh size={14} />} label={t('panels:clusterHistory.refresh')} loading={refreshing} onClick={() => void fetchView(true)} />
                </div>
            </div>

            <div className="history-filters">
                {view === 'changes' && (
                    <InputText className="history-filters__search p-inputtext-sm" name="q" value={filters.q} onChange={onField}
                        placeholder={t('panels:clusterHistory.filter.search')} aria-label={t('panels:clusterHistory.filter.search')} />
                )}
                {view !== 'users' && (
                    <>
                        <InputText className="history-filters__field p-inputtext-sm" name="namespace" value={filters.namespace} onChange={onField}
                            placeholder={t('panels:clusterHistory.filter.namespace')} aria-label={t('panels:clusterHistory.filter.namespace')} />
                        <InputText className="history-filters__field p-inputtext-sm" name="resource" value={filters.resource} onChange={onField}
                            placeholder={t('panels:clusterHistory.filter.resource')} aria-label={t('panels:clusterHistory.filter.resource')} />
                        <InputText className="history-filters__field p-inputtext-sm" name="user" value={filters.user} onChange={onField}
                            placeholder={t('panels:clusterHistory.filter.user')} aria-label={t('panels:clusterHistory.filter.user')} />
                    </>
                )}
                {view === 'changes' && (
                    <Dropdown className="history-filters__select p-inputtext-sm" name="verb" value={filters.verb} options={verbOptions} placeholder={t('panels:clusterHistory.filter.anyVerb')}
                        onChange={onSelect} aria-label={t('panels:clusterHistory.col.verb')} />
                )}
                <Dropdown className="history-filters__select p-inputtext-sm" name="since" value={filters.since} options={sinceOptions}
                    onChange={onSelect} aria-label={t('panels:clusterHistory.filter.sinceAria')} />
            </div>

            {error && !loading && (view === 'changes' ? changes : view === 'attempts' ? attempts : users).length > 0 && (
                <ErrorBanner message={error} onRetry={() => void fetchView(true)} busy={refreshing} stale context={context} />
            )}

            <div className="pod-split history-split" ref={splitRef}>
                <div className="pod-split__list">{body}</div>
                {showDetail && (
                    <>
                        <div className="pod-split__handle" role="separator" aria-orientation="vertical" onPointerDown={startResize} />
                        <div className="pod-split__detail" style={{ width }}>
                            <ChangeDiff
                                key={selected}
                                clusterName={clusterName}
                                eventId={selected}
                                onClose={() => setSelected(null)}
                                onRolledBack={(msg) => {
                                    toast.current?.show({ severity: 'success', summary: t('panels:clusterHistory.rollback.done'), detail: msg, life: 3000 });
                                    // The rollback is itself a change toolbox
                                    // records; it lands after the enrich delay.
                                    setTimeout(() => setTick((n) => n + 1), 20_000);
                                }}
                            />
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
