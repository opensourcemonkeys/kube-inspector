import { BrowserOpenURL } from '../../../wailsjs/runtime/runtime';
import type { AiRef, ChatMessage, ToolLine } from '../../stores/aiChatStore';
import { InlineMarkdown, type CodeRenderer } from '../../lib/inlineMarkdown';
import { useT } from '../../i18n/useT';
import StatusLamp, { type LampTone } from '../shared/StatusLamp';
import { parseObjectRef, refFromToolArgs, refLabel } from './refs';

type OpenRef = (ref: AiRef) => void;

// One turn of the log. The user's line carries the accent notch and a "You"
// marker; the assistant's is plain text on the screen, no bubble.
export function Message({ msg, onOpenRef }: { msg: ChatMessage; onOpenRef: OpenRef }) {
    const t = useT();
    return (
        <div className={`ai-msg ai-msg--${msg.role}`}>
            {msg.role === 'user' && <span className="ai-msg__who">{t('panels:ai.you')}</span>}
            {msg.refs && msg.refs.length > 0 && (
                <div className="ai-chips ai-chips--sent">
                    {msg.refs.map((r) => (
                        <button key={refLabel(r)} type="button" className="ai-chip" onClick={() => onOpenRef(r)}>{refLabel(r)}</button>
                    ))}
                </div>
            )}
            {msg.tools && msg.tools.length > 0 && <ToolLines tools={msg.tools} onOpenRef={onOpenRef} />}
            {msg.content && (msg.role === 'assistant'
                ? <ChatText text={msg.content} onOpenRef={onOpenRef} />
                : <div className="ai-msg__text">{msg.content}</div>)}
            {msg.toolLimit && <div className="ai-msg__note">{t('panels:ai.toolLimit')}</div>}
            {msg.error !== undefined && (
                <div className="ai-msg__error" role="alert">
                    <StatusLamp label={t('panels:ai.toolStatus.error')} tone="err" />
                    <span>{msg.error || t('panels:ai.requestFailed')}</span>
                </div>
            )}
        </div>
    );
}

/**
 * The assistant's prose: fenced blocks as preformatted code, everything else a
 * line at a time through the HTML-free inline renderer (the text comes from a
 * model, which is no more trusted than the network). A `kind/ns/name` code
 * span is a link to that object.
 */
export function ChatText({ text, onOpenRef }: { text: string; onOpenRef: OpenRef }) {
    const renderCode: CodeRenderer = (code, key) => {
        const ref = parseObjectRef(code);
        if (!ref) return undefined;
        return (
            <button key={key} type="button" className="ai-ref" onClick={() => onOpenRef(ref)}>
                {code}
            </button>
        );
    };
    const blocks = splitFences(text);
    return (
        <div className="ai-msg__text">
            {blocks.map((b, i) => b.code !== undefined
                ? <pre key={i} className="ai-msg__code">{b.code}</pre>
                : (
                    <div key={i} className="ai-msg__para">
                        {b.text.split('\n').map((line, j) => (
                            <div key={j} className="ai-msg__line">
                                {line ? <InlineMarkdown text={line} onLink={BrowserOpenURL} renderCode={renderCode} /> : ' '}
                            </div>
                        ))}
                    </div>
                ))}
        </div>
    );
}

type Block = { text: string; code?: undefined } | { code: string; text?: undefined };

/** Splits text on ``` fences; an unclosed fence (still streaming) runs to the end. */
export function splitFences(text: string): Block[] {
    const out: Block[] = [];
    const parts = text.split(/^```[^\n]*\n?/m);
    parts.forEach((part, i) => {
        if (i % 2 === 1) out.push({ code: part.replace(/\n$/, '') });
        else {
            const trimmed = part.replace(/^\n+|\n+$/g, '');
            if (trimmed) out.push({ text: trimmed });
        }
    });
    return out;
}

const TOOL_TONE: Record<ToolLine['status'], LampTone> = { running: 'info', done: 'ok', declined: 'idle', error: 'err' };

// A tool call as an instrument log line: lamp, tool name, the object it
// touched (a link), and its outcome.
export function ToolLines({ tools, onOpenRef }: { tools: ToolLine[]; onOpenRef: OpenRef }) {
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
            {tools.map((tool) => {
                const ref = refFromToolArgs(tool.name, tool.args);
                return (
                    <li key={tool.id} className={`ai-tool ai-tool--${tool.status}`}>
                        <StatusLamp markOnly label={statusLabel(tool.status)} tone={TOOL_TONE[tool.status] ?? 'idle'} />
                        <span className="ai-tool__name">{tool.name}</span>
                        {ref && (
                            <button type="button" className="ai-ref ai-tool__ref" onClick={() => onOpenRef(ref)}>{refLabel(ref)}</button>
                        )}
                        {tool.mutating && <span className="ai-tool__badge">{t('panels:ai.mutating')}</span>}
                        <span className="ai-tool__status" title={tool.status === 'error' ? tool.result : undefined}>{statusLabel(tool.status)}</span>
                    </li>
                );
            })}
        </ul>
    );
}
