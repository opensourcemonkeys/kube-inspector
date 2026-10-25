import StatusLamp, { type LampTone } from '../../shared/StatusLamp';

// toolbox verbs are data (the API verb class that happened), so they are shown
// as recorded, not translated.
const VERB_TONE: Record<string, LampTone> = { create: 'ok', update: 'info', delete: 'err', finalized: 'idle' };

export function verbLamp(verb: string) {
    return <StatusLamp label={verb} tone={VERB_TONE[verb] ?? 'idle'} />;
}

/** Local time, to the second, in a fixed sortable shape. */
export function formatTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
