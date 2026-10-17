/**
 * The log viewer's line buffer: complete lines, newest last, capped at
 * `maxLines`. A chatty pod emits megabytes a minute, and the panel once held
 * every byte of it in one ever-growing string — a renderer OOM given enough
 * time. Same shape as `stores/metricsStore`'s MAX_POINTS: keep the newest N,
 * say so on screen, drop the rest.
 *
 * Partial lines are held **per source**. A stream chunk boundary is not a line
 * boundary, and with several streams feeding one panel (every container, or
 * every pod of a workload) a shared tail would glue the end of one pod's line
 * onto the start of another's.
 */
export interface LogBuffer {
    /** Appends a stream chunk. `prefix` is put in front of every line from `source`. */
    push(source: string, chunk: string, prefix?: string): void;
    /** A source ended: its partial last line becomes a complete one. */
    end(source: string): void;
    /** Appends one complete line that belongs to no stream (a notice, an error). */
    note(line: string): void;
    /** Everything currently held, partial lines last. */
    text(): string;
    clear(): void;
    /** True once at least one line has been dropped since the last clear(). */
    readonly truncated: boolean;
}

export function createLogBuffer(maxLines: number): LogBuffer {
    let lines: string[] = [];
    const tails = new Map<string, { prefix: string; text: string }>();
    let truncated = false;

    const trim = () => {
        if (lines.length > maxLines) {
            lines = lines.slice(lines.length - maxLines);
            truncated = true;
        }
    };

    return {
        push(source, chunk, prefix = '') {
            if (!chunk) return;
            const prev = tails.get(source);
            const parts = ((prev?.text ?? '') + chunk).split('\n');
            const rest = parts.pop() ?? '';
            for (const part of parts) lines.push(prefix + part);
            if (rest) tails.set(source, { prefix, text: rest });
            else tails.delete(source);
            // Trimming on every push would copy the array per event; the
            // panel calls text() on a timer, which trims anyway. This only
            // bounds memory while nothing is reading.
            if (lines.length > maxLines * 2) trim();
        },
        end(source) {
            const tail = tails.get(source);
            if (!tail) return;
            lines.push(tail.prefix + tail.text);
            tails.delete(source);
        },
        note(line) {
            lines.push(line);
        },
        text() {
            trim();
            if (tails.size === 0) return lines.join('\n');
            const partial = [...tails.values()].map(t => t.prefix + t.text);
            return [...lines, ...partial].join('\n');
        },
        clear() {
            lines = [];
            tails.clear();
            truncated = false;
        },
        get truncated() {
            return truncated;
        },
    };
}
