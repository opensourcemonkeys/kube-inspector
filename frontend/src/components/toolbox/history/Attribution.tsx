import { useT } from '../../../i18n/useT';

export const ATTRIBUTIONS = ['audit', 'admission', 'managedFields', 'none'] as const;
type Known = typeof ATTRIBUTIONS[number];

// How much of the actor each source tells us: audit adds network details to
// what admission knows, managedFields knows only the client's name.
const LEVEL: Record<Known, number> = { audit: 3, admission: 2, managedFields: 1, none: 0 };

const isKnown = (v: string): v is Known => (ATTRIBUTIONS as readonly string[]).includes(v);

/**
 * Where a change's actor came from, as a three-step mark (●●● audit … ○○○
 * none) beside a readable label. The mark is shape, not colour, and is
 * decorative: the label carries the meaning, the tooltip what the source
 * gives.
 */
export default function Attribution({ value }: { value: string }) {
    const t = useT();
    const known = isKnown(value) ? value : null;
    const level = known ? LEVEL[known] : 0;
    return (
        <span className="history-via" title={known ? t(`panels:clusterHistory.viaHint.${known}`) : undefined}>
            <span className="history-via__mark" aria-hidden>{'●'.repeat(level)}{'○'.repeat(3 - level)}</span>
            {known ? t(`panels:clusterHistory.via.${known}`) : value}
        </span>
    );
}
