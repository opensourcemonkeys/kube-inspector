import { useCallback, useEffect, useRef, useState } from 'react';
import { VscClose, VscSend, VscTrash, VscRefresh, VscHubot, VscCheck, VscChromeClose, VscCloudDownload, VscArrowLeft, VscChevronRight, VscChevronDown, VscDebugStop } from 'react-icons/vsc';
import { Button } from 'primereact/button';
import { Dropdown } from 'primereact/dropdown';
import { EventsOn, EventsOff, BrowserOpenURL } from '../../../wailsjs/runtime/runtime';
import { StartAiChat, StopAiChat, ListAiModels, ConfirmToolCall, AiAvailable, AiModelSupportsTools, ListAiModelCatalog, ListAiModelTags, PullAiModel, StopAiPull } from '../../../wailsjs/go/controller_app/App';
import { models as goModels } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import { useClusterContext } from '../../contexts/ClusterContext';
import { useAiChatStore, ChatMessage, ToolLine } from '../../stores/aiChatStore';
import { Trans } from 'react-i18next';
import { useT } from '../../i18n/useT';
import RowAction from '../shared/RowAction';
import StatusLamp, { type LampTone } from '../shared/StatusLamp';

interface ConfirmReq { id: string; name: string; args: Record<string, unknown>; }
interface PullState { percent: number; status: string; error?: string; }

const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

function buildContext(api: ReturnType<ReturnType<typeof useTabContext>['getApi']>, activeCluster: string): string {
    const panels: any[] = (api as any)?.panels ?? [];
    const active: any = (api as any)?.activePanel ?? null;
    const tab = (p: any) => ({ id: p?.id, title: p?.title, view: p?.params?.view, cluster: p?.params?.clusterName, params: p?.params });
    return JSON.stringify({
        activeCluster,
        openTabs: panels.map(tab),
        activeTab: active ? tab(active) : null,
    }, null, 2);
}

