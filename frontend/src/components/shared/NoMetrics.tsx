import StatusLamp from './StatusLamp';
import { useT } from '../../i18n/useT';

/**
 * Where a usage reading would be, when the cluster has no metrics-server.
 *
 * Not a warning: nothing is broken, a component is simply not installed. It
 * used to be a full-width saturated yellow banner on Overview and Monitoring;
 * now it takes the gauges' place quietly, with the fix on a second line.
 */
export default function NoMetrics() {
    const t = useT();
    return (
        <div className="no-metrics">
            <StatusLamp tone="idle" label={t('panels:metrics.unavailableTitle')} />
            <span className="no-metrics__hint">{t('panels:metrics.unavailableHint')}</span>
        </div>
    );
}
