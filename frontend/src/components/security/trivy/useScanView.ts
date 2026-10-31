import { useCallback, useEffect, useRef, useState } from 'react';
import { TrivyGetScanView, TrivyListScans } from '../../../../wailsjs/go/controller_app/App';
import { models } from '../../../../wailsjs/go/models';
import { errText } from '../../../lib/errText';
import { useTrivyState, useTrivyStore } from '../../../stores/trivyStore';
import { defaultCompareId } from './trivyModel';

/**
 * The saved scans of a cluster and the computed view of the selected one.
 *
 * Selection lives in the trivy store: `scanId` null follows the newest scan,
 * `compareId` null compares with the scan before it, and `''` means the user
 * chose no comparison.
 */
export function useScanView(clusterName: string) {
    const st = useTrivyState(clusterName);
    const patch = useTrivyStore((s) => s.patch);
    const [scans, setScans] = useState<models.TrivyScanMeta[] | null>(null);
    const [view, setView] = useState<models.TrivyScanView | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    /** A neutral notice in place of a load error (a scan that ended unseen). */
    const [notice, setNotice] = useState('');
    // A scan that ended before this panel subscribed: a failure to load it
    // means it was cancelled or failed rather than that something is broken.
    const lateId = useRef<string | null>(null);
    const [reloadTick, setReloadTick] = useState(0);

    const listScans = useCallback(async () => {
        try {
            const list = (await TrivyListScans(clusterName)) ?? [];
            setScans(list);
            return list;
        } catch (e) {
            setScans([]);
            setError(errText(e));
            return [];
        }
    }, [clusterName]);

    useEffect(() => { void listScans(); }, [listScans]);

    const scanId = st.scanId ?? scans?.[0]?.id ?? null;
    const compareId = st.compareId ?? (scanId && scans ? defaultCompareId(scans, scanId) : '');

    useEffect(() => {
        if (!scanId) { setView(null); return; }
        let alive = true;
        setLoading(true);
        TrivyGetScanView(clusterName, scanId, compareId)
            .then((v) => {
                if (!alive) return;
                setView(v);
                setError('');
                setNotice('');
            })
            .catch((e) => {
                if (!alive) return;
                if (lateId.current === scanId) {
                    setNotice('ended');
                    patch(clusterName, { scanId: null, compareId: null });
                } else {
                    setError(errText(e));
                }
            })
            .finally(() => {
                if (!alive) return;
                if (lateId.current === scanId) lateId.current = null;
                setLoading(false);
            });
        return () => { alive = false; };
    }, [clusterName, scanId, compareId, reloadTick, patch]);

    /** Re-read the selected scan's view (after an exception was added or removed). */
    const reload = useCallback(() => setReloadTick((n) => n + 1), []);

    /** Show a scan that just finished (or ended before this panel saw it). */
    const showFinished = useCallback(async (id: string, late: boolean) => {
        if (late) lateId.current = id;
        await listScans();
        setNotice('');
        patch(clusterName, { scanId: id, compareId: null });
    }, [clusterName, listScans, patch]);

    const select = (id: string) => patch(clusterName, { scanId: id, compareId: null, selectedFix: null });
    const compare = (id: string) => patch(clusterName, { compareId: id });

    return { scans, scanId, compareId, view, loading, error, notice, reload, showFinished, select, compare };
}
