import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { VscHistory, VscRefresh, VscDiscard } from 'react-icons/vsc';
import { GetToolboxChangeDetail, GetToolboxChanges, GetToolboxLiveObject } from '../../../../wailsjs/go/controller_app/App';
import { models } from '../../../../wailsjs/go/models';
import { errText } from '../../../lib/errText';
import { useSplitPane } from '../../../lib/useSplitPane';
import { usePanelActive } from '../../../lib/usePanelActive';
import { useT } from '../../../i18n/useT';
import { useToolboxStatus, useToolboxStatusStore } from '../../../stores/toolboxStatusStore';
import Segmented from '../../shared/Segmented';
import RowAction from '../../shared/RowAction';
import ErrorBanner from '../../shared/ErrorBanner';
import PanelLoading from '../../shared/PanelLoading';
import { ListSkeleton } from '../../shared/PanelSkeleton';
import { AgeCell, formatTime, verbLamp } from './format';
import YamlDiff from './YamlDiff';
import RollbackDialog from './RollbackDialog';
import { useRollbackFollowUp } from './useRollbackFollowUp';
import { historyUnavailable } from './HistoryButton';
import { GapText, useRecordingGaps } from './gaps';

export interface ObjectHistoryParams {
    clusterName: string;
    /** Plural resource, as toolbox records it ("deployments"). */
    resource: string;
    /** toolbox's group filter: "" for any group, "core" for the core group. */
    group: string;
    namespace: string;
    name: string;
}

const PAGE = 100;
const POLL_MS = 15_000;
const LIVE = 'live';
// "Restore this version" writes the object as it was after that change.
const RESTORE_SIDE = 'after';
const DIFF_HEIGHT_KEY = 'kube-ins:object-history-diff-height';
type Layout = 'side' | 'inline';

// Changes whose "after" is the object: a delete that only set the deletion
// timestamp has one too, but restoring it is not "going back" to anything.
const hasAfter = (c: models.ToolboxChange) => c.verb === 'create' || c.verb === 'update';

/**
 * One object's recorded timeline, newest first, with any two points of it —
 * or a point and the object as it is now — compared below.
 *
 * Every version shown is the restorable form (server-managed fields and
 * status left out), so a diff is exactly what "Restore this version" would
 * write. Lifecycles that share the name (deleted, then created again) stay in
 * one timeline with a divider where the UID changes.
 */
