import { useEffect, useMemo, useRef, useState } from 'react';

import { VscWarning, VscClearAll } from 'react-icons/vsc';
import { DataTable, DataTableFilterMeta } from 'primereact/datatable';
import { Column } from 'primereact/column';
import StatusLamp from '../shared/StatusLamp';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { MultiSelect } from 'primereact/multiselect';
import { ColumnFilterElementTemplateOptions } from 'primereact/column';
import type { DockviewPanelApi } from 'dockview';
import { GetEvents } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useEventsStore, defaultEventFilters } from '../../stores/eventsStore';
import { usePanelActive } from '../../lib/usePanelActive';
import { useDeferredMount } from '../../lib/useDeferredMount';
import { errText } from '../../lib/errText';
import ErrorBanner from '../shared/ErrorBanner';
import { ListSkeleton } from '../shared/PanelSkeleton';
import { ROW_HEIGHT } from '../../lib/tableMetrics';
import { useT } from '../../i18n/useT';
import CountCell from '../shared/CountCell';

type TagSeverity = 'success' | 'info' | 'warning' | 'danger' | 'secondary' | 'contrast';

const getTypeSeverity = (type: string): TagSeverity => {
    switch (type) {
        case 'Warning': return 'warning';
        // A normal event reports nothing about health: an idle ring, not a green lamp.
        case 'Normal':  return 'secondary';
        default:        return 'secondary';
    }
};

// Stable empty array so the store selector returns a consistent reference
// before a tab snapshot exists (avoids needless re-renders).
const EMPTY_EVENTS: models.EventInfo[] = [];

const formatTime = (ts: string): string => {
    if (!ts) return '-';
    try {
        return new Date(ts).toLocaleString();
    } catch {
        return ts;
    }
};

