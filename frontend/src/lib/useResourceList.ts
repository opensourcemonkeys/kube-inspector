import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DockviewPanelApi } from 'dockview';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Toast } from 'primereact/toast';
import { usePanelActive } from './usePanelActive';
import { usePayloadSignature } from './usePayloadSignature';
import { errText } from './errText';
import { useT } from '../i18n/useT';
import { TOAST_LIFE } from './toast';

/** Minimal shape every list row shares. Namespace is absent for cluster-scoped resources. */
export interface ResourceRow {
    name: string;
    namespace?: string;
    /**
     * Row identity for the DataTable. Names repeat across namespaces, and
     * PrimeReact compares selection by `dataKey` alone — keying on `name`
     * made one checkbox tick every same-named row (and made clicking the
     * second one *un*-tick the first). Injected by `reload` rather than by
     * each view's `createFrom` so no list can forget it.
     */
    __rowKey?: string;
}

/**
 * Per-delete switches a kind's dialog offers (a pod's force / grace period 0).
 * Every one starts unticked each time the dialog opens, and is handed to the
 * deleter as its fourth argument; deleters that offer none ignore it.
 */
export type DeleteFlags = Record<string, boolean>;

export interface UseResourceListOptions<T extends ResourceRow> {
    clusterName: string;
    /** Wails binding that returns the raw list, e.g. GetPods. */
    fetcher: (clusterName: string) => Promise<any[]>;
    /** Deserializer, e.g. models.PodInfo.createFrom. */
    createFrom: (raw: any) => T;
    /** Wails delete binding, e.g. DeletePod. When provided, the delete flow is enabled. */
    deleter?: (clusterName: string, name: string, namespace: string, flags: DeleteFlags) => Promise<void>;
    /** Human label used in delete toasts/dialog, e.g. "pod". */
    deleteLabel?: string;
    defaultFilters: DataTableFilterMeta;
    /** Poll interval in ms (default 2000). */
    pollInterval?: number;
    /**
     * Dockview panel api; when supplied, polling pauses while the tab is
     * backgrounded. Polling also pauses whenever the window itself is hidden
     * or minimised, with or without an api — see `usePanelActive`.
     */
    api?: DockviewPanelApi;
}

export interface UseResourceListResult<T extends ResourceRow> {
    items: T[];
    /**
     * Message from the last failed fetch, or null when the last fetch worked.
     * Non-null with a non-empty `items` means the rows on screen are stale, not
     * gone — see the note in `reload`.
     */
    error: string | null;
    /** True until the very first fetch settles (success or failure). */
    loading: boolean;
    /** True while any fetch is in flight, including background polls. */
    refreshing: boolean;
    selected: T[];
    setSelected: (rows: T[]) => void;
    filters: DataTableFilterMeta;
    setFilters: (f: DataTableFilterMeta) => void;
    deleting: boolean;
    deleteDialogVisible: boolean;
    deleteFlags: DeleteFlags;
    setDeleteFlags: (flags: DeleteFlags) => void;
    openDeleteDialog: () => void;
    closeDeleteDialog: () => void;
    handleDeleteSelected: () => Promise<void>;
    reload: () => Promise<void>;
    toastRef: React.RefObject<Toast>;
    /**
     * Builds unique IN-filter options ({label,value}) for a given row field.
     * Array-valued fields are flattened, so they work with the `ARRAY_IN`
     * match mode from `lib/tableFilters`.
     */
    buildInOptions: (field: keyof T) => { label: string; value: string }[];
}

