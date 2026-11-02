import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
    role: ChatRole;
    content: string;
    // Tool-activity lines attached to an assistant turn (rendered console-style).
    // Their results go back to the model on later turns, so it keeps what it
    // learned; the backend already cut each one to a couple of KB.
    tools?: ToolLine[];
    // Why the turn ended early, shown as a fault line under whatever text had
    // already streamed. Older persisted messages carry it inline in `content`.
    error?: string;
    // The turn stopped at the backend's tool-call cap rather than finishing.
    toolLimit?: boolean;
    // Objects the user pointed at when sending this turn.
    refs?: AiRef[];
}

export interface ToolLine {
    id: string;
    name: string;
    status: 'running' | 'done' | 'declined' | 'error';
    mutating?: boolean;
    result?: string;
    args?: Record<string, unknown>;
}

/**
 * An object the user handed to the assistant ("ask about this pod"). It is
 * shown as a chip over the input and sent as context with the next turn.
 * `resource` is the plural resource name the generic object helpers take.
 */
export interface AiRef {
    resource: string;
    group?: string;
    namespace: string;
    name: string;
    container?: string;
}

interface Pending { text: string; refs: AiRef[] }

interface AiChatStore {
    host: string;
    model: string;
    /** One conversation per cluster: a chat is pinned to the cluster it talks to. */
    chats: Record<string, ChatMessage[]>;
    /** Per cluster; a cluster with no entry is read-only (see isReadOnly). */
    readOnly: Record<string, boolean>;
    /** A prompt handed to a cluster's assistant input, not yet taken. Never persisted. */
    pending: Record<string, Pending>;
    setHost: (host: string) => void;
    setModel: (model: string) => void;
    setMessages: (cluster: string, messages: ChatMessage[]) => void;
    clear: (cluster: string) => void;
    setReadOnly: (cluster: string, readOnly: boolean) => void;
    /** Leaves `text` (and `refs`) waiting in that cluster's input; nothing is sent. */
    ask: (cluster: string, text: string, refs?: AiRef[]) => void;
    takePending: (cluster: string) => Pending | null;
}

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';

/** Messages kept per cluster; older turns fall off the front. */
export const MAX_MESSAGES = 60;

/**
 * Writes are opt-in per cluster: until the user turns read-only off for a
 * cluster, the backend does not even offer the model a mutating tool there.
 */
export const isReadOnly = (readOnly: Record<string, boolean>, cluster: string) => readOnly[cluster] ?? true;

// The backend caps results at 2 KB already; this is the backstop for history
// written before that, so one old pod list cannot fill localStorage.
const RESULT_CAP = 2000;
const capResult = (m: ChatMessage): ChatMessage =>
    m.tools?.some((t) => (t.result?.length ?? 0) > RESULT_CAP)
        ? { ...m, tools: m.tools.map((t) => (t.result && t.result.length > RESULT_CAP ? { ...t, result: t.result.slice(0, RESULT_CAP) } : t)) }
        : m;

export const useAiChatStore = create<AiChatStore>()(
    persist(
        (set, get) => ({
            host: DEFAULT_OLLAMA_HOST,
            model: '',
            chats: {},
            readOnly: {},
            pending: {},
            setHost: (host) => set({ host }),
            setModel: (model) => set({ model }),
            setMessages: (cluster, messages) =>
                set((s) => ({ chats: { ...s.chats, [cluster]: messages.slice(-MAX_MESSAGES).map(capResult) } })),
            clear: (cluster) =>
                set((s) => {
                    const chats = { ...s.chats };
                    delete chats[cluster];
                    return { chats };
                }),
            setReadOnly: (cluster, readOnly) => set((s) => ({ readOnly: { ...s.readOnly, [cluster]: readOnly } })),
            ask: (cluster, text, refs = []) => set((s) => ({ pending: { ...s.pending, [cluster]: { text, refs } } })),
            takePending: (cluster) => {
                const p = get().pending[cluster];
                if (!p) return null;
                set((s) => {
                    const pending = { ...s.pending };
                    delete pending[cluster];
                    return { pending };
                });
                return p;
            },
        }),
        {
            name: 'kube-ins-ai-chat-store',
            storage: createJSONStorage(() => localStorage),
            version: 2,
            partialize: (s) => ({ host: s.host, model: s.model, chats: s.chats, readOnly: s.readOnly }),
            // v1 kept one global conversation that was sent to whichever
            // cluster happened to be selected. Which cluster each turn talked
            // to is unknowable, so it is dropped rather than guessed at.
            migrate: (persisted, version) => {
                const p = (persisted ?? {}) as Record<string, unknown>;
                if (version < 2) {
                    return { host: p.host ?? DEFAULT_OLLAMA_HOST, model: p.model ?? '', chats: {}, readOnly: {} };
                }
                return p;
            },
        },
    ),
);
