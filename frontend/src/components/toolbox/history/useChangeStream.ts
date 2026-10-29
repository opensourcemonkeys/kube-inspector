import { useEffect, useRef, useState } from 'react';
import { StartToolboxStream, StopToolboxStream } from '../../../../wailsjs/go/controller_app/App';
import { EventsOn } from '../../../../wailsjs/runtime/runtime';
import type { models } from '../../../../wailsjs/go/models';

/** off: not asked for; live: changes arrive as recorded; failed: fall back to polling. */
export type StreamState = 'off' | 'connecting' | 'live' | 'failed';

/**
 * Follows toolbox's live change stream for `filter` (null: no stream) and
 * hands each change to `onChange`. A new filter starts a new stream. When the
 * stream cannot start or ends on its own — an older toolbox without one, a
 * dropped connection — the state turns "failed" and stays so for this filter:
 * the caller polls instead, and the next filter change tries again.
 */
export function useChangeStream(clusterName: string, filter: models.ToolboxChangeFilter | null, onChange: (c: models.ToolboxChange) => void): StreamState {
    const [state, setState] = useState<StreamState>('off');
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    // The filter's content, not its identity, decides when to restart.
    const key = filter ? JSON.stringify(filter) : '';

    useEffect(() => {
        if (!filter) {
            setState('off');
            return;
        }
        const id = `toolbox-stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        let first = true;
        setState('connecting');
        const offChange = EventsOn(`toolbox:change:${id}`, (c: models.ToolboxChange) => {
            if (first) { first = false; setState('live'); }
            onChangeRef.current(c);
        });
        const offEnd = EventsOn(`toolbox:stream-end:${id}`, () => setState('failed'));
        StartToolboxStream(id, clusterName, filter)
            // Started: live until it says otherwise. The first change may
            // take a while on a quiet cluster.
            .then(() => setState((s) => (s === 'connecting' ? 'live' : s)))
            .catch(() => setState('failed'));
        return () => {
            offChange();
            offEnd();
            void StopToolboxStream(id);
        };
    }, [clusterName, key]); // eslint-disable-line react-hooks/exhaustive-deps

    return state;
}