function fmtBytes(n?: number): string {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export default function AiChat() {
    const t = useT();
    const { open, setOpen, host, model, messages, setModel, setMessages, clear } = useAiChatStore();
    const { getApi } = useTabContext();
    const { activeCluster } = useClusterContext();

    const [available, setAvailable] = useState<boolean | null>(null);
    const [toolSupport, setToolSupport] = useState<boolean | null>(null);
    const [view, setView] = useState<'chat' | 'models'>('chat');
    const [modelList, setModelList] = useState<string[]>([]);
    const [catalog, setCatalog] = useState<goModels.OllamaModelInfo[]>([]);
    const [catalogError, setCatalogError] = useState('');
    const [modelSearch, setModelSearch] = useState('');
    const [pullInput, setPullInput] = useState('');
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [tags, setTags] = useState<Record<string, string[] | 'loading' | 'error'>>({});
    const [pulls, setPulls] = useState<Record<string, PullState>>({});
    const [input, setInput] = useState('');
    const [streaming, setStreaming] = useState(false);
    const [liveText, setLiveText] = useState('');
    const [liveTools, setLiveTools] = useState<ToolLine[]>([]);
    const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
    const [confirmQueue, setConfirmQueue] = useState<ConfirmReq[]>([]);
    // Seconds since the turn started: a counting line instead of bouncing dots,
    // so a slow local model reads as "still going" and says for how long.
    const [elapsed, setElapsed] = useState(0);
    useEffect(() => {
        if (!streaming) return;
        setElapsed(0);
        const started = Date.now();
        const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
        return () => window.clearInterval(id);
    }, [streaming]);

    const sessionId = useRef(`ai-${Date.now()}`).current;
    const liveTextRef = useRef('');
    const liveToolsRef = useRef<ToolLine[]>([]);
    const scrollRef = useRef<HTMLDivElement | null>(null);

    // ---- availability + model lists ----
    const checkAvailable = useCallback(() => {
        setAvailable(null);
        AiAvailable(host).then(setAvailable).catch(() => setAvailable(false));
    }, [host]);

    const loadModels = useCallback(() => {
        ListAiModels(host)
            .then((m) => {
                setModelList(m || []);
                if (!useAiChatStore.getState().model && m && m.length) setModel(m[0]);
            })
            .catch(() => { /* gated by availability */ });
    }, [host, setModel]);

    const loadCatalog = useCallback(() => {
        setCatalogError('');
        ListAiModelCatalog(host)
            .then((c) => setCatalog(c || []))
            .catch((e) => setCatalogError(String(e)));
    }, [host]);

    useEffect(() => { if (open) checkAvailable(); }, [open, checkAvailable]);
    useEffect(() => { if (open && available) { loadModels(); loadCatalog(); } }, [open, available, loadModels, loadCatalog]);

    // Detect whether the selected model can do tool calling (function calling).
    useEffect(() => {
        if (!open || !available || !model) { setToolSupport(null); return; }
        let cancelled = false;
        setToolSupport(null);
        AiModelSupportsTools(host, model)
            .then((ok) => { if (!cancelled) setToolSupport(ok); })
            .catch(() => { if (!cancelled) setToolSupport(null); });
        return () => { cancelled = true; };
    }, [open, available, host, model]);

    // ---- chat streaming events ----
    const finalize = useCallback((errText?: string) => {
        const msg: ChatMessage = {
            role: 'assistant',
            content: liveTextRef.current,
            tools: liveToolsRef.current.slice(),
            ...(errText !== undefined ? { error: errText } : {}),
        };
        setMessages([...useAiChatStore.getState().messages, msg]);
        liveTextRef.current = '';
        liveToolsRef.current = [];
        setLiveText('');
        setLiveTools([]);
        setStreaming(false);
        setConfirmQueue([]);
    }, [setMessages]);

    useEffect(() => {
        const onToken = (t: string) => { liveTextRef.current += t; setLiveText(liveTextRef.current); };
        const onTool = (ev: ToolLine) => {
            const arr = liveToolsRef.current.slice();
            const i = arr.findIndex((x) => x.id === ev.id);
            if (i >= 0) arr[i] = { ...arr[i], ...ev }; else arr.push(ev);
            liveToolsRef.current = arr;
            setLiveTools(arr);
        };
        const onConfirm = (req: ConfirmReq) => setConfirmQueue((q) => [...q, req]);
        const onDone = () => finalize();
        // An empty reason is still an error; Message words it at render time.
        const onError = (e: string) => finalize(e ?? '');

        EventsOn(`ai:token:${sessionId}`, onToken);
        EventsOn(`ai:tool:${sessionId}`, onTool);
        EventsOn(`ai:confirm:${sessionId}`, onConfirm);
        EventsOn(`ai:done:${sessionId}`, onDone);
        EventsOn(`ai:error:${sessionId}`, onError);
        return () => {
            EventsOff(`ai:token:${sessionId}`);
            EventsOff(`ai:tool:${sessionId}`);
            EventsOff(`ai:confirm:${sessionId}`);
            EventsOff(`ai:done:${sessionId}`);
            EventsOff(`ai:error:${sessionId}`);
        };
    }, [sessionId, finalize]);

    // ---- pull (download) events ----
    useEffect(() => {
        const onProg = (p: any) => setPulls((prev) => ({ ...prev, [p.model]: { percent: p.percent || 0, status: p.status || '' } }));
        const onDone = (p: any) => {
            setPulls((prev) => { const n = { ...prev }; delete n[p.model]; return n; });
            loadModels(); loadCatalog();
            if (!useAiChatStore.getState().model) setModel(p.model);
        };
        const onErr = (p: any) => setPulls((prev) => ({ ...prev, [p.model]: { percent: prev[p.model]?.percent || 0, status: 'error', error: p.error } }));
        EventsOn('ai:pull', onProg);
        EventsOn('ai:pull-done', onDone);
        EventsOn('ai:pull-error', onErr);
        return () => { EventsOff('ai:pull'); EventsOff('ai:pull-done'); EventsOff('ai:pull-error'); };
    }, [loadModels, loadCatalog, setModel]);

    // autoscroll chat
    useEffect(() => {
        const el = scrollRef.current;
        if (el && view === 'chat') el.scrollTop = el.scrollHeight;
    }, [messages, liveText, liveTools, confirmQueue, open, view]);

    const send = () => {
        const text = input.trim();
        if (!text || streaming || !model || !available) return;
        const next = [...messages, { role: 'user' as const, content: text }];
        setMessages(next);
        setInput('');
        liveTextRef.current = '';
        liveToolsRef.current = [];
        setLiveText('');
        setLiveTools([]);
        setStreaming(true);
        const payload = JSON.stringify(next.map((m) => ({ role: m.role, content: m.content })));
        const context = buildContext(getApi(), activeCluster);
        StartAiChat(sessionId, host, model, activeCluster, payload, context).catch((e) => finalize(String(e)));
    };

    const answerConfirm = (approved: boolean) => {
        const req = confirmQueue[0];
        if (!req) return;
        ConfirmToolCall(sessionId, req.id, approved).catch(() => { /* ignore */ });
        setConfirmQueue((q) => q.slice(1));
    };

    const stop = () => { StopAiChat(sessionId).catch(() => {}); };

    const startPull = (name: string) => {
        setPulls((prev) => ({ ...prev, [name]: { percent: 0, status: t('panels:ai.pullStarting') } }));
        PullAiModel(host, name).catch((e) => setPulls((prev) => ({ ...prev, [name]: { percent: 0, status: 'error', error: String(e) } })));
    };
    const cancelPull = (name: string) => {
        StopAiPull(name).catch(() => {});
        setPulls((prev) => { const n = { ...prev }; delete n[name]; return n; });
    };
    const pullFreeText = () => {
        const v = pullInput.trim();
        if (!v) return;
        startPull(v);
        setPullInput('');
    };
    const toggleExpand = (base: string) => {
        setExpanded((prev) => ({ ...prev, [base]: !prev[base] }));
        if (!tags[base]) {
            setTags((prev) => ({ ...prev, [base]: 'loading' }));
            ListAiModelTags(base)
                .then((t) => setTags((prev) => ({ ...prev, [base]: t || [] })))
                .catch(() => setTags((prev) => ({ ...prev, [base]: 'error' })));
        }
    };

    if (!open) return null;

    const style: React.CSSProperties = pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : {};

    const onDragStart = (e: React.PointerEvent) => {
        const startX = e.clientX, startY = e.clientY;
        const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
        const baseX = rect.left, baseY = rect.top;
        const move = (ev: PointerEvent) => setPos({ x: baseX + (ev.clientX - startX), y: baseY + (ev.clientY - startY) });
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    const showChat = () => setView('chat');
    const showModels = () => { setView('models'); loadCatalog(); };
    const confirm = confirmQueue[0];
    const installedSet = new Set(modelList);
    const isInstalled = (ref: string) => installedSet.has(ref) || installedSet.has(`${ref}:latest`);
    const activePulls = Object.entries(pulls);
    const filteredCatalog = catalog.filter((m) => {
        const q = modelSearch.trim().toLowerCase();
        if (!q) return true;
        return m.name.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q);
    });

    return (
        <div className="ai-float" style={style}>
            <div className="ai-float__head" onPointerDown={onDragStart}>
                {view === 'models' ? (
                    <>
                        <RowAction icon={<VscArrowLeft size={15} />} label={t('panels:ai.backToChat')} onClick={(e) => { e.stopPropagation(); showChat(); }} />
                        <span className="ai-float__title">{t('panels:ai.models')}</span>
                        <span className="ai-float__push">
                            <RowAction icon={<VscRefresh size={14} />} label={t('panels:ai.refresh')} onClick={(e) => { e.stopPropagation(); loadCatalog(); }} />
                        </span>
                    </>
                ) : (
                    <>
                        <VscHubot size={15} className="ai-float__logo" aria-hidden />
                        <span className="ai-float__title">{t('panels:ai.assistant')}</span>
                        <Dropdown
                            className="ai-float__model"
                            panelClassName="ai-model-dropdown"
                            appendTo={document.body}
                            value={model}
                            options={modelList.map((m) => ({ label: m, value: m }))}
                            onChange={(e) => setModel(e.value)}
                            placeholder={t('panels:ai.modelPlaceholder')}
                            disabled={!available}
                            filter={modelList.length > 6}
                            onClick={(e) => e.stopPropagation()}
                        />
                        <RowAction icon={<VscCloudDownload size={15} />} label={t('panels:ai.manageModels')} disabled={!available}
                            onClick={(e) => { e.stopPropagation(); showModels(); }} />
                        <RowAction icon={<VscTrash size={14} />} label={t('panels:ai.clearChat')} onClick={(e) => { e.stopPropagation(); clear(); }} />
                    </>
                )}
                <RowAction icon={<VscClose size={15} />} label={t('panels:ai.close')} onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
            </div>

            {/* Not-available gate */}
            {available === false && (
                <div className="ai-install">
                    <VscHubot size={34} className="ai-install__logo" />
                    <div className="ai-install__title">{t('panels:ai.ollamaMissingTitle')}</div>
                    <div className="ai-install__text">
                        <Trans t={t} i18nKey="panels:ai.ollamaMissing" values={{ host }} components={{ 1: <code /> }} />
                    </div>
                    <div className="ai-install__btns">
                        <Button label={t('action.retry')} icon={<VscRefresh size={14} />} severity="secondary" size="small" onClick={checkAvailable} />
                        <Button label={t('panels:ai.installOllama')} icon={<VscCloudDownload size={14} />} size="small" onClick={() => BrowserOpenURL(OLLAMA_DOWNLOAD_URL)} />
                    </div>
                </div>
            )}

            {available === null && (
                <div className="ai-float__empty ai-float__empty--fill">{t('panels:ai.connecting')}</div>
            )}

            {/* Model manager */}
            {available && view === 'models' && (
                <div className="ai-models">
                    <div className="ai-models__search">
                        <input value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} placeholder={t('panels:ai.searchCatalog')} />
                    </div>
                    <div className="ai-models__pull">
                        <input
                            value={pullInput}
                            onChange={(e) => setPullInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); pullFreeText(); } }}
                            placeholder={t('panels:ai.pullPlaceholder')}
                        />
                        <RowAction icon={<VscCloudDownload size={15} />} label={t('panels:ai.download')} disabled={!pullInput.trim()} onClick={pullFreeText} />
                    </div>
                    {catalogError && <div className="ai-float__hint">{t('panels:ai.catalogError', { error: catalogError })}</div>}

                    <div className="ai-models__list">
                        {/* active downloads (covers free-text pulls not shown elsewhere) */}
                        {activePulls.length > 0 && (
                            <div className="ai-models__active">
                                {activePulls.map(([name, pull]) => (
                                    <div className="ai-model ai-model--pulling" key={`p-${name}`}>
                                        <div className="ai-model__info">
                                            <div className="ai-model__name">{name}</div>
                                            <div className="ai-model__progress">
                                                <div className="ai-model__bar"><div className="ai-model__barfill" style={{ width: `${Math.max(2, pull.percent)}%` }} /></div>
                                                <div className={`ai-model__pstatus${pull.error ? ' ai-model__pstatus--err' : ''}`}>
                                                    {pull.error ? t('panels:ai.pullFailed', { error: pull.error }) : (
                                                        <>
                                                            <span>{pull.status}</span>
                                                            {pull.percent > 0 && <span>{pull.percent.toFixed(0)}%</span>}
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="ai-model__action">
                                            <RowAction icon={<VscChromeClose size={14} />} label={t('panels:ai.cancel')} onClick={() => cancelPull(name)} />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {filteredCatalog.map((m) => {
                            const base = m.name.split(':')[0];
                            const pull = pulls[m.name];
                            const isOpen = !!expanded[base];
                            const tagState = tags[base];
                            return (
                                <div className="ai-model-group" key={m.name}>
                                    <div className="ai-model">
                                        <button className="ai-model__expand" title={t('panels:ai.showSizes')} aria-label={t('panels:ai.showSizes')} aria-expanded={isOpen} onClick={() => toggleExpand(base)}>
                                            {isOpen ? <VscChevronDown size={13} /> : <VscChevronRight size={13} />}
                                        </button>
                                        <div className="ai-model__info ai-model__info--toggle" onClick={() => toggleExpand(base)}>
                                            <div className="ai-model__name">
                                                {m.name}
                                                {m.installed && <StatusLamp label={t('panels:ai.installed')} tone="ok" />}
                                                {!!m.vramBytes && <span className="ai-model__meta">~{fmtBytes(m.vramBytes)} VRAM</span>}
                                            </div>
                                            {m.description && <div className="ai-model__desc">{m.description}</div>}
                                        </div>
                                        <div className="ai-model__action">
                                            {isInstalled(m.name) ? (
                                                <span className="ai-model__installed" title={t('panels:ai.installed')}><VscCheck size={14} aria-label={t('panels:ai.installed')} /></span>
                                            ) : pull && !pull.error ? (
                                                <RowAction icon={<VscChromeClose size={14} />} label={t('panels:ai.cancel')} onClick={() => cancelPull(m.name)} />
                                            ) : (
                                                <RowAction icon={<VscCloudDownload size={15} />} label={t('panels:ai.downloadModel', { name: m.name })} onClick={() => startPull(m.name)} />
                                            )}
                                        </div>
                                    </div>

                                    {isOpen && (
                                        <div className="ai-variants">
                                            {tagState === 'loading' && <div className="ai-variants__msg">{t('panels:ai.loadingSizes')}</div>}
                                            {tagState === 'error' && <div className="ai-variants__msg">{t('panels:ai.sizesError')}</div>}
                                            {Array.isArray(tagState) && tagState.length === 0 && <div className="ai-variants__msg">{t('panels:ai.noTags')}</div>}
                                            {Array.isArray(tagState) && tagState.map((tag) => {
                                                const ref = `${base}:${tag}`;
                                                const vpull = pulls[ref];
                                                return (
                                                    <div className="ai-variant" key={ref}>
                                                        <span className="ai-variant__tag">{tag}</span>
                                                        {vpull && (
                                                            <span className={`ai-variant__status${vpull.error ? ' ai-model__pstatus--err' : ''}`}>
                                                                {vpull.error ? t('panels:ai.pullError') : `${vpull.percent ? vpull.percent.toFixed(0) + '%' : vpull.status}`}
                                                            </span>
                                                        )}
                                                        {isInstalled(ref) ? (
                                                            <span className="ai-model__installed" title={t('panels:ai.installed')}><VscCheck size={13} aria-label={t('panels:ai.installed')} /></span>
                                                        ) : vpull && !vpull.error ? (
                                                            <RowAction icon={<VscChromeClose size={13} />} label={t('panels:ai.cancel')} onClick={() => cancelPull(ref)} />
                                                        ) : (
                                                            <RowAction icon={<VscCloudDownload size={14} />} label={t('panels:ai.downloadModel', { name: ref })} onClick={() => startPull(ref)} />
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        {filteredCatalog.length === 0 && !catalogError && <div className="ai-float__empty">{t('panels:ai.noModelsMatch')}</div>}
                    </div>
                </div>
            )}

            {/* Chat */}
            {available && view === 'chat' && (
                <>
                    <div className="ai-float__body" ref={scrollRef}>
                        {model && toolSupport === false && (
                            <div className="ai-float__warn">
                                <Trans
                                    t={t}
                                    i18nKey="panels:ai.noToolSupport"
                                    values={{ model }}
                                    components={{ 1: <b />, 3: <b />, 5: <code />, 7: <code /> }}
                                />
                            </div>
                        )}
                        {modelList.length === 0 && (
                            <div className="ai-float__hint">
                                <Trans t={t} i18nKey="panels:ai.noModelsInstalled" components={{ 1: <b />, 3: <code /> }} />
                            </div>
                        )}
                        {messages.length === 0 && !streaming && (
                            <div className="ai-float__empty">{t('panels:ai.emptyChat')}</div>
                        )}
                        {messages.map((m, i) => <Message key={i} msg={m} />)}
                        {streaming && (
                            <div className="ai-msg ai-msg--assistant">
                                <ToolLines tools={liveTools} />
                                {liveText && <div className="ai-msg__text">{liveText}</div>}
                                <div className="ai-working" role="status">{t('panels:ai.workingFor', { seconds: elapsed })}</div>
                            </div>
                        )}
                    </div>

                    {confirm && (
                        <div className="ai-confirm">
                            <div className="ai-confirm__title">{t('panels:ai.approveAction')} <b>{confirm.name}</b></div>
                            <pre className="ai-confirm__args">{JSON.stringify(confirm.args, null, 2)}</pre>
                            {/* Approving runs a change against the cluster (delete,
                                apply, scale), so it carries the danger role, like
                                every other destructive confirm in the app. */}
                            <div className="ai-confirm__btns">
                                <Button label={t('panels:ai.deny')} severity="secondary" size="small" onClick={() => answerConfirm(false)} autoFocus />
                                <Button label={t('panels:ai.approve')} icon={<VscCheck size={14} />} severity="danger" size="small" onClick={() => answerConfirm(true)} />
                            </div>
                        </div>
                    )}

                    <div className="ai-float__input">
                        <textarea
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                            placeholder={t(model ? 'panels:ai.messagePlaceholder' : 'panels:ai.noModelPlaceholder')}
                            rows={2}
                        />
                        {streaming
                            ? <Button className="ai-float__send" icon={<VscDebugStop size={15} />} severity="danger" onClick={stop} aria-label={t('panels:ai.stop')} title={t('panels:ai.stop')} />
                            : <Button className="ai-float__send" icon={<VscSend size={15} />} onClick={send} disabled={!input.trim() || !model} aria-label={t('panels:ai.send')} title={t('panels:ai.send')} />}
                    </div>
                </>
            )}
        </div>
    );
}

// One turn of the log. The user's line carries the accent notch and a "You"
// marker; the assistant's is plain text on the screen, no bubble.
function Message({ msg }: { msg: ChatMessage }) {
    const t = useT();
    return (
        <div className={`ai-msg ai-msg--${msg.role}`}>
            {msg.role === 'user' && <span className="ai-msg__who">{t('panels:ai.you')}</span>}
            {msg.tools && msg.tools.length > 0 && <ToolLines tools={msg.tools} />}
            {msg.content && <div className="ai-msg__text">{msg.content}</div>}
            {msg.error !== undefined && (
                <div className="ai-msg__error" role="alert">
                    <StatusLamp label={t('panels:ai.toolStatus.error')} tone="err" />
                    <span>{msg.error || t('panels:ai.requestFailed')}</span>
                </div>
            )}
        </div>
    );
}

const TOOL_TONE: Record<ToolLine['status'], LampTone> = { running: 'info', done: 'ok', declined: 'idle', error: 'err' };

// A tool call as an instrument log line: lamp, tool name, and its outcome.
function ToolLines({ tools }: { tools: ToolLine[] }) {
    const t = useT();
    if (!tools.length) return null;
    const statusLabel = (s: ToolLine['status']) => {
        switch (s) {
            case 'running': return t('panels:ai.toolStatus.running');
            case 'done': return t('panels:ai.toolStatus.done');
            case 'declined': return t('panels:ai.toolStatus.declined');
            default: return t('panels:ai.toolStatus.error');
        }
    };
    return (
        <ul className="ai-tools">
            {tools.map((tool) => (
                <li key={tool.id} className={`ai-tool ai-tool--${tool.status}`}>
                    <StatusLamp markOnly label={statusLabel(tool.status)} tone={TOOL_TONE[tool.status] ?? 'idle'} />
                    <span className="ai-tool__name">{tool.name}</span>
                    {tool.mutating && <span className="ai-tool__badge">{t('panels:ai.mutating')}</span>}
                    <span className="ai-tool__status">{statusLabel(tool.status)}</span>
                </li>
            ))}
        </ul>
    );
}