export default function ObjectHistoryPanel({ params, api }: IDockviewPanelProps<ObjectHistoryParams>) {
    const t = useT();
    const { clusterName, resource, group, namespace, name } = params;
    const active = usePanelActive(api);
    const toast = useRef<Toast>(null);
    const status = useToolboxStatus(clusterName);
    const ensureStatus = useToolboxStatusStore((s) => s.ensure);
    const { splitRef, width: diffHeight, startResize } = useSplitPane(DIFF_HEIGHT_KEY, 360, 140, 'y');

    const [items, setItems] = useState<models.ToolboxChange[]>([]);
    const [cursor, setCursor] = useState('');
    const [pages, setPages] = useState(1);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [a, setA] = useState<string | null>(null);
    const [b, setB] = useState<string | null>(null);
    const [details, setDetails] = useState<Record<string, models.ToolboxChangeDetail>>({});
    const [detailError, setDetailError] = useState<string | null>(null);
    const [live, setLive] = useState<models.ToolboxLiveObject | null>(null);
    const [liveError, setLiveError] = useState<string | null>(null);
    const [layout, setLayout] = useState<Layout>('side');
    const [restoring, setRestoring] = useState<models.ToolboxChange | null>(null);
    const reqId = useRef(0);

    useEffect(() => { ensureStatus(clusterName); }, [clusterName, ensureStatus]);

    const filter = (after = '') => models.ToolboxChangeFilter.createFrom({ resource, group, namespace, name, cursor: after, limit: PAGE });

    const load = useCallback(async (background: boolean) => {
        const id = ++reqId.current;
        if (background) setRefreshing(true); else setLoading(true);
        try {
            const page = await GetToolboxChanges(clusterName, filter());
            if (id !== reqId.current) return;
            const list = page.items ?? [];
            setItems(list);
            setCursor(page.nextCursor ?? '');
            setPages(1);
            setError(null);
            // First load: the newest change against the one before it, or
            // against the live object when there is only one.
            setB((prev) => prev ?? (list.length > 1 ? list[0].eventId : LIVE));
            setA((prev) => prev ?? (list.length > 1 ? list[1].eventId : list[0]?.eventId ?? null));
        } catch (e) {
            if (id === reqId.current) setError(errText(e));
        } finally {
            if (id === reqId.current) {
                setLoading(false);
                setRefreshing(false);
            }
        }
    }, [clusterName, resource, group, namespace, name]); // eslint-disable-line react-hooks/exhaustive-deps

    const loadMore = async () => {
        const id = ++reqId.current;
        setLoadingMore(true);
        try {
            const page = await GetToolboxChanges(clusterName, filter(cursor));
            if (id !== reqId.current) return;
            setItems((prev) => prev.concat(page.items ?? []));
            setCursor(page.nextCursor ?? '');
            setPages((n) => n + 1);
        } catch (e) {
            if (id === reqId.current) setError(errText(e));
        } finally {
            setLoadingMore(false);
        }
    };

    useEffect(() => { void load(false); }, [load]);
    useEffect(() => {
        if (!active || pages > 1) return;
        const h = setInterval(() => void load(true), POLL_MS);
        return () => clearInterval(h);
    }, [active, pages, load]);

    // The live object, addressed by the API version toolbox recorded so both
    // sides of a comparison are in the same version.
    const newest = items[0];
    const loadLive = useCallback(() => {
        if (!newest) return;
        setLiveError(null);
        GetToolboxLiveObject(clusterName, newest.group, newest.apiVersion, newest.resource, newest.namespace, newest.name)
            .then(setLive)
            .catch((e) => setLiveError(errText(e)));
    }, [clusterName, newest?.group, newest?.apiVersion, newest?.resource, newest?.namespace, newest?.name]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { loadLive(); }, [loadLive]);

    // Each picked version's YAML, fetched once.
    useEffect(() => {
        for (const id of [a, b]) {
            if (!id || id === LIVE || details[id]) continue;
            GetToolboxChangeDetail(clusterName, id)
                .then((d) => setDetails((prev) => ({ ...prev, [id]: d })))
                .catch((e) => setDetailError(errText(e)));
        }
    }, [a, b, clusterName, details]);

    const followUp = useRollbackFollowUp(() => void load(true), items);

    // Recording gaps over the span this timeline covers: a change made in
    // one would be missing here, so the timeline says where they are.
    const oldest = items.length ? items[items.length - 1].time : '';
    const gaps = useRecordingGaps(clusterName, oldest, '', active && !!oldest);
    // Each gap goes just above the first (newest-first) change older than it.
    const gapsBefore = (i: number) => gaps.filter((g) => {
        const from = Date.parse(g.from);
        const newer = i === 0 ? Infinity : Date.parse(items[i - 1].time);
        return from >= Date.parse(items[i].time) && from < newer;
    });

    const pickA = (id: string) => { setDetailError(null); setA(id); };
    const pickB = (id: string) => { setDetailError(null); setB(id); };
    const layoutOptions: { value: Layout; label: string }[] = [
        { value: 'side', label: t('panels:clusterHistory.compare.sideBySide') },
        { value: 'inline', label: t('panels:clusterHistory.compare.inline') },
    ];

    const byId = (id: string | null) => items.find((c) => c.eventId === id);
    const versionText = (id: string | null) => {
        if (id === LIVE) return live && !live.exists ? '' : live?.yaml ?? null;
        const d = id ? details[id] : undefined;
        return d ? d.afterRestorable : null;
    };
    const label = (id: string | null) => {
        if (id === LIVE) return t('panels:objectHistory.live');
        const c = byId(id);
        // The user too: several writes often land within the same second.
        return c ? t('panels:objectHistory.after', { verb: c.verb, user: c.actor?.username || c.fieldManager || '—', time: formatTime(c.time) }) : '';
    };
    const original = versionText(a);
    const modified = versionText(b);

    const title = `${newest?.kind ?? resource} · ${namespace ? `${namespace}/` : ''}${name}`;
    const unusable = historyUnavailable(t, status);

    const restoreMessage = (c: models.ToolboxChange) => t(
        live && !live.exists ? 'panels:objectHistory.restore.recreate' : 'panels:objectHistory.restore.message',
        { kind: c.kind, name: `${namespace ? `${namespace}/` : ''}${name}`, time: formatTime(c.time) },
    );

    const timeline = (
        <ol className="obj-tl" aria-label={t('panels:objectHistory.timelineAria')}>
            <li className="obj-tl__row obj-tl__row--head" aria-hidden>
                <span>A</span><span>B</span>
                <span>{t('panels:clusterHistory.col.time')}</span>
                <span>{t('panels:clusterHistory.col.verb')}</span>
                <span>{t('panels:clusterHistory.col.user')}</span>
                <span>{t('panels:clusterHistory.col.changed')}</span>
                <span />
            </li>
            <li className="obj-tl__row obj-tl__row--live">
                <span />
                <PickKey side="B" pressed={b === LIVE} label={t('panels:objectHistory.pickB', { version: t('panels:objectHistory.live') })} onPick={() => pickB(LIVE)} />
                <span className="obj-tl__live" title={liveError ?? undefined}>
                    {live === null ? '…' : live.exists ? t('panels:objectHistory.live') : t('panels:objectHistory.liveGone')}
                </span>
            </li>
            {items.map((c, i) => {
                const older = items[i + 1];
                const recreated = older && older.objectUid && c.objectUid && older.objectUid !== c.objectUid;
                const user = c.actor?.username || (c.fieldManager ? `(${c.fieldManager})` : '—');
                return (
                    <Fragment key={c.eventId}>
                        {gapsBefore(i).map((g) => (
                            <li key={`gap:${g.from}`} className="obj-tl__divider obj-tl__divider--gap"><GapText gap={g} /></li>
                        ))}
                        <li className={`obj-tl__row${followUp.found === c.eventId ? ' obj-tl__row--rolled' : ''}`}>
                            <PickKey side="A" pressed={a === c.eventId} label={t('panels:objectHistory.pickA', { version: label(c.eventId) })} onPick={() => pickA(c.eventId)} />
                            <PickKey side="B" pressed={b === c.eventId} label={t('panels:objectHistory.pickB', { version: label(c.eventId) })} onPick={() => pickB(c.eventId)} />
                            <span className="cell-mono"><AgeCell iso={c.time} /></span>
                            <span>{verbLamp(c.verb)}</span>
                            <span className="obj-tl__clip" title={user}>{user}</span>
                            <span className="obj-tl__clip cell-mono" title={(c.changedPaths ?? []).join('\n')}>{(c.changedPaths ?? []).slice(0, 3).join('  ')}</span>
                            <span className="obj-tl__action">
                                {hasAfter(c) && (
                                    <Button label={t('panels:objectHistory.restore.button')} icon={<VscDiscard size={13} />} text size="small"
                                        disabled={c.group === '' && c.resource === 'secrets'}
                                        tooltip={c.group === '' && c.resource === 'secrets' ? t('panels:clusterHistory.rollback.blocked.secretRedacted') : undefined}
                                        tooltipOptions={{ showOnDisabled: true }}
                                        onClick={() => setRestoring(c)} />
                                )}
                            </span>
                        </li>
                        {recreated && (
                            <li className="obj-tl__divider">
                                {t('panels:objectHistory.recreated', { from: older.objectUid.slice(0, 8), to: c.objectUid.slice(0, 8) })}
                            </li>
                        )}
                    </Fragment>
                );
            })}
        </ol>
    );

    const diff = original === null || modified === null ? (
        detailError ? <ErrorBanner block message={detailError} cluster={clusterName} context={title} /> : <PanelLoading />
    ) : original === modified ? (
        <div className="history-detail__note obj-history__same">{t('panels:clusterHistory.note.identical')}</div>
    ) : (
        <YamlDiff original={original} modified={modified} sideBySide={layout === 'side'} />
    );

    return (
        <div className="history-panel obj-history">
            <Toast ref={toast} position="bottom-right" />
            <div className="panel-toolbar">
                <span className="panel-toolbar__label" title={title}>
                    <VscHistory size={14} aria-hidden />
                    <span className="cell-clip">{title}</span>
                </span>
                <div className="panel-toolbar__actions">
                    {followUp.waiting && <span className="obj-history__waiting">{t('panels:objectHistory.waiting')}</span>}
                    <Button label={t('panels:objectHistory.compareLive')} text size="small" disabled={b === LIVE} onClick={() => pickB(LIVE)} />
                    <RowAction icon={<VscRefresh size={14} />} label={t('panels:clusterHistory.refresh')} loading={refreshing}
                        onClick={() => { void load(true); loadLive(); }} />
                </div>
            </div>

            {unusable ? (
                <ErrorBanner block message={status?.detail ? `${unusable} ${status.detail}` : unusable} cluster={clusterName} context={title} />
            ) : loading ? (
                <ListSkeleton />
            ) : error && items.length === 0 ? (
                <ErrorBanner block message={error} onRetry={() => void load(false)} busy={refreshing} cluster={clusterName} context={title} />
            ) : items.length === 0 ? (
                <div className="rlv-empty"><span>{t('panels:objectHistory.empty')}</span></div>
            ) : (
                <div className="obj-history__split" ref={splitRef}>
                    <div className="obj-history__timeline">
                        {error && <ErrorBanner message={error} onRetry={() => void load(true)} busy={refreshing} stale context={title} />}
                        {timeline}
                        {cursor && (
                            <div className="history-list__more">
                                <Button label={t('panels:clusterHistory.loadMore')} text size="small" loading={loadingMore} onClick={() => void loadMore()} />
                            </div>
                        )}
                    </div>
                    <div className="obj-history__handle" role="separator" aria-orientation="horizontal" onPointerDown={startResize} />
                    <div className="obj-history__diff" style={{ height: diffHeight }}>
                        <div className="history-detail__controls">
                            <span className="obj-history__labels">
                                <span><b>A</b> {label(a)}</span>
                                <span><b>B</b> {label(b)}</span>
                            </span>
                            <span className="history-detail__spacer" />
                            <Segmented<Layout> value={layout} onChange={setLayout} ariaLabel={t('panels:clusterHistory.compare.layoutAria')} options={layoutOptions} />
                        </div>
                        <div className="history-diff dark-display">{diff}</div>
                    </div>
                </div>
            )}

            {restoring && (
                <RollbackDialog
                    visible
                    clusterName={clusterName}
                    eventId={restoring.eventId}
                    side={RESTORE_SIDE}
                    header={t('panels:clusterHistory.rollback.header', { name })}
                    message={restoreMessage(restoring)}
                    onHide={() => setRestoring(null)}
                    onDone={(out, at) => {
                        toast.current?.show({ severity: 'success', summary: t('panels:clusterHistory.rollback.done'), detail: out, life: 3000 });
                        // Show the result: the restored version against the
                        // object as it is now should read "no differences".
                        setA(restoring.eventId);
                        setB(LIVE);
                        loadLive();
                        followUp.follow({ at, resource: restoring.resource, namespace: restoring.namespace, name: restoring.name });
                    }}
                />
            )}
        </div>
    );
}

/** One of a row's two "compare this version" keys. */
function PickKey({ side, pressed, label, onPick }: { side: 'A' | 'B'; pressed: boolean; label: string; onPick: () => void }) {
    return (
        <button type="button" className="obj-tl__pick" aria-pressed={pressed} aria-label={label} title={label} onClick={onPick}>
            {side}
        </button>
    );
}
