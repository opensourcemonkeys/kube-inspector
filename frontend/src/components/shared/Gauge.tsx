import { USAGE_ERR, USAGE_WARN, usageTone } from '../../lib/usage';

/**
 * A usage reading drawn as an instrument scale: a recessed track with a tick
 * every 10%, the warn and act thresholds marked where they sit, the filled
 * portion in the reading's tone and a needle at the value.
 *
 * The thresholds being visible is the point: "45%" alone says nothing about
 * how close to trouble it is; 45% on a scale with a mark at 60 does. The
 * number is always printed, so the colour is never the only signal.
 *
 * `compact` drops the head and the scale labels, for a row of node readings.
 */
export default function Gauge({ value, label, detail, compact }: {
    /** 0–100. */
    value: number;
    label: string;
    /** Absolute figures beside the percentage, e.g. "1.2 cores of 16.00 cores". */
    detail?: string;
    compact?: boolean;
}) {
    const v = Math.max(0, Math.min(100, value));
    const tone = usageTone(v);
    return (
        <div
            className={`gauge gauge--${tone}${compact ? ' gauge--compact' : ''}`}
            role="meter"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(v)}
            aria-valuetext={detail ? `${Math.round(v)}%, ${detail}` : `${Math.round(v)}%`}
        >
            {compact ? (
                <span className="gauge__label">{label}</span>
            ) : (
                <div className="gauge__head">
                    <span className="gauge__label">{label}</span>
                    <span className="gauge__value">{Math.round(v)}%</span>
                    {detail && <span className="gauge__detail">{detail}</span>}
                </div>
            )}
            <div className="gauge__scale">
                <div className="gauge__fill" style={{ width: `${v}%` }} />
                <span className="gauge__mark gauge__mark--warn" style={{ left: `${USAGE_WARN}%` }} />
                <span className="gauge__mark gauge__mark--err" style={{ left: `${USAGE_ERR}%` }} />
                <span className="gauge__needle" style={{ left: `${v}%` }} />
            </div>
            {compact ? (
                <span className="gauge__value">{Math.round(v)}%</span>
            ) : (
                <div className="gauge__ticks" aria-hidden="true">
                    <span>0</span><span>50</span><span>100</span>
                </div>
            )}
        </div>
    );
}