export function useResourceList<T extends ResourceRow>(
    options: UseResourceListOptions<T>,
): UseResourceListResult<T> {
    const t = useT();
    const {
        clusterName,
        fetcher,
        createFrom,
        deleter,
        deleteLabel = 'resource',
        defaultFilters,
        pollInterval = 2000,
        api,
    } = options;

    const [items, setItems] = useState<T[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [selected, setSelected] = useState<T[]>([]);
    const [deleteDialogVisible, setDeleteDialogVisible] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteFlags, setDeleteFlags] = useState<DeleteFlags>({});
    const [filters, setFilters] = useState<DataTableFilterMeta>(defaultFilters);
    const toastRef = useRef<Toast>(null);
    const active = usePanelActive(api);
    // An unchanged poll must not re-render the table — see usePayloadSignature.
    const payload = usePayloadSignature();

    const reload = useCallback(async () => {
        setRefreshing(true);
        try {
            const data = await fetcher(clusterName);
            if (!payload.changed(data)) {
                // Same rows as last tick: leave `items` (and every identity
                // derived from it) exactly as it is.
                setError(null);
                return;
            }
            const rows = data.map(createFrom);
            // Stamped in place, not mapped into a new object literal: `createFrom`
            // returns model class instances (models.PodInfo …) that spreading
            // would flatten. The `namespace ?` guard covers both `undefined` and
            // the `''` Go serializes for cluster-scoped kinds.
            for (const row of rows) {
                row.__rowKey = row.namespace ? `${row.namespace}/${row.name}` : row.name;
            }
            setItems(rows);
            setError(null);
        } catch (e) {
            // The rows are deliberately left alone: the last good ones stay on
            // screen so a transient poll failure cannot blank a table someone is
            // reading, and the banner is what says the data is stale. Emptying
            // them here is what used to make an RBAC 403, a dead API server and
            // a genuinely empty namespace all render the same "No pods found"
            // (beta-plan S8).
            console.error(`Failed to load ${deleteLabel} list:`, e);
            setError(errText(e));
        } finally {
            setLoaded(true);
            setRefreshing(false);
        }
    }, [clusterName, fetcher, createFrom, deleteLabel, payload]);

    // A cluster switch invalidates the signature: the next payload must be
    // applied even if the new cluster happens to serialize identically.
    useEffect(() => {
        payload.reset();
    }, [clusterName, fetcher, payload]);

    useEffect(() => {
        if (!active) return;
        reload();
        const intervalId = window.setInterval(reload, pollInterval);
        return () => window.clearInterval(intervalId);
    }, [active, pollInterval, reload]);

    const openDeleteDialog = useCallback(() => {
        if (selected.length === 0) return;
        setDeleteFlags({});
        setDeleteDialogVisible(true);
    }, [selected]);

    const closeDeleteDialog = useCallback(() => {
        if (!deleting) setDeleteDialogVisible(false);
    }, [deleting]);

    const handleDeleteSelected = useCallback(async () => {
        if (!deleter || selected.length === 0) {
            setDeleteDialogVisible(false);
            return;
        }

        setDeleting(true);
        const toDelete = [...selected];

        for (const row of toDelete) {
            // The resource's own name is data, so it is interpolated rather
            // than translated — only the sentence around it comes from the
            // catalog.
            const target = `${row.namespace ? `${row.namespace}/` : ''}${row.name}`;
            try {
                await deleter(clusterName, row.name, row.namespace ?? '', deleteFlags);
                toastRef.current?.show({
                    severity: 'success',
                    summary: t('resources:delete.toast.successSummary'),
                    detail: t('resources:delete.toast.successDetail', { target }),
                    life: TOAST_LIFE.success,
                });
            } catch {
                toastRef.current?.show({
                    severity: 'error',
                    summary: t('resources:delete.toast.failSummary'),
                    detail: t('resources:delete.toast.failDetail', { target }),
                    life: TOAST_LIFE.error,
                });
            }
        }

        setSelected([]);
        setDeleteDialogVisible(false);
        setDeleting(false);
        await reload();
    }, [deleter, selected, deleteFlags, clusterName, reload, t]);

    // Per-field cache of the last option array handed out, keyed by the sorted
    // values themselves. `items` gets a brand new array identity on every poll
    // even when nothing changed, so without this every MultiSelect in every open
    // panel receives a new `options` array (and re-renders) twice a second.
    const optionsCache = useRef(new Map<keyof T, { sig: string; options: { label: string; value: string }[] }>());

    const buildInOptions = useCallback(
        (field: keyof T) => {
            // Array-valued fields (access_modes, external_ips, the synthetic
            // _hosts …) are flattened; scalar fields behave as before.
            const set = new Set<string>();
            for (const item of items) {
                const value = item[field] as unknown;
                for (const entry of Array.isArray(value) ? value : [value]) {
                    if (entry != null && entry !== '') set.add(String(entry));
                }
            }
            const values = [...set].sort();
            // NUL cannot occur in a Kubernetes field value, so it is a safe
            // separator: no two distinct value sets can share a signature.
            const sig = values.join('\u0000');
            const cached = optionsCache.current.get(field);
            if (cached && cached.sig === sig) return cached.options;
            const options = values.map((v) => ({ label: v, value: v }));
            optionsCache.current.set(field, { sig, options });
            return options;
        },
        [items],
    );

    return useMemo(
        () => ({
            items,
            error,
            loading: !loaded,
            refreshing,
            selected,
            setSelected,
            filters,
            setFilters,
            deleting,
            deleteDialogVisible,
            deleteFlags,
            setDeleteFlags,
            openDeleteDialog,
            closeDeleteDialog,
            handleDeleteSelected,
            reload,
            toastRef,
            buildInOptions,
        }),
        [
            items,
            error,
            loaded,
            refreshing,
            selected,
            filters,
            deleting,
            deleteDialogVisible,
            deleteFlags,
            openDeleteDialog,
            closeDeleteDialog,
            handleDeleteSelected,
            reload,
            buildInOptions,
        ],
    );
}
