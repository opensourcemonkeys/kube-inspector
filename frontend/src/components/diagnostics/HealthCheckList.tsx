import { models } from '../../../wailsjs/go/models';
import { useT } from '../../i18n/useT';
import StatusLamp, { type LampTone } from '../shared/StatusLamp';

const STATUS_TONE: Record<string, LampTone> = { ok: 'ok', warn: 'warn', fail: 'err', skip: 'idle' };

/**
 * Renders the preflight rows in the order the backend returned them. That order
 * is fixed on the Go side precisely so rows do not reshuffle between runs — a
 * list that reorders itself is unreadable when half of it is still resolving.
 */
export default function HealthCheckList({
    checks,
    running,
}: {
    checks: models.HealthCheck[];
    running: boolean;
}) {
    const t = useT();
    const statusLabel = (status: string) => {
        switch (status) {
            case 'ok': return t('panels:diagnostics.checkStatus.ok');
            case 'warn': return t('panels:diagnostics.checkStatus.warn');
            case 'fail': return t('panels:diagnostics.checkStatus.fail');
            case 'skip': return t('panels:diagnostics.checkStatus.skip');
            default: return status;
        }
    };
    if (!checks.length) {
        return (
            <div className="diag-empty">
                {t(running ? 'panels:diagnostics.checksRunning' : 'panels:diagnostics.checksNone')}
            </div>
        );
    }

    return (
        <div className="diag-checks">
            {checks.map((c) => (
                <div className="diag-check" key={c.name}>
                    <span className="diag-check__status">
                        <StatusLamp label={statusLabel(c.status)} tone={STATUS_TONE[c.status] ?? 'idle'} />
                    </span>
                    <div className="diag-check__body">
                        <div className="diag-check__label">{c.label}</div>
                        <div className="diag-check__detail">{c.detail}</div>
                    </div>
                    {c.durationMs > 0 && (
                        <span className="diag-check__ms">{t('panels:diagnostics.durationMs', { ms: c.durationMs })}</span>
                    )}
                </div>
            ))}
        </div>
    );
}
