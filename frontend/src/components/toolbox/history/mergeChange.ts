import type { models } from '../../../../wailsjs/go/models';

/**
 * Puts a streamed change in its place in a newest-first list: a change already
 * listed (the stream resends what the list may hold) is replaced, a new one
 * goes where its time puts it — a change written after its retry is older
 * than ones that arrived before it.
 */
export function mergeChange(list: models.ToolboxChange[], c: models.ToolboxChange): models.ToolboxChange[] {
    const at = list.findIndex((x) => x.eventId === c.eventId);
    if (at >= 0) {
        const next = list.slice();
        next[at] = c;
        return next;
    }
    const t = Date.parse(c.time);
    const i = list.findIndex((x) => Date.parse(x.time) < t);
    return i < 0 ? [...list, c] : [...list.slice(0, i), c, ...list.slice(i)];
}
