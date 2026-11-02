import { useCallback } from 'react';
import { useTabContext } from '../../contexts/TabContext';
import { useAiChatStore, type AiRef } from '../../stores/aiChatStore';

/**
 * "Ask AI about this": leaves `text` (and the objects in `refs`, as chips) in
 * the cluster's assistant input and opens or focuses its tab. Nothing is sent
 * — the user reads the prompt first.
 */
export function useAskAi() {
    const { openAiAssistant } = useTabContext();
    const ask = useAiChatStore((s) => s.ask);
    return useCallback((cluster: string, text: string, refs?: AiRef[]) => {
        if (!cluster) return;
        ask(cluster, text, refs);
        openAiAssistant(cluster);
    }, [ask, openAiAssistant]);
}
