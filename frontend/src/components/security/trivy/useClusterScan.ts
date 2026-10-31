import { useEffect, useRef, useState } from 'react';
import { EventsOn } from '../../../../wailsjs/runtime/runtime';
import {
    TrivyStartClusterScan,
    TrivyStopClusterScan,
    TrivyGetRunningScan,
} from '../../../../wailsjs/go/controller_app/App';
import { models } from '../../../../wailsjs/go/models';
import { useT } from '../../../i18n/useT';
import { errText } from '../../../lib/errText';

export type PushToast = (severity: 'success' | 'warn' | 'error', summary: string, detail?: string) => void;

/** How a followed scan ended; `late` when it was already over by the time this panel subscribed. */
export type ScanEnd =
    | { kind: 'done'; id: string; late: boolean }
    | { kind: 'error'; id: string; message: string }
    | { kind: 'cancelled'; id: string };

const IMAGE_PHASES = new Set(['images', 'waitingCache', 'stopping']);

/**
 * Follows the cluster's backend scan by id: starts or re-attaches to it,
 * shows its progress and reports how it ended through `onEnd`. The result
 * itself is not loaded here — a finished scan is in the history, and the
 * screen loads its view like any other saved scan.
 *
 * Three guards carried over from the first backend-scan screen:
 *  - a handler acts only while its id is the active one, so a late event from
 *    an earlier scan (or a second end event) changes nothing;
 *  - the end is taken exactly once, whichever of the end event or the
 *    post-subscribe check gets there first (`finish`);
 *  - once "stopping" is seen it stays latched until the scan ends: the image
 *    in flight still reports "images" progress, which must not re-enable Stop.
 */
export function useClusterScan(clusterName: string, pushToast: PushToast, onEnd: (end: ScanEnd) => void) {
    const t = useT();
    const [running, setRunning] = useState(false);
    const [stopping, setStopping] = useState(false);
    const [line, setLine] = useState('');
    const [percent, setPercent] = useState<number | null>(null);
    const [error, setError] = useState('');

    const activeId = useRef<string | null>(null);
    const unsubscribe = useRef<(() => void) | null>(null);
    const stopLatched = useRef(false);
    const lastProgress = useRef<models.TrivyScanProgress | null>(null);
    // The latest callback, so an event registered by an earlier render does
    // not call a stale one.
    const onEndRef = useRef(onEnd);
    onEndRef.current = onEnd;

    const detach = () => {
        unsubscribe.current?.();
        unsubscribe.current = null;
        activeId.current = null;
    };

    const progressLine = (p: models.TrivyScanProgress): string => {
        switch (p.phase) {
            case 'targets': return t('panels:trivy.logListing');
            case 'misconfig': return p.message || t('panels:trivy.logStartK8s');
            case 'images':
                return `${t('panels:trivy.logScanning', { image: p.message, current: p.current, total: p.total })}${p.current === 1 ? ` ${t('panels:trivy.logFirstRun')}` : ''}`;
            case 'waitingCache': return t('panels:trivy.logWaitingCache', { image: p.message });
            case 'enrich': return t('panels:trivy.logEnrich');
            case 'saving': return t('panels:trivy.logSaving');
            case 'stopping': return t('panels:trivy.logStopping');
            default: return p.message;
        }
    };

    const showProgress = (p: models.TrivyScanProgress) => {
        lastProgress.current = p;
        if (p.phase === 'stopping') stopLatched.current = true;
        setStopping(stopLatched.current);
        setLine(stopLatched.current && p.phase !== 'stopping' ? t('panels:trivy.logStopping') : progressLine(p));
        setPercent(IMAGE_PHASES.has(p.phase) && p.total > 0 ? Math.round((p.current / p.total) * 100) : null);
    };

    const ended = () => {
        stopLatched.current = false;
        lastProgress.current = null;
        setRunning(false);
        setStopping(false);
        setPercent(null);
    };

    const finish = (id: string): boolean => {
        if (activeId.current !== id) return false;
        detach();
        ended();
        return true;
    };

    const attach = (id: string) => {
        detach();
        activeId.current = id;
        stopLatched.current = false;
        const offs = [
            EventsOn(`trivy:scan:progress:${id}`, (p: models.TrivyScanProgress) => {
                if (activeId.current === id) showProgress(p);
            }),
            EventsOn(`trivy:scan:done:${id}`, () => {
                if (!finish(id)) return;
                setLine('');
                onEndRef.current({ kind: 'done', id, late: false });
            }),
            EventsOn(`trivy:scan:error:${id}`, (err: string) => {
                if (!finish(id)) return;
                setLine('');
                setError(err);
                pushToast('error', t('panels:trivy.toastK8sFailed'), err);
                onEndRef.current({ kind: 'error', id, message: err });
            }),
            EventsOn(`trivy:scan:cancelled:${id}`, () => {
                if (!finish(id)) return;
                setLine(t('panels:trivy.logCancelled'));
                onEndRef.current({ kind: 'cancelled', id });
            }),
        ];
        unsubscribe.current = () => offs.forEach((off) => off());
        setRunning(true);
        setStopping(false);
    };

    // A short scan can end between TrivyStartClusterScan returning and the
    // subscription above, so check once after subscribing. If it is no longer
    // running it ended unseen: done if it was saved, otherwise cancelled or
    // failed — the screen sorts that out when it tries to load it.
    const reconcile = async (id: string) => {
        const running = await TrivyGetRunningScan(clusterName);
        if (activeId.current !== id) return;
        if (running && running.scanId === id) {
            showProgress(running.progress);
            return;
        }
        if (!finish(id)) return;
        setLine('');
        onEndRef.current({ kind: 'done', id, late: true });
    };

    // Re-attach to a scan already running for this cluster (the panel was
    // closed and reopened, or another panel started it).
    useEffect(() => {
        let alive = true;
        TrivyGetRunningScan(clusterName)
            .then((running) => {
                if (!alive || !running || activeId.current) return;
                attach(running.scanId);
                showProgress(running.progress);
            })
            .catch(() => { /* no running scan to show */ });
        return () => { alive = false; detach(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clusterName]);

    const start = async () => {
        setRunning(true);
        setStopping(false);
        setError('');
        setPercent(null);
        setLine(t('panels:trivy.logListing'));
        try {
            const id = await TrivyStartClusterScan(clusterName);
            attach(id);
            await reconcile(id);
        } catch (e) {
            detach();
            ended();
            setLine('');
            setError(errText(e));
            pushToast('error', t('panels:trivy.toastK8sFailed'), errText(e));
        }
    };

    const stop = () => {
        const id = activeId.current;
        if (!id || stopLatched.current) return;
        const p = lastProgress.current;
        showProgress({ phase: 'stopping', current: p?.current ?? 0, total: p?.total ?? 0, message: p?.message ?? '' });
        TrivyStopClusterScan(id).catch(() => { /* the cancelled event or the next check settles it */ });
    };

    return { running, stopping, line, percent, error, start, stop };
}
