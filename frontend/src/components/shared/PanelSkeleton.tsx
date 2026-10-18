import { useT } from '../../i18n/useT';

// Widths cycle so the placeholder reads as rows of a table rather than stripes.
const WIDTHS = ['62%', '48%', '71%', '55%', '66%', '44%', '58%', '69%'];

/**
 * Placeholder rows while a list's first fetch is in flight.
 *
 * Static on purpose: no shimmer, no spinner. A loop is motion nobody asked for,
 * and the shape of the coming table already tells the user what is loading.
 * The label is for assistive tech; sighted users read the shape.
 */
export function ListSkeleton({ rows = 8 }: { rows?: number }) {
    const t = useT();
    return (
        <div className="skeleton" role="status" aria-busy="true">
            <span className="sr-only">{t('status.loading')}</span>
            {Array.from({ length: rows }, (_, i) => (
                <div key={i} className="skeleton__row">
                    <span className="skeleton__bar" style={{ width: WIDTHS[i % WIDTHS.length] }} />
                    <span className="skeleton__bar skeleton__bar--short" />
                </div>
            ))}
        </div>
    );
}

/**
 * What a lazily-loaded panel shows while its chunk is downloading.
 *
 * Deliberately tiny: a fallback that pulled in anything heavy would defeat the
 * code splitting it exists to serve. Shares the list views' loading state, so a
 * first open and a first fetch look the same.
 */
export default function PanelSkeleton() {
    return (
        <div className="skeleton-panel">
            <div className="skeleton-panel__toolbar">
                <span className="skeleton__bar" style={{ width: '9rem' }} />
            </div>
            <ListSkeleton />
        </div>
    );
}
