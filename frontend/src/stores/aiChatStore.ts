import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
    role: ChatRole;
    content: string;
    // Tool-activity lines attached to an assistant turn (rendered console-style).
    tools?: ToolLine[];
    // Why the turn ended early, shown as a fault line under whatever text had
    // already streamed. Older persisted messages carry it inline in `content`.
    error?: string;
}

export interface ToolLine {
    id: string;
    name: string;
    status: 'running' | 'done' | 'declined' | 'error';
    mutating?: boolean;
    result?: string;
    args?: Record<string, unknown>;
}

interface AiChatStore {
    open: boolean;
    host: string;
    model: string;
    messages: ChatMessage[];
    // A prompt handed to the assistant's input, not yet taken. Never persisted.
    pendingPrompt: string | null;
    setOpen: (open: boolean) => void;
    toggle: () => void;
    setHost: (host: string) => void;
    setModel: (model: string) => void;
    setMessages: (messages: ChatMessage[]) => void;
    clear: () => void;
    /** Opens the panel with `text` waiting in the input; nothing is sent. */
    ask: (text: string) => void;
    takePendingPrompt: () => string | null;
}

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';

export const useAiChatStore = create<AiChatStore>()(
    persist(
        (set, get) => ({
            open: false,
            host: DEFAULT_OLLAMA_HOST,
            model: '',
            messages: [],
            pendingPrompt: null,
            setOpen: (open) => set({ open }),
            toggle: () => set((s) => ({ open: !s.open })),
            setHost: (host) => set({ host }),
            setModel: (model) => set({ model }),
            setMessages: (messages) => set({ messages }),
            clear: () => set({ messages: [] }),
            ask: (text) => set({ open: true, pendingPrompt: text }),
            takePendingPrompt: () => {
                const p = get().pendingPrompt;
                if (p !== null) set({ pendingPrompt: null });
                return p;
            },
        }),
        {
            name: 'kube-ins-ai-chat-store',
            storage: createJSONStorage(() => localStorage),
            version: 1,
            // Don't persist the open state — the window starts closed each launch.
            partialize: (s) => ({ host: s.host, model: s.model, messages: s.messages }),
        },
    ),
);
