import { useEffect, useRef, useState } from 'react';
import type { models } from '../../../../wailsjs/go/models';
import { ROLLBACK_FIELD_MANAGER } from './RollbackDialog';

const POLL_MS = 5_000;
// toolbox writes a change it could not attribute only after its retry
// (enrich.retryAfter, 90s), so give that time plus a poll or two.
const GIVE_UP_MS = 120_000;
// The cluster's clock and ours need not agree to the second.
const CLOCK_SLACK_MS = 5_000;

interface Target {
    at: number;
    resource: string;
    namespace: string;
    name: string;
}

/**
 * After a rollback, keeps refreshing a list until toolbox has recorded the
 * rollback itself (it lands after toolbox's enrich delay, ~15s), then names
 * that row so it can be marked. Gives up after two minutes: a filter may simply
 * hide the row.
 */
export function useRollbackFollowUp(refresh: () => void, items: models.ToolboxChange[]) {
    const [target, setTarget] = useState<Target | null>(null);
    const [found, setFound] = useState<string | null>(null);
    const refreshRef = useRef(refresh);
    refreshRef.current = refresh;

    useEffect(() => {
        if (!target) return;
        const poll = setInterval(() => refreshRef.current(), POLL_MS);
        const stop = setTimeout(() => setTarget(null), GIVE_UP_MS);
        return () => { clearInterval(poll); clearTimeout(stop); };
    }, [target]);

    useEffect(() => {
        if (!target) return;
        const hit = items.find((c) => c.fieldManager === ROLLBACK_FIELD_MANAGER
            && c.resource === target.resource && c.namespace === target.namespace && c.name === target.name
            && Date.parse(c.time) >= target.at - CLOCK_SLACK_MS);
        if (hit) {
            setFound(hit.eventId);
            setTarget(null);
        }
    }, [items, target]);

    return {
        follow: (t: Target) => { setFound(null); setTarget(t); },
        /** The rollback's own recorded change, once it has shown up. */
        found,
        waiting: target !== null,
    };
}
