import { useEffect, useRef, useState, useCallback, useMemo, type ReactNode } from 'react';
import {
    VscListFlat, VscPinned, VscWordWrap, VscWatch, VscHistory, VscSymbolColor,
    VscClearAll, VscCopy, VscSave, VscRefresh,
} from 'react-icons/vsc';
import { IDockviewPanelProps } from 'dockview';
import { LazyLog } from '@melloware/react-logviewer';
import { Dropdown } from 'primereact/dropdown';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { EventsOn } from '../../../wailsjs/runtime/runtime';
import { useT } from '../../i18n/useT';
import {
    GetPodLogContainers,
    GetDeploymentPods,
    GetStatefulSetPods,
    GetReplicaSetPods,
    GetDaemonSetPods,
    GetJobPods,
    GetCronJobPods,
    StartLogStream,
    StopLogStream,
    SaveText,
} from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { createLogBuffer } from '../../lib/logBuffer';
import { formatLogLevel } from '../../lib/logLevel';
import { writeClipboard } from '../../lib/clipboard';
import { errText } from '../../lib/errText';
import { usePanelActive } from '../../lib/usePanelActive';
import { useLogViewerStore, TAIL_OPTIONS, SINCE_OPTIONS } from '../../stores/logViewerStore';

export type WorkloadKind = 'pod' | 'deployment' | 'statefulset' | 'replicaset' | 'daemonset' | 'job' | 'cronjob';

export interface LogViewerPanelParams {
    clusterName: string;
    resourceKind: WorkloadKind;
    name: string;
    namespace: string;
}

async function fetchPodsForKind(clusterName: string, kind: WorkloadKind, name: string, namespace: string): Promise<string[]> {
    switch (kind) {
        case 'deployment':   return GetDeploymentPods(clusterName, name, namespace);
        case 'statefulset':  return GetStatefulSetPods(clusterName, name, namespace);
        case 'replicaset':   return GetReplicaSetPods(clusterName, name, namespace);
        case 'daemonset':    return GetDaemonSetPods(clusterName, name, namespace);
        case 'job':          return GetJobPods(clusterName, name, namespace);
        case 'cronjob':      return GetCronJobPods(clusterName, name, namespace);
        default:             return [];
    }
}

/** Container selection meaning "every regular container" (init/ephemeral only when picked). */
const ALL_CONTAINERS = '';
/** Pod selection meaning "every pod of the workload", stern-style. */
const ALL_PODS = '\u0000all';

/** How many log lines the viewer keeps; see lib/logBuffer. */
const MAX_LOG_LINES = 5000;

/** Flush interval for accumulated stream output, in ms. */
const FLUSH_MS = 120;

/** How often a workload's pod list is re-read, so a rollout's new pods show up. */
const POD_REFRESH_MS = 10_000;

type StreamState = 'connecting' | 'live' | 'ended' | 'error';

interface StreamEntry {
    sessionId: string;
    pod: string;
    container: string;
    state: StreamState;
    off: Array<() => void>;
}

