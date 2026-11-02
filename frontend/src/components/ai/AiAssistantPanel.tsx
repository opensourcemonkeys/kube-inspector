import { useCallback, useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { VscSend, VscTrash, VscRefresh, VscHubot, VscCloudDownload, VscArrowLeft, VscDebugStop, VscClose, VscLock } from 'react-icons/vsc';
import { Button } from 'primereact/button';
import { Dropdown } from 'primereact/dropdown';
import { EventsOn, BrowserOpenURL } from '../../../wailsjs/runtime/runtime';
import { StartAiChat, StopAiChat, ListAiModels, ConfirmToolCall, AiAvailable, AiModelSupportsTools } from '../../../wailsjs/go/controller_app/App';
import { useTabContext } from '../../contexts/TabContext';
import { useAiChatStore, isReadOnly, type AiRef, type ChatMessage, type ToolLine } from '../../stores/aiChatStore';
import { useAiPullStore } from '../../stores/aiPullStore';
import { Trans } from 'react-i18next';
import { useT } from '../../i18n/useT';
import RowAction from '../shared/RowAction';
import Segmented from '../shared/Segmented';
import ConfirmCard, { type ConfirmReq } from './ConfirmCard';
import ModelManager from './ModelManager';
import { Message, ChatText, ToolLines } from './ChatLog';
import { refLabel } from './refs';

const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

const EMPTY: ChatMessage[] = [];

// Internal identifiers, kept out of JSX so they are not mistaken for copy.
type View = 'chat' | 'models';
type Mode = 'ro' | 'rw';
const CHAT: View = 'chat';
const MODELS: View = 'models';
const RO: Mode = 'ro';
const RW: Mode = 'rw';

/** Starters for an empty chat: they fill the input, they are never sent. */
const STARTERS = ['panels:ai.starter.unhealthy', 'panels:ai.starter.usage', 'panels:ai.starter.changes'] as const;

/**
 * What the model is told about the UI: only THIS cluster's open tabs (another
 * cluster's tabs are noise at best and a wrong target at worst), the focused
 * one if it belongs here, and the objects the user pointed at.
 */
function buildContext(api: ReturnType<ReturnType<typeof useTabContext>['getApi']>, cluster: string, refs: AiRef[]): string {
    const panels: any[] = (api as any)?.panels ?? [];
    const active: any = (api as any)?.activePanel ?? null;
    const mine = (p: any) => p?.params?.clusterName === cluster && !String(p?.id ?? '').startsWith('ai:');
    const tab = (p: any) => ({ title: p?.title, view: p?.params?.view, kind: p?.params?.resourceKind ?? p?.params?.resource, namespace: p?.params?.namespace, name: p?.params?.name });
    return JSON.stringify({
        openTabs: panels.filter(mine).map(tab),
        activeTab: active && mine(active) ? tab(active) : null,
        pointedAt: refs,
    });
}

/** The shape each turn goes to the backend in: text plus its tool calls and their (capped) results. */
const toPayload = (msgs: ChatMessage[]) =>
    JSON.stringify(msgs.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tools?.length ? { tools: m.tools.map(({ id, name, args, status, result }) => ({ id, name, args, status, result })) } : {}),
    })));

