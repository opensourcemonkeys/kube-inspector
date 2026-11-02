import { describe, it, expect, beforeEach } from 'vitest';
import { useAiChatStore, isReadOnly, MAX_MESSAGES, type ChatMessage } from './aiChatStore';

const KEY = 'kube-ins-ai-chat-store';

describe('aiChatStore', () => {
    beforeEach(() => {
        localStorage.clear();
        useAiChatStore.setState({ chats: {}, readOnly: {}, pending: {} });
    });

    it('ask leaves a prompt for that cluster only, taken once', () => {
        const ref = { resource: 'pods', namespace: 'shop', name: 'api-1' };
        useAiChatStore.getState().ask('prod', 'x', [ref]);
        expect(useAiChatStore.getState().takePending('dev')).toBeNull();
        expect(useAiChatStore.getState().takePending('prod')).toEqual({ text: 'x', refs: [ref] });
        expect(useAiChatStore.getState().takePending('prod')).toBeNull();
    });

    it('does not persist pending prompts', () => {
        useAiChatStore.getState().ask('prod', 'secret');
        const raw = localStorage.getItem(KEY) ?? '';
        expect(raw).not.toContain('pending');
        expect(raw).not.toContain('secret');
    });

    it('keeps one conversation per cluster', () => {
        const s = useAiChatStore.getState();
        s.setMessages('a', [{ role: 'user', content: 'in a' }]);
        s.setMessages('b', [{ role: 'user', content: 'in b' }]);
        s.clear('a');
        expect(useAiChatStore.getState().chats.a).toBeUndefined();
        expect(useAiChatStore.getState().chats.b?.[0].content).toBe('in b');
    });

    it('caps the history and tool results', () => {
        const many: ChatMessage[] = Array.from({ length: MAX_MESSAGES + 5 }, (_, i) => ({ role: 'user', content: String(i) }));
        many.push({ role: 'assistant', content: '', tools: [{ id: '1', name: 'list_pods', status: 'done', result: 'x'.repeat(10_000) }] });
        useAiChatStore.getState().setMessages('a', many);
        const kept = useAiChatStore.getState().chats.a!;
        expect(kept).toHaveLength(MAX_MESSAGES);
        expect(kept[kept.length - 1].tools![0].result!.length).toBeLessThanOrEqual(2000);
    });

    it('is read-only until a cluster opts in', () => {
        expect(isReadOnly(useAiChatStore.getState().readOnly, 'prod')).toBe(true);
        useAiChatStore.getState().setReadOnly('prod', false);
        expect(isReadOnly(useAiChatStore.getState().readOnly, 'prod')).toBe(false);
        expect(isReadOnly(useAiChatStore.getState().readOnly, 'dev')).toBe(true);
    });

    it('drops the v1 global conversation but keeps host and model', async () => {
        localStorage.setItem(KEY, JSON.stringify({
            state: { host: 'http://gpu:11434', model: 'qwen3', messages: [{ role: 'user', content: 'old' }] },
            version: 1,
        }));
        await useAiChatStore.persist.rehydrate();
        const s = useAiChatStore.getState();
        expect(s.host).toBe('http://gpu:11434');
        expect(s.model).toBe('qwen3');
        expect(s.chats).toEqual({});
        expect((s as unknown as Record<string, unknown>).messages).toBeUndefined();
    });
});
