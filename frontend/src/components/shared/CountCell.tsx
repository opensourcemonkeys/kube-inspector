import type { TagProps } from 'primereact/tag';
import { toneFor } from './StatusLamp';

/**
 * A count in a table cell — "2/3" ready, "4" keys, "1 / 1" replicas.
 *
 * These used to be pills, one per row per column, so a list of forty pods was
 * three columns of coloured capsules. A count is read, not scanned for: plain
 * tabular figures, tinted only when the number itself is bad news (fewer ready
 * than wanted), so a healthy list is quiet and a broken row stands out.
 */
export default function CountCell({ value, severity }: {
    value: string | number;
    /** The same severity the list helpers return; only warn/err tint. */
    severity?: TagProps['severity'];
}) {
    const tone = toneFor(severity);
    return <span className={`cell-count cell-count--${tone}`}>{value}</span>;
}