export default function AiAssistantPanel({ params }: IDockviewPanelProps<{ clusterName: string }>) {
    const t = useT();
    const cluster = params.clusterName;
    const host = useAiChatStore((s) => s.host);
    const model = useAiChatStore((s) => s.model);
    const setModel = useAiChatStore((s) => s.setModel);
    const messages = useAiChatStore((s) => s.chats[cluster] ?? EMPTY);
    const setMessages = useAiChatStore((s) => s.setMessages);
    const clear = useAiChatStore((s) => s.clear);
    const readOnly = useAiChatStore((s) => isReadOnly(s.readOnly, cluster));
    const setReadOnly = useAiChatStore((s) => s.setReadOnly);
    const pending = useAiChatStore((s) => s.pending[cluster]);
    const takePending = useAiChatStore((s) => s.takePending);
    const pullsDone = useAiPullStore((s) => s.completed);
    const { getApi, openDescribePanel } = useTabContext();

    const [available, setAvailable] = useState<boolean | null>(null);
    const [toolSupport, setToolSupport] = useState<boolean | null>(null);
    const [view, setView] = useState<View>(CHAT);
    const [modelList, setModelList] = useState<string[]>([]);
    const [input, setInput] = useState('');
    const [refs, setRefs] = useState<AiRef[]>([]);
    const [streaming, setStreaming] = useState(false);
    const [liveText, setLiveText] = useState('');
    const [liveTools, setLiveTools] = useState<ToolLine[]>([]);
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

    // One session per mounted tab. Its events are suffixed with it, so two
    // clusters' assistants never hear each other.
    const sessionId = useRef(`ai:${cluster}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).current;
    const liveTextRef = useRef('');
    const liveToolsRef = useRef<ToolLine[]>([]);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);

    // Closing the tab ends its turn. Without this a turn waiting for an
    // approval nobody can now give would hold its goroutine forever.
    useEffect(() => () => { StopAiChat(sessionId).catch(() => {}); }, [sessionId]);

    // A prompt handed over by another screen (a row's "Ask AI", the fix plan)
    // lands in the input for the user to read and send; it is never sent here.
    useEffect(() => {
        if (!pending) return;
        const p = takePending(cluster);
        if (!p) return;
        if (p.text) setInput((draft) => (draft.trim() ? `${draft}\n${p.text}` : p.text));
        if (p.refs.length) {
            setRefs((cur) => {
                const seen = new Set(cur.map(refLabel));
                return [...cur, ...p.refs.filter((r) => !seen.has(refLabel(r)))];
            });
        }
        setView(CHAT);
        window.setTimeout(() => inputRef.current?.focus(), 0);
    }, [pending, takePending, cluster]);

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

    useEffect(() => { checkAvailable(); }, [checkAvailable]);
    useEffect(() => { if (available) loadModels(); }, [available, loadModels, pullsDone]);
    // A first model arriving by download becomes the selection.
    useEffect(() => {
        const last = useAiPullStore.getState().lastCompleted;
        if (pullsDone && last && !useAiChatStore.getState().model) setModel(last);
    }, [pullsDone, setModel]);

    // Detect whether the selected model can do tool calling (function calling).
    useEffect(() => {
        if (!available || !model) { setToolSupport(null); return; }
        let cancelled = false;
        setToolSupport(null);
        AiModelSupportsTools(host, model)
            .then((ok) => { if (!cancelled) setToolSupport(ok); })
            .catch(() => { if (!cancelled) setToolSupport(null); });
        return () => { cancelled = true; };
    }, [available, host, model]);

    // ---- chat streaming events ----
    const finalize = useCallback((end: { error?: string; toolLimit?: boolean }) => {
        const msg: ChatMessage = {
            role: 'assistant',
            content: liveTextRef.current,
            tools: liveToolsRef.current.slice(),
            ...(end.error !== undefined ? { error: end.error } : {}),
            ...(end.toolLimit ? { toolLimit: true } : {}),
        };
        setMessages(cluster, [...(useAiChatStore.getState().chats[cluster] ?? []), msg]);
        liveTextRef.current = '';
        liveToolsRef.current = [];
        setLiveText('');
        setLiveTools([]);
        setStreaming(false);
        setConfirmQueue([]);
    }, [setMessages, cluster]);

    useEffect(() => {
        const onToken = (s: string) => { liveTextRef.current += s; setLiveText(liveTextRef.current); };
        // The backend takes text back when what streamed turned out to be a
        // tool call the model wrote as prose; n is in UTF-16 units, as slice counts.
        const onRetract = (n: number) => {
            liveTextRef.current = liveTextRef.current.slice(0, Math.max(0, liveTextRef.current.length - n));
            setLiveText(liveTextRef.current);
        };
        const onTool = (ev: ToolLine) => {
            const arr = liveToolsRef.current.slice();
            const i = arr.findIndex((x) => x.id === ev.id);
            if (i >= 0) arr[i] = { ...arr[i], ...ev }; else arr.push(ev);
            liveToolsRef.current = arr;
            setLiveTools(arr);
        };
        const onConfirm = (req: ConfirmReq) => setConfirmQueue((q) => [...q, req]);
        const onDone = (p?: { reason?: string }) => finalize({ toolLimit: p?.reason === 'toolLimit' });
        // An empty reason is still an error; Message words it at render time.
        const onError = (e: string) => finalize({ error: e ?? '' });

        // The unsubscribe EventsOn returns, not EventsOff: these names are
        // unique to this tab, but that is the habit that keeps it so.
        const offs = [
            EventsOn(`ai:token:${sessionId}`, onToken),
            EventsOn(`ai:retract:${sessionId}`, onRetract),
            EventsOn(`ai:tool:${sessionId}`, onTool),
            EventsOn(`ai:confirm:${sessionId}`, onConfirm),
            EventsOn(`ai:done:${sessionId}`, onDone),
            EventsOn(`ai:error:${sessionId}`, onError),
        ];
        return () => offs.forEach((off) => off());
    }, [sessionId, finalize]);

    // autoscroll chat
    useEffect(() => {
        const el = scrollRef.current;
        if (el && view === 'chat') el.scrollTop = el.scrollHeight;
    }, [messages, liveText, liveTools, confirmQueue, view]);

    const send = () => {
        const text = input.trim();
        if (!text || streaming || !model || !available) return;
        const sentRefs = refs;
        const next: ChatMessage[] = [...messages, { role: 'user', content: text, ...(sentRefs.length ? { refs: sentRefs } : {}) }];
        setMessages(cluster, next);
        setInput('');
        setRefs([]);
        liveTextRef.current = '';
        liveToolsRef.current = [];
        setLiveText('');
        setLiveTools([]);
        setStreaming(true);
        const context = buildContext(getApi(), cluster, sentRefs);
        StartAiChat(sessionId, host, model, cluster, toPayload(next), context, readOnly).catch((e) => finalize({ error: String(e) }));
    };

    const answerConfirm = (approved: boolean) => {
        const req = confirmQueue[0];
        if (!req) return;
        ConfirmToolCall(sessionId, req.id, approved).catch(() => { /* ignore */ });
        setConfirmQueue((q) => q.slice(1));
    };

    const stop = () => { StopAiChat(sessionId).catch(() => {}); };

    const openRef = useCallback((ref: AiRef) => {
        openDescribePanel({
            clusterName: cluster,
            resource: ref.resource,
            name: ref.name,
            namespace: ref.namespace,
            referencePanel: `ai:${cluster}`,
        });
    }, [openDescribePanel, cluster]);

    const confirm = confirmQueue[0];

    return (
        <div className="ai-panel">
            <div className="panel-toolbar">
                {view === 'models' ? (
                    <>
                        <span className="panel-toolbar__label">
                            <RowAction icon={<VscArrowLeft size={15} />} label={t('panels:ai.backToChat')} onClick={() => setView(CHAT)} />
                            {t('panels:ai.models')}
                        </span>
                        <span className="panel-toolbar__actions">
                            <RowAction icon={<VscRefresh size={14} />} label={t('panels:ai.refresh')} onClick={loadModels} />
                        </span>
                    </>
                ) : (
                    <>
                        <span className="panel-toolbar__label">
                            <VscHubot size={15} aria-hidden />
                            <Segmented
                                ariaLabel={t('panels:ai.mode')}
                                value={readOnly ? RO : RW}
                                options={[
                                    { value: RO, label: t('panels:ai.readOnly') },
                                    { value: RW, label: t('panels:ai.allowChanges') },
                                ]}
                                onChange={(v) => setReadOnly(cluster, v === RO)}
                            />
                        </span>
                        <span className="panel-toolbar__actions">
                            <Dropdown
                                className="ai-panel__model"
                                panelClassName="ai-model-dropdown"
                                value={model}
                                options={modelList.map((m) => ({ label: m, value: m }))}
                                onChange={(e) => setModel(e.value)}
                                placeholder={t('panels:ai.modelPlaceholder')}
                                disabled={!available}
                                filter={modelList.length > 6}
                                ariaLabel={t('panels:ai.modelPlaceholder')}
                            />
                            <RowAction icon={<VscCloudDownload size={15} />} label={t('panels:ai.manageModels')} disabled={!available} onClick={() => setView(MODELS)} />
                            <RowAction icon={<VscTrash size={14} />} label={t('panels:ai.clearChat')} disabled={streaming || messages.length === 0} onClick={() => clear(cluster)} />
                        </span>
                    </>
                )}
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
                <div className="ai-panel__empty ai-panel__empty--fill">{t('panels:ai.connecting')}</div>
            )}

            {available && view === 'models' && <ModelManager host={host} installed={modelList} reloadKey={pullsDone} />}

            {available && view === 'chat' && (
                <>
                    <div className="ai-panel__body" ref={scrollRef}>
                        {model && toolSupport === false && (
                            <div className="ai-panel__warn">
                                <Trans
                                    t={t}
                                    i18nKey="panels:ai.noToolSupport"
                                    values={{ model }}
                                    components={{ 1: <b />, 3: <b />, 5: <code />, 7: <code /> }}
                                />
                            </div>
                        )}
                        {modelList.length === 0 && (
                            <div className="ai-panel__hint">
                                <Trans t={t} i18nKey="panels:ai.noModelsInstalled" components={{ 1: <b />, 3: <code /> }} />
                            </div>
                        )}
                        {messages.length === 0 && !streaming && (
                            <div className="ai-panel__empty">
                                <p>{t(readOnly ? 'panels:ai.emptyChatReadOnly' : 'panels:ai.emptyChat', { cluster })}</p>
                                <div className="ai-starters">
                                    {STARTERS.map((k) => (
                                        <button key={k} type="button" className="ai-starter" onClick={() => { setInput(t(k)); inputRef.current?.focus(); }}>
                                            {t(k)}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                        {messages.map((m, i) => <Message key={i} msg={m} onOpenRef={openRef} />)}
                        {streaming && (
                            <div className="ai-msg ai-msg--assistant">
                                <ToolLines tools={liveTools} onOpenRef={openRef} />
                                {liveText && <ChatText text={liveText} onOpenRef={openRef} />}
                                <div className="ai-working" role="status">{t('panels:ai.workingFor', { seconds: elapsed })}</div>
                            </div>
                        )}
                    </div>

                    {confirm && <ConfirmCard key={confirm.id} req={confirm} onAnswer={answerConfirm} />}

                    <div className="ai-panel__compose">
                        {(refs.length > 0 || readOnly) && (
                            <div className="ai-chips">
                                {readOnly && (
                                    <span className="ai-chip ai-chip--mode" title={t('panels:ai.readOnlyHint')}>
                                        <VscLock size={11} aria-hidden /> {t('panels:ai.readOnly')}
                                    </span>
                                )}
                                {refs.map((r) => (
                                    <span key={refLabel(r)} className="ai-chip">
                                        <button type="button" className="ai-chip__open" onClick={() => openRef(r)}>{refLabel(r)}</button>
                                        <button
                                            type="button"
                                            className="ai-chip__remove"
                                            aria-label={t('panels:ai.removeRef', { ref: refLabel(r) })}
                                            title={t('panels:ai.removeRef', { ref: refLabel(r) })}
                                            onClick={() => setRefs((cur) => cur.filter((x) => refLabel(x) !== refLabel(r)))}
                                        >
                                            <VscClose size={11} />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        )}
                        <div className="ai-panel__input">
                            <textarea
                                ref={inputRef}
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                                placeholder={t(model ? 'panels:ai.messagePlaceholder' : 'panels:ai.noModelPlaceholder')}
                                aria-label={t('panels:ai.messagePlaceholder')}
                                rows={2}
                            />
                            {streaming
                                ? <Button className="ai-panel__send" icon={<VscDebugStop size={15} />} severity="danger" onClick={stop} aria-label={t('panels:ai.stop')} title={t('panels:ai.stop')} />
                                : <Button className="ai-panel__send" icon={<VscSend size={15} />} onClick={send} disabled={!input.trim() || !model} aria-label={t('panels:ai.send')} title={t('panels:ai.send')} />}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
