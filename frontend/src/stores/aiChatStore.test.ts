import { describe, it, expect, beforeEach } from 'vitest';
import { useAiChatStore } from './aiChatStore';

describe('aiChatStore prompts', () => {
    beforeEach(() => {
        localStorage.clear();
        useAiChatStore.setState({ open: false, messages: [], pendingPrompt: null });
    });

    it('ask opens the panel and leaves a prompt', () => {
        useAiChatStore.getState().ask('x');
        expect(useAiChatStore.getState().open).toBe(true);
        expect(useAiChatStore.getState().takePendingPrompt()).toBe('x');
        expect(useAiChatStore.getState().takePendingPrompt()).toBeNull();
    });

    it('does not persist pendingPrompt', () => {
        useAiChatStore.getState().ask('secret');
        const raw = localStorage.getItem('kube-ins-ai-chat-store') ?? '';
        expect(raw).not.toContain('pendingPrompt');
        expect(raw).not.toContain('secret');
    });
});