export default function LogViewerPanel({ params, api }: IDockviewPanelProps<LogViewerPanelParams>) {
    const t = useT();
    const { clusterName, resourceKind, name, namespace } = params;
    const cn = clusterName ?? '';
    const isWorkload = resourceKind !== 'pod';
    const active = usePanelActive(api);

    const { wrap, timestamps, colorLevels, tailLines, sinceSeconds,
        setWrap, setTimestamps, setColorLevels, setTailLines, setSinceSeconds } = useLogViewerStore();

    const [pods, setPods] = useState<string[]>(isWorkload ? [] : [name]);
    const [selectedPod, setSelectedPod] = useState(isWorkload ? '' : name);
    const [containers, setContainers] = useState<models.LogContainerInfo[]>([]);
    const [selectedContainer, setSelectedContainer] = useState(ALL_CONTAINERS);
    const [follow, setFollow] = useState(true);
    const [previous, setPrevious] = useState(false);
    const [restartKey, setRestartKey] = useState(0);
    const [logText, setLogText] = useState(' ');
    const [truncated, setTruncated] = useState(false);

    const toastRef = useRef<Toast>(null);
    const bufferRef = useRef(createLogBuffer(MAX_LOG_LINES));
    const dirtyRef = useRef(false);
    const streamsRef = useRef(new Map<string, StreamEntry>());
    // Bumped on every reset, so async work begun for an older configuration
    // (a container lookup still in flight) knows not to start its streams.
    const generationRef = useRef(0);
    const startedPodsRef = useRef(new Set<string>());
    const containerCacheRef = useRef(new Map<string, models.LogContainerInfo[]>());
    // Set when scrolling up paused Follow, so scrolling back down resumes it —
    // but switching Follow off by hand is not undone by being at the bottom.
    const autoPausedRef = useRef(false);
    const lastScrollRef = useRef({ top: 0, height: 0 });

    const toast = useCallback((severity: 'success' | 'error' | 'warn', summary: string, detail?: string) => {
        toastRef.current?.show({ severity, summary, detail, life: 3000 });
    }, []);

    // Batch the stream into one state update per tick: an event per chunk
    // would re-render (and re-layout LazyLog) hundreds of times a second.
    useEffect(() => {
        const timer = setInterval(() => {
            if (!dirtyRef.current) return;
            dirtyRef.current = false;
            const buf = bufferRef.current;
            // LazyLog treats '' as "no content at all"; a single space is what
            // this panel has always used for the empty state.
            setLogText(buf.text() || ' ');
            setTruncated(buf.truncated);
        }, FLUSH_MS);
        return () => clearInterval(timer);
    }, []);

    const stopAll = useCallback(() => {
        for (const s of streamsRef.current.values()) {
            s.off.forEach(off => off());
            if (s.state === 'connecting' || s.state === 'live') StopLogStream(s.sessionId).catch(() => {});
        }
        streamsRef.current.clear();
        startedPodsRef.current.clear();
    }, []);

    // Workload pods: read now, then again every POD_REFRESH_MS while the tab is
    // visible, so the "all pods" view picks up a rollout's replacements.
    useEffect(() => {
        if (!isWorkload || !active) return;
        let cancelled = false;
        const load = () => {
            fetchPodsForKind(cn, resourceKind, name, namespace)
                .then(podNames => {
                    if (cancelled) return;
                    setPods(prev => (prev.join('\n') === podNames.join('\n') ? prev : podNames));
                    setSelectedPod(cur => cur || podNames[0] || '');
                })
                .catch(() => { if (!cancelled) setPods([]); });
        };
        load();
        const timer = setInterval(load, POD_REFRESH_MS);
        return () => { cancelled = true; clearInterval(timer); };
    }, [cn, isWorkload, resourceKind, name, namespace, active]);

    const targetPods = useMemo(
        () => (selectedPod === ALL_PODS ? pods : selectedPod ? [selectedPod] : []),
        [selectedPod, pods],
    );

    // The container dropdown describes one pod: the selected one, or the first
    // of the workload when following them all (they share one pod template).
    const referencePod = selectedPod === ALL_PODS ? pods[0] ?? '' : selectedPod;

    const loadContainers = useCallback(async (pod: string) => {
        const cached = containerCacheRef.current.get(pod);
        if (cached) return cached;
        const list = (await GetPodLogContainers(cn, pod, namespace)) ?? [];
        containerCacheRef.current.set(pod, list);
        return list;
    }, [cn, namespace]);

    useEffect(() => {
        containerCacheRef.current.clear();
    }, [cn, namespace, restartKey]);

    useEffect(() => {
        if (!referencePod) return;
        let cancelled = false;
        loadContainers(referencePod)
            .then(list => {
                if (cancelled) return;
                setContainers(list);
                setSelectedContainer(cur => (cur === ALL_CONTAINERS || list.some(c => c.name === cur) ? cur : ALL_CONTAINERS));
            })
            .catch(() => { if (!cancelled) setContainers([]); });
        return () => { cancelled = true; };
    }, [referencePod, loadContainers]);

    const startStream = useCallback((pod: string, container: string, prefix: string, opts: models.LogStreamOptions) => {
        const sessionId = `log:${namespace}:${pod}:${container}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        const entry: StreamEntry = { sessionId, pod, container, state: 'connecting', off: [] };
        const key = `${pod}/${container}`;
        streamsRef.current.set(key, entry);
        const owns = () => streamsRef.current.get(key) === entry;
        const setState = (state: StreamState) => {
            if (owns()) entry.state = state;
        };
        const buf = bufferRef.current;

        entry.off.push(EventsOn(`log:output:${sessionId}`, (data: string) => {
            if (!owns()) return;
            buf.push(sessionId, data, prefix);
            dirtyRef.current = true;
            if (entry.state === 'connecting') setState('live');
        }));
        entry.off.push(EventsOn(`log:closed:${sessionId}`, (reason: string) => {
            if (!owns()) return;
            buf.end(sessionId);
            if (reason) {
                buf.note(`${prefix}${t('panels:logs.notice.error', { reason })}`);
                setState('error');
            } else {
                if (!opts.previous) buf.note(`${prefix}${t('panels:logs.notice.ended')}`);
                setState('ended');
            }
            dirtyRef.current = true;
        }));

        StartLogStream(cn, sessionId, pod, namespace, container, opts)
            .then(() => { if (entry.state === 'connecting') setState('live'); })
            .catch((err: unknown) => {
                if (!owns()) return;
                buf.note(`${prefix}${t('panels:logs.notice.error', { reason: errText(err) })}`);
                dirtyRef.current = true;
                setState('error');
            });
    }, [cn, namespace, t]);

    // Any change to what is being read — which pod or container, the stream
    // options, an explicit reconnect — starts over with an empty buffer.
    useEffect(() => {
        generationRef.current += 1;
        stopAll();
        bufferRef.current.clear();
        dirtyRef.current = true;
        return stopAll;
    }, [cn, namespace, selectedPod, selectedContainer, timestamps, previous, tailLines, sinceSeconds, restartKey, stopAll]);

    // Start streams for every target pod not yet streaming in this generation.
    // In "all pods" mode a refresh that adds pods only adds their streams; the
    // rest keep going. A pod that went away ends its own stream (log:closed),
    // and its entry is dropped here so the pod can stream again if it returns.
    useEffect(() => {
        const gen = generationRef.current;
        const opts = models.LogStreamOptions.createFrom({
            tail_lines: tailLines, since_seconds: sinceSeconds, timestamps, previous,
        });
        const multiPod = selectedPod === ALL_PODS;

        for (const [key, s] of streamsRef.current) {
            if (!targetPods.includes(s.pod) && (s.state === 'ended' || s.state === 'error')) {
                s.off.forEach(off => off());
                streamsRef.current.delete(key);
                startedPodsRef.current.delete(s.pod);
            }
        }

        for (const pod of targetPods) {
            if (startedPodsRef.current.has(pod)) continue;
            startedPodsRef.current.add(pod);
            loadContainers(pod)
                .then(list => {
                    if (generationRef.current !== gen) return;
                    const names = selectedContainer
                        ? list.filter(c => c.name === selectedContainer).map(c => c.name)
                        : list.filter(c => c.kind === 'container').map(c => c.name);
                    if (names.length === 0) {
                        if (selectedContainer) {
                            bufferRef.current.note(t('panels:logs.notice.noContainer', { pod, container: selectedContainer }));
                            dirtyRef.current = true;
                        }
                        return;
                    }
                    for (const container of names) {
                        const prefix = multiPod
                            ? (names.length > 1 ? `[${pod}/${container}] ` : `[${pod}] `)
                            : (names.length > 1 ? `[${container}] ` : '');
                        startStream(pod, container, prefix, opts);
                    }
                })
                .catch((err: unknown) => {
                    if (generationRef.current !== gen) return;
                    bufferRef.current.note(t('panels:logs.notice.error', { reason: `${pod}: ${errText(err)}` }));
                    dirtyRef.current = true;
                });
        }
        // generationRef is read, not depended on: the reset effect above runs
        // first on the same deps and bumps it.
    }, [targetPods, selectedPod, selectedContainer, timestamps, previous, tailLines, sinceSeconds, restartKey, loadContainers, startStream, t]);

    const onScroll = useCallback(({ scrollTop, scrollHeight, clientHeight }: { scrollTop: number; scrollHeight: number; clientHeight: number }) => {
        const last = lastScrollRef.current;
        lastScrollRef.current = { top: scrollTop, height: scrollHeight };
        // Only a move with unchanged content is the user: new or cleared lines
        // shift scrollTop on their own.
        if (scrollHeight !== last.height) return;
        const atBottom = scrollTop + clientHeight >= scrollHeight - 24;
        if (scrollTop < last.top && !atBottom) {
            setFollow(f => {
                if (f) autoPausedRef.current = true;
                return false;
            });
        } else if (atBottom && autoPausedRef.current) {
            autoPausedRef.current = false;
            setFollow(true);
        }
    }, []);

    const toggleFollow = () => {
        autoPausedRef.current = false;
        setFollow(f => !f);
    };

    const currentText = () => bufferRef.current.text();

    const clear = () => {
        bufferRef.current.clear();
        dirtyRef.current = true;
    };

    const copy = () => {
        const text = currentText();
        if (!text.trim()) {
            toast('warn', t('panels:logs.toast.nothingToCopy'));
            return;
        }
        void writeClipboard(text).then(ok => {
            toast(ok ? 'success' : 'error', ok ? t('panels:logs.toast.copied') : t('panels:logs.toast.copyFailed'));
        });
    };

    const save = async () => {
        const text = currentText();
        if (!text.trim()) {
            toast('warn', t('panels:logs.toast.nothingToCopy'));
            return;
        }
        const base = selectedPod && selectedPod !== ALL_PODS ? selectedPod : name;
        const suffix = selectedContainer ? `-${selectedContainer}` : '';
        try {
            const path = await SaveText(`${base}${suffix}.log`, text + '\n');
            // "" is a cancelled dialog, not a failure — say nothing.
            if (path) toast('success', t('panels:logs.toast.saved'), path);
        } catch (e) {
            toast('error', t('panels:logs.toast.saveFailed'), errText(e));
        }
    };

    // ── Options ───────────────────────────────────────────────────────────
    const podOptions = [
        ...(pods.length > 1 ? [{ label: t('panels:logs.allPods', { n: pods.length }), value: ALL_PODS }] : []),
        ...pods.map(p => ({ label: p, value: p })),
        // A pod that went away stays selectable as itself, so the dropdown
        // never shows a blank label for what the panel is still displaying.
        ...(selectedPod && selectedPod !== ALL_PODS && !pods.includes(selectedPod)
            ? [{ label: selectedPod, value: selectedPod }] : []),
    ];

    const containerOptions = [
        { label: t('panels:logs.allContainers'), value: ALL_CONTAINERS },
        ...containers.map(c => ({
            label: c.kind === 'container' ? c.name : `${c.name} (${t(`panels:logs.kind.${c.kind as 'init' | 'ephemeral'}`)})`,
            value: c.name,
        })),
    ];

    const tailOptions = TAIL_OPTIONS.map(n => ({
        label: n === 0 ? t('panels:logs.tail.all') : t('panels:logs.tail.lines', { n }),
        value: n,
    }));
    const sinceOptions = SINCE_OPTIONS.map(s => ({ label: t(`panels:logs.since.s${s}`), value: s }));

    const toggle = (on: boolean, icon: ReactNode, label: string, onClick: () => void) => (
        <Button
            icon={icon}
            text
            size="small"
            severity="secondary"
            className={`log-viewer-toggle${on ? ' is-on' : ''}`}
            aria-pressed={on}
            aria-label={label}
            tooltip={label}
            tooltipOptions={{ position: 'bottom', showDelay: 400 }}
            onClick={onClick}
        />
    );

    const action = (icon: ReactNode, label: string, onClick: () => void) => (
        <Button
            icon={icon}
            text
            size="small"
            severity="secondary"
            className="log-viewer-action"
            aria-label={label}
            tooltip={label}
            tooltipOptions={{ position: 'bottom', showDelay: 400 }}
            onClick={onClick}
        />
    );

    return (
        <div className="log-viewer-panel">
            <Toast ref={toastRef} position="bottom-right" />
            <div className="log-viewer-toolbar">
                <div className="log-viewer-toolbar__group">
                    <VscListFlat size={14} aria-label={t('panels:logs.label')} />
                    {isWorkload && podOptions.length > 0 && (
                        <Dropdown
                            value={selectedPod}
                            options={podOptions}
                            onChange={e => setSelectedPod(e.value)}
                            placeholder={t('panels:logs.selectPod')}
                            className="log-viewer-dropdown log-viewer-dropdown--pod"
                            filter={podOptions.length > 8}
                        />
                    )}
                    {containers.length > 0 && (
                        <Dropdown
                            value={selectedContainer}
                            options={containerOptions}
                            onChange={e => setSelectedContainer(e.value)}
                            placeholder={t('panels:logs.container')}
                            className="log-viewer-dropdown"
                        />
                    )}
                    <Dropdown
                        value={tailLines}
                        options={tailOptions}
                        onChange={e => setTailLines(e.value)}
                        className="log-viewer-dropdown"
                        tooltip={t('panels:logs.tail.tooltip')}
                        tooltipOptions={{ position: 'bottom', showDelay: 400 }}
                    />
                    <Dropdown
                        value={sinceSeconds}
                        options={sinceOptions}
                        onChange={e => setSinceSeconds(e.value)}
                        className="log-viewer-dropdown"
                        tooltip={t('panels:logs.since.tooltip')}
                        tooltipOptions={{ position: 'bottom', showDelay: 400 }}
                    />
                </div>

                <div className="log-viewer-toolbar__group">
                    {toggle(follow, <VscPinned size={15} />, t('panels:logs.follow'), toggleFollow)}
                    {toggle(wrap, <VscWordWrap size={15} />, t('panels:logs.wrap'), () => setWrap(!wrap))}
                    {toggle(timestamps, <VscWatch size={15} />, t('panels:logs.timestamps'), () => setTimestamps(!timestamps))}
                    {toggle(previous, <VscHistory size={15} />, t('panels:logs.previous'), () => setPrevious(p => !p))}
                    {toggle(colorLevels, <VscSymbolColor size={15} />, t('panels:logs.levelColors'), () => setColorLevels(!colorLevels))}
                </div>

                <div className="log-viewer-toolbar__group log-viewer-toolbar__group--end">
                    {truncated && (
                        <span className="log-viewer-toolbar__note">
                            {t('panels:logs.truncated', { lines: MAX_LOG_LINES })}
                        </span>
                    )}
                    {action(<VscRefresh size={15} />, t('panels:logs.reconnect'), () => setRestartKey(k => k + 1))}
                    {action(<VscClearAll size={15} />, t('panels:logs.clear'), clear)}
                    {action(<VscCopy size={15} />, t('panels:logs.copy'), copy)}
                    {action(<VscSave size={15} />, t('panels:logs.save'), () => void save())}
                </div>
            </div>

            <div className="log-viewer-body">
                <LazyLog
                    text={logText}
                    follow={follow}
                    onScroll={onScroll}
                    enableSearch={true}
                    selectableLines={true}
                    wrapLines={wrap}
                    formatPart={colorLevels ? formatLogLevel : undefined}
                    height="auto"
                    width="auto"
                />
            </div>
        </div>
    );
}
