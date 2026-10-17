import type { ReactNode } from 'react';

/**
 * Log-level highlighting for the log viewer, plugged into LazyLog's
 * `formatPart`. Only the level token is coloured — the rest of the line keeps
 * the plain log colour, and copy/save read the raw buffer, so nothing is ever
 * written into the text itself.
 *
 * Prose is full of the words "error" and "info", so a bare lowercase word is
 * never taken as a level. What counts:
 *  - an upper-case level word: `ERROR`, `WARN`, `INFO`, ...
 *  - a key/value level in any case: `level=error`, `"level":"warn"`, `lvl=dbug`
 *  - a bracketed lower-case level: `[info]`
 *  - the klog header Kubernetes components write: `E1017 12:00:00.123456`
 * Only the first match in a part is coloured: that is where a level sits, and a
 * message that later says "ERROR" is still an INFO line.
 */

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_RE = new RegExp(
    [
        String.raw`\b(?:[Ll]evel|LEVEL|[Ll]vl|LVL|[Ss]everity|SEVERITY)["']?\s*[=:]\s*["']?([A-Za-z]+)`,
        String.raw`\b(FATAL|PANIC|CRITICAL|CRIT|ERROR|ERR|WARNING|WARN|INFO|DEBUG|TRACE)\b`,
        String.raw`\[(fatal|panic|error|err|warning|warn|info|debug|trace)\]`,
        String.raw`(?:^|\s)([IWEF])\d{4} \d{2}:\d{2}:\d{2}\.\d`,
    ].join('|'),
    'g',
);

function toLevel(word: string): LogLevel | null {
    switch (word.toLowerCase()) {
        case 'fatal': case 'panic': case 'crit': case 'critical': case 'f':
            return 'fatal';
        case 'error': case 'err': case 'eror': case 'e':
            return 'error';
        case 'warn': case 'warning': case 'w':
            return 'warn';
        case 'info': case 'inf': case 'i':
            return 'info';
        case 'debug': case 'dbug': case 'dbg': case 'trace':
            return 'debug';
        default:
            return null;
    }
}

export interface LevelMatch {
    start: number;
    end: number;
    level: LogLevel;
}

/** Finds the level token in `text`, or null. Exported for tests. */
export function findLevel(text: string): LevelMatch | null {
    for (const m of text.matchAll(LEVEL_RE)) {
        const word = m[1] ?? m[2] ?? m[3] ?? m[4];
        const level = word ? toLevel(word) : null;
        if (!level) continue;
        const idx = m.index ?? 0;
        let start: number;
        if (m[1] !== undefined) start = idx + m[0].length - word.length; // value ends the match
        else if (m[3] !== undefined) start = idx + 1; // inside the brackets
        else if (m[4] !== undefined) start = idx + m[0].search(/[IWEF]/);
        else start = idx;
        return { start, end: start + word.length, level };
    }
    return null;
}

export function formatLogLevel(text: string): ReactNode {
    const m = findLevel(text);
    if (!m) return text;
    return (
        <>
            {text.slice(0, m.start)}
            <span className={`log-lvl log-lvl--${m.level}`}>{text.slice(m.start, m.end)}</span>
            {text.slice(m.end)}
        </>
    );
}