export default function EventListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    // Whether this panel is the foreground tab. When backgrounded we tear down
    // the table DOM and pause polling; the latest data lives in the persisted
    // store, so returning to the foreground rebuilds instantly from it.
    const active = usePanelActive(api);
    // Lazily mount the heavy DataTable a couple of frames after the tab paints,
    // so switching to this tab feels instant instead of janking on a big render.
    const showTable = useDeferredMount(active);

    // Persisted, per-cluster tab snapshot (events, filters, warningOnly). Reading
    // from the store on mount is what restores the tab "where it left off"; every
    // write below is auto-persisted to disk by the store's persist middleware.
    const storeKey = `events:${clusterName}`;
    const tab = useEventsStore((s) => s.tabs[storeKey]);
    const patchTab = useEventsStore((s) => s.patchTab);

    const events = tab?.events ?? EMPTY_EVENTS;
    const filters = tab?.filters ?? defaultEventFilters();
    const warningOnly = tab?.warningOnly ?? false;

    const setEvents = (next: models.EventInfo[]) => patchTab(storeKey, { events: next });
    const setFilters = (next: DataTableFilterMeta) => patchTab(storeKey, { filters: next });
    const setWarningOnly = (next: boolean) => patchTab(storeKey, { warningOnly: next });

    const namespaceOptions = useMemo(() =>
        [...new Set(events.map(e => e.namespace).filter(Boolean))].sort().map(v => ({ label: v, value: v })),
        [events]
    );
    const typeOptions = useMemo(() =>
        [...new Set(events.map(e => e.type).filter(Boolean))].sort().map(v => ({ label: v, value: v })),
        [events]
    );
    const reasonOptions = useMemo(() =>
        [...new Set(events.map(e => e.reason).filter(Boolean))].sort().map(v => ({ label: v, value: v })),
        [events]
    );
    const objectKindOptions = useMemo(() =>
        [...new Set(events.map(e => e.object_kind).filter(Boolean))].sort().map(v => ({ label: v, value: v })),
        [events]
    );
    const objectOptions = useMemo(() =>
        [...new Set(events.map(e => e.object).filter(Boolean))].sort().map(v => ({ label: v, value: v })),
        [events]
    );
    const [selectedEvent, setSelectedEvent] = useState<models.EventInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);

    // PrimeReact's VirtualScroller captures its viewport height once at init()
    // time. With scrollHeight="flex" that height is purely CSS-flex-derived and
    // the scroller only re-measures on a *window* resize whose pixel height
    // differs — so inside a Dockview panel it often measures once (before data
    // arrives) and the table stays empty until the window is resized. Feeding an
    // explicit measured pixel height (via ResizeObserver, which unlike
    // window.resize also fires on tab show / splitter drags) and remounting once
    // a real height exists forces a correct init. Mirrors ResourceListView.
    const tableWrapRef = useRef<HTMLDivElement>(null);
    const [scrollHeight, setScrollHeight] = useState<string>('flex');
    useEffect(() => {
        if (!active) return;
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
    }, [active, showTable]);

    const loadEvents = async () => {
        setRefreshing(true);
        try {
            const items = await GetEvents(clusterName);
            setEvents(items.map((item: any) => models.EventInfo.createFrom(item)));
            setError(null);
        } catch (e) {
            // Keep the last persisted snapshot on a transient fetch failure so the
            // tab still shows where it left off instead of going blank. Until S8
            // that failure was invisible; now the banner says the rows are stale.
            console.error('Failed to load events:', e);
            setError(errText(e));
        } finally {
            setRefreshing(false);
        }
    };

    useEffect(() => {
        if (!active) return;
        loadEvents();
        const intervalId = window.setInterval(loadEvents, 5000);
        return () => window.clearInterval(intervalId);
    }, [active]);

    // Backgrounded: render nothing heavy so the table DOM is released. The full
    // UI is rebuilt from the persisted store the moment the tab is reactivated.
    if (!active) {
        return <div style={{ height: '100%' }} />;
    }

    const displayedEvents = warningOnly
        ? events.filter(e => e.type === 'Warning')
        : events;

    const ev = selectedEvent;

    return (
        <div className="rlv-root">
            <div className="rlv-toolbar">
                <h3 className="rlv-toolbar__title">{t('panels:events.title')}</h3>
                {showTable && !(error && events.length === 0) && (
                    <span className="rlv-toolbar__count">{displayedEvents.length}</span>
                )}
                <div className="rlv-toolbar__actions">
                    <Button
                        label={t('panels:events.warningsOnly')}
                        icon={<VscWarning size={16} />}
                        text
                        severity={warningOnly ? 'warning' : 'secondary'}
                        onClick={() => setWarningOnly(!warningOnly)}
                        tooltip={t('panels:events.warningsOnlyTooltip')}
                        tooltipOptions={{ position: 'left' }}
                    />
                    <Button
                        icon={<VscClearAll size={16} />}
                        text
                        severity="secondary"
                        aria-label={t('action.clearFilters')}
                        onClick={() => setFilters(defaultEventFilters())}
                        tooltip={t('action.clearFilters')}
                        tooltipOptions={{ position: 'left' }}
                    />
                </div>
            </div>

            {events.length > 0 && (
                <ErrorBanner
                    message={error}
                    onRetry={loadEvents}
                    busy={refreshing}
                    stale
                    context={`Events (${clusterName})`}
                />
            )}

            <div ref={tableWrapRef} className="ktable-fill">
            {!showTable ? (
                <ListSkeleton />
            ) : error && events.length === 0 ? (
                <ErrorBanner
                    block
                    message={error}
                    onRetry={loadEvents}
                    busy={refreshing}
                    cluster={clusterName}
                    context={`Events (${clusterName})`}
                />
            ) : (
            <DataTable
                // Remount once a measured pixel height is available so the virtual
                // scroller re-runs init() with a real viewport height (see note above).
                key={scrollHeight === 'flex' ? 'measuring' : 'measured'}
                value={displayedEvents}
                dataKey="name"
                filters={filters}
                onFilter={(e) => setFilters(e.filters)}
                filterDisplay="row"
                resizableColumns
                scrollable
                scrollHeight={scrollHeight}
                virtualScrollerOptions={{ itemSize: ROW_HEIGHT }}
                emptyMessage={<div className="rlv-empty"><span>{t('panels:events.empty')}</span></div>}
                sortField="last_timestamp"
                sortOrder={-1}
                onRowDoubleClick={(e: any) => setSelectedEvent(e.data as models.EventInfo)}
            >
                <Column
                    field="type"
                    header={t('resources:column.type')}
                    sortable
                    filter
                    filterField="type"
                    showFilterMenu={false}
                    style={{ minWidth: '8rem' }}
                    body={(row: models.EventInfo) => (
                        <StatusLamp label={row.type || '-'} severity={getTypeSeverity(row.type)} />
                    )}
                    filterElement={(options: ColumnFilterElementTemplateOptions) => (
                        <MultiSelect value={options.value} options={typeOptions} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                    )}
                />
                <Column
                    field="namespace"
                    header={t('resources:column.namespace')}
                    sortable
                    filter
                    filterField="namespace"
                    showFilterMenu={false}
                    style={{ minWidth: '10rem' }}
                    filterElement={(options: ColumnFilterElementTemplateOptions) => (
                        <MultiSelect value={options.value} options={namespaceOptions} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                    )}
                />
                <Column
                    field="object_kind"
                    header={t('resources:column.kind')}
                    sortable
                    filter
                    filterField="object_kind"
                    showFilterMenu={false}
                    style={{ minWidth: '9rem' }}
                    filterElement={(options: ColumnFilterElementTemplateOptions) => (
                        <MultiSelect value={options.value} options={objectKindOptions} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                    )}
                />
                <Column
                    field="object"
                    header={t('resources:column.object')}
                    sortable
                    filter
                    filterField="object"
                    showFilterMenu={false}
                    style={{ minWidth: '14rem' }}
                    filterElement={(options: ColumnFilterElementTemplateOptions) => (
                        <MultiSelect value={options.value} options={objectOptions} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                    )}
                />
                <Column
                    field="reason"
                    header={t('resources:column.reason')}
                    sortable
                    filter
                    filterField="reason"
                    showFilterMenu={false}
                    style={{ minWidth: '11rem' }}
                    filterElement={(options: ColumnFilterElementTemplateOptions) => (
                        <MultiSelect value={options.value} options={reasonOptions} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                    )}
                />
                <Column
                    field="message"
                    header={t('resources:column.message')}
                    filter
                    filterField="message"
                    filterPlaceholder={t('resources:filter.searchMessage')}
                    showFilterMenu={false}
                    style={{ minWidth: '22rem' }}
                    body={(row: models.EventInfo) => {
                        const msg = row.message || '';
                        const truncated = msg.length > 40 ? msg.slice(0, 40) + '…' : msg;
                        return (
                            <span className={`event-msg${row.type === 'Warning' ? ' event-msg--warn' : ''}`}>
                                {truncated}
                            </span>
                        );
                    }}
                />
                <Column
                    field="count"
                    header={t('resources:column.count')}
                    sortable
                    style={{ minWidth: '6rem' }}
                    body={(row: models.EventInfo) => (
                        row.count > 1
                            ? <CountCell value={String(row.count)} />
                            : <span>{row.count}</span>
                    )}
                />
                <Column
                    field="last_timestamp"
                    header={t('resources:column.lastSeen')}
                    sortable
                    style={{ minWidth: '13rem' }}
                    body={(row: models.EventInfo) => formatTime(row.last_timestamp)}
                />
            </DataTable>
            )}
            </div>

            <Dialog
                header={
                    <div className="dlg-title-row">
                        {ev && <StatusLamp label={ev.type} severity={getTypeSeverity(ev.type)} />}
                        <span>{ev?.reason}</span>
                    </div>
                }
                visible={!!selectedEvent}
                className="event-dialog"
                modal
                onHide={() => setSelectedEvent(null)}
            >
                {ev && (
                    <>
                        <dl className="dlg-facts">
                            <dt>Namespace</dt><dd>{ev.namespace}</dd>
                            <dt>{t('resources:column.object')}</dt><dd>{ev.object_kind} / {ev.object}</dd>
                            <dt>{t('resources:column.reason')}</dt><dd>{ev.reason}</dd>
                            <dt>{t('resources:column.count')}</dt><dd>{ev.count}</dd>
                            <dt>{t('panels:events.firstSeen')}</dt><dd>{formatTime(ev.first_timestamp)}</dd>
                            <dt>{t('resources:column.lastSeen')}</dt><dd>{formatTime(ev.last_timestamp)}</dd>
                        </dl>
                        <h3 className="dlg-section">{t('resources:column.message')}</h3>
                        <div className={`event-message${ev.type === 'Warning' ? ' event-message--warn' : ''}`}>
                            {ev.message || '-'}
                        </div>
                    </>
                )}
            </Dialog>
        </div>
    );
}
