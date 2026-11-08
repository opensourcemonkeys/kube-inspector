import { useEffect, useRef, useState } from 'react';
import { Button } from 'primereact/button';
import { ProgressBar } from 'primereact/progressbar';
import { MigrationCancel, MigrationGetRunning, MigrationStartCutover } from '../../../../wailsjs/go/controller_app/App';
import { EventsOn } from '../../../../wailsjs/runtime/runtime';
import type { models } from '../../../../wailsjs/go/models';
import { useT } from '../../../i18n/useT';
import { errText } from '../../../lib/errText';
import ConfirmActionDialog from '../../shared/ConfirmActionDialog';
import { ListSkeleton } from '../../shared/PanelSkeleton';
import StatusLamp from '../../shared/StatusLamp';
import ClusterName from './ClusterName';
import { formatSize, isFinished, phaseTone } from './migrationModel';

const ASK_CUTOVER = 'cutover';
const ASK_CANCEL = 'cancel';
type Ask = typeof ASK_CUTOVER | typeof ASK_CANCEL;

const STEP_STARTS_TARGET = 'apply';

const POLL_MS = 5000;
/** How long after the last event the saved state may replace the live one. */
const EVENT_QUIET_MS = 10000;

/**
 * A migration under way. Events carry the detail; a slow poll notices the end
 * of a migration whose last event came before this panel subscribed, and keeps
 * a window that is not driving the migration up to date.
 */
export default function MigrationProgressView({ id, source, onFinished }: {
    id: string;
    source: string;
    onFinished: () => void;
}) {
    const t = useT();
    const [progress, setProgress] = useState<models.MigrationProgress | null>(null);
    const [ask, setAsk] = useState<Ask | null>(null);
    const [error, setError] = useState('');
    const lastEvent = useRef(0);

    useEffect(() => EventsOn(`migration:progress:${id}`, (next: models.MigrationProgress) => {
        lastEvent.current = Date.now();
        setProgress(next);
    }), [id]);

    useEffect(() => {
        let stale = false;
        const read = () => MigrationGetRunning(source).then((running) => {
            if (stale) return;
            if (!running || running.id !== id) {
                onFinished();
            } else if (Date.now() - lastEvent.current > EVENT_QUIET_MS) {
                setProgress(running);
            }
        }).catch(() => {});
        void read();
        const timer = window.setInterval(() => void read(), POLL_MS);
        return () => { stale = true; window.clearInterval(timer); };
    }, [id, source, onFinished]);

    const phase = progress?.phase ?? '';
    useEffect(() => { if (isFinished(phase)) onFinished(); }, [phase, onFinished]);

    if (!progress) return <div className="mig-body"><ListSkeleton /></div>;

    const interrupted = progress.interrupted;
    const switching = phase === 'cutover';
    const canSwitch = phase === 'ready' || interrupted;
    // A switch that stopped before the target started can still be undone.
    const canAbandon = interrupted && progress.step !== STEP_STARTS_TARGET;
    const hint = switching ? '' : phase === 'ready' ? t('panels:migration.progress.readyHint', { source: progress.source }) : t('panels:migration.progress.copyingHint');
    const switchNow = async () => {
        setError('');
        await MigrationStartCutover(id);
    };
    const continueNow = () => { switchNow().catch((e) => setError(errText(e))); };

    return (
        <div className="mig-body">
            <p className="mig-route">
                <ClusterName name={progress.source} />
                <span aria-hidden>→</span>
                <ClusterName name={progress.target} />
                <StatusLamp tone={interrupted ? 'err' : phaseTone(phase)} label={t(`panels:migration.phase.${phase}` as never)} />
            </p>
            {switching && progress.step && !interrupted && <p className="tool-panel__intro">{t(`panels:migration.step.${progress.step}` as never)}</p>}
            {hint && <p className="tool-panel__intro">{hint}</p>}
            {interrupted && <p className="dlg-error mig-error">{progress.error ? t('panels:migration.progress.interrupted', { error: progress.error }) : t('panels:migration.progress.interruptedNoError')}</p>}
            {!interrupted && progress.error && <p className="dlg-error mig-error">{progress.error}</p>}
            {error && <p className="dlg-error mig-error">{error}</p>}

            <section className="mig-section">
                <table className="mig-table">
                    <thead>
                        <tr>
                            <th>{t('panels:migration.preflight.colDisk')}</th>
                            <th>{t('panels:migration.preflight.colSize')}</th>
                            <th>{t('panels:migration.progress.colCopied')}</th>
                            <th className="mig-table__wide">{t('panels:migration.progress.colState')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {(progress.disks ?? []).map((d) => (
                            <tr key={`${d.namespace}/${d.name}`}>
                                <td className="cell-mono">{d.namespace}/{d.name}</td>
                                <td className="cell-mono">{d.size}</td>
                                <td className="cell-mono">{d.bytesCopied > 0 ? formatSize(d.bytesCopied) : <span className="cell-empty">—</span>}</td>
                                <td>
                                    {d.running && <ProgressBar value={d.percent} showValue={false} className="mig-progress" />}
                                    <span className="mig-disk-note">
                                        {!d.copy ? t('panels:migration.preflight.copyNo')
                                            : d.running ? `${d.percent}% ${d.rate ?? ''}`
                                            : !d.liveCopy ? t('panels:migration.preflight.copyFinalOnly')
                                            : t('panels:migration.progress.passes', { count: d.passes })}
                                    </span>
                                    {d.error && <span className="cell-err mig-disk-note">{d.error === 'unreachable' ? t('panels:migration.progress.unreachable') : d.error}</span>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>

            <div className="dlg-actions mig-actions">
                <Button label={canAbandon ? t('panels:migration.progress.abandon') : t('panels:migration.progress.cancel')} severity="danger" disabled={switching && !canAbandon} onClick={() => setAsk(ASK_CANCEL)} />
                {interrupted
                    ? <Button label={t('panels:migration.progress.continue')} onClick={continueNow} />
                    : <Button label={t('panels:migration.progress.start')} disabled={!canSwitch} onClick={() => setAsk(ASK_CUTOVER)} />}
            </div>

            <ConfirmActionDialog visible={ask === ASK_CUTOVER} header={t('panels:migration.progress.confirmHeader')} severity="warning"
                message={t('panels:migration.progress.confirmBody')}
                extra={<p className="mig-route"><ClusterName name={progress.source} /><span aria-hidden>→</span><ClusterName name={progress.target} /></p>}
                confirmLabel={t('panels:migration.progress.confirmButton')}
                onHide={() => setAsk(null)} onConfirm={switchNow} />
            <ConfirmActionDialog visible={ask === ASK_CANCEL} header={canAbandon ? t('panels:migration.progress.abandonHeader') : t('panels:migration.progress.cancelHeader')} severity="danger"
                message={canAbandon ? t('panels:migration.progress.abandonBody') : t('panels:migration.progress.cancelBody')}
                confirmLabel={canAbandon ? t('panels:migration.progress.abandon') : t('panels:migration.progress.cancelButton')}
                onHide={() => setAsk(null)} onConfirm={() => MigrationCancel(id)} />
        </div>
    );
}
