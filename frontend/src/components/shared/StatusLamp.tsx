import type { TagProps } from 'primereact/tag';

export type LampTone = 'ok' | 'warn' | 'err' | 'info' | 'idle';

/**
 * Maps the Tag severities the list helpers already return (`getStatusSeverity`
 * and friends), so a status column swaps `<Tag>` for a lamp without each
 * resource re-deciding what its states mean.
 */
export function toneFor(severity: TagProps['severity']): LampTone {
    switch (severity) {
        case 'success': return 'ok';
        case 'warning': return 'warn';
        case 'danger': return 'err';
        case 'info': return 'info';
        default: return 'idle';
    }
}

/**
 * A state read at a glance, and never by color alone: the lamp's shape carries
 * the meaning (● ok, ▲ warning, ■ fault, ◆ info, ○ idle) and the text says it.
 * Several themes put a warm accent next to --warn, and a color-blind user has
 * to read the same thing as everyone else.
 *
 * Status only. A label that is not a state (a Service type, a namespace) stays
 * a neutral `.p-tag`.
 */
export default function StatusLamp({ label, severity, tone, title, markOnly }: {
    label: string;
    severity?: TagProps['severity'];
    /** Overrides `severity` when the caller already knows the tone. */
    tone?: LampTone;
    title?: string;
    /** Just the lamp, for a row that already says what it is; the label stays for screen readers. */
    markOnly?: boolean;
}) {
    const t = tone ?? toneFor(severity);
    return (
        <span className={`lamp lamp--${t}`} title={title ?? label}>
            <span className="lamp__mark" aria-hidden="true" />
            <span className={markOnly ? 'sr-only' : 'lamp__label'}>{label}</span>
        </span>
    );
}
