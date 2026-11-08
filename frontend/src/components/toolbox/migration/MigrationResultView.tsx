import { useCallback, useEffect, useState } from 'react';
import type { DockviewPanelApi } from 'dockview';
import { Button } from 'primereact/button';
import { VscRefresh } from 'react-icons/vsc';
import { MigrationGetResult, MigrationRestartSource } from '../../../../wailsjs/go/controller_app/App';
import type { models } from '../../../../wailsjs/go/models';
import { useT } from '../../../i18n/useT';
import { errText } from '../../../lib/errText';
import { usePanelActive } from '../../../lib/usePanelActive';
import ConfirmActionDialog from '../../shared/ConfirmActionDialog';
import { ListSkeleton } from '../../shared/PanelSkeleton';
import RowAction from '../../shared/RowAction';
import StatusLamp from '../../shared/StatusLamp';
import { formatDuration } from '../history/gaps';
import ClusterName from './ClusterName';
import { formatSize, notReadyCount, phaseTone } from './migrationModel';

const POLL_MS = 5000;

/** What a migration left behind, on one page. It only reports: nothing here acts on its own. */
export default function MigrationResultView({ id, api, onNew }: {
    id: string;
    api?: DockviewPanelApi;
    onNew: () => void;
}) {
    const t = useT();
    const active = usePanelActive(api);
    const [result, setResult] = useState<models.MigrationResult | null>(null);
    const [error, setError] = useState('');
    const [asking, setAsking] = useState(false);

    const load = useCallback(() => {
        MigrationGetResult(id).then((r) => { setResult(r); setError(''); }).catch((e) => setError(errText(e)));
    }, [id]);

    useEffect(() => {
        if (!active) return;
        load();
        const timer = window.setInterval(load, POLL_MS);
        return () => window.clearInterval(timer);
    }, [active, load]);

    if (!result) return <div className="mig-body">{error ? <p className="dlg-error mig-error">{error}</p> : <ListSkeleton />}</div>;

    const workloads = result.workloads ?? [];
    const disks = result.disks ?? [];
    const addresses = result.addresses ?? [];
    const skipped = result.skipped ?? [];
    const notReady = notReadyCount(workloads);

    return (
        <div className="mig-body">
            <div className="mig-route">
                <strong>{t('panels:migration.result.title')}</strong>
                <ClusterName name={result.source} />
                <span aria-hidden>→</span>
                <ClusterName name={result.target} />
                <StatusLamp tone={phaseTone(result.phase)} label={t(`panels:migration.phase.${result.phase}` as never)} />
                <RowAction icon={<VscRefresh size={14} />} label={t('panels:migration.result.refresh')} onClick={load} />
            </div>
            <p className="tool-panel__intro">{t('panels:migration.result.summary', {
                namespaces: result.namespaces?.length ?? 0, objects: result.objectCount, bytes: formatSize(result.bytesCopied), downtime: formatDuration(result.downtimeSeconds),
            })}</p>
            {result.error && <p className="dlg-error mig-error">{result.error}</p>}
            {result.liveError && <p className="mig-section__note mig-error">{t('panels:migration.result.liveError')}</p>}
            {notReady > 0 && <div className="mig-warning"><StatusLamp tone="warn" label={t('panels:migration.result.notReady', { count: notReady })} /></div>}

            {workloads.length > 0 && (
                <section className="mig-section">
                    <table className="mig-table">
                        <thead>
                            <tr>
                                <th>{t('panels:migration.result.workload')}</th>
                                <th>{t('panels:migration.result.ready')}</th>
                                <th>{t('panels:migration.result.state')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {workloads.map((w) => (
                                <tr key={`${w.kind}/${w.namespace}/${w.name}`}>
                                    <td className="cell-mono">{w.namespace}/{w.name}</td>
                                    <td className="cell-mono">{w.ready}/{w.desired}</td>
                                    <td>
                                        {w.ready >= w.desired
                                            ? <StatusLamp tone="ok" label={t('panels:migration.result.running')} />
                                            : <StatusLamp tone="warn" label={w.reason || t('panels:migration.result.starting')} />}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}

            {disks.length > 0 && (
                <section className="mig-section">
                    <table className="mig-table">
                        <thead>
                            <tr>
                                <th>{t('panels:migration.preflight.colDisk')}</th>
                                <th>{t('panels:migration.preflight.colSize')}</th>
                                <th>{t('panels:migration.result.class')}</th>
                                <th>{t('panels:migration.result.copy')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {disks.map((d) => (
                                <tr key={`${d.namespace}/${d.name}`}>
                                    <td className="cell-mono">{d.namespace}/{d.name}</td>
                                    <td className="cell-mono">{d.size}</td>
                                    <td className="cell-mono">{d.sourceClass === d.targetClass ? d.targetClass : `${d.sourceClass} → ${d.targetClass}`}</td>
                                    <td>
                                        {d.copied
                                            ? <StatusLamp tone={d.status === 'Bound' ? 'ok' : 'warn'} label={`${formatSize(d.bytesCopied)} · ${d.status}`} />
                                            : <span className="cell-empty">{t('panels:migration.preflight.copyNo')}</span>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}

            <section className="mig-section">
                <h3 className="mig-section__title">{t('panels:migration.result.addresses')}</h3>
                {addresses.length === 0
                    ? <p className="mig-section__note">{t('panels:migration.result.noAddresses')}</p>
                    : (
                        <table className="mig-table">
                            <tbody>
                                {addresses.map((a, n) => (
                                    <tr key={n}>
                                        <td className="cell-mono">{a.namespace}/{a.name}</td>
                                        <td className="cell-mono">{a.host || <span className="cell-empty">—</span>}</td>
                                        <td className="cell-mono">{a.address || <span className="cell-empty">{t('panels:migration.result.addressPending')}</span>}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
            </section>

            {skipped.length > 0 && (
                <details className="mig-section">
                    <summary className="mig-section__title">{t('panels:migration.result.skipped', { count: skipped.length })}</summary>
                    <table className="mig-table">
                        <tbody>
                            {skipped.map((s, n) => (
                                <tr key={n}>
                                    <td>{s.kind}</td>
                                    <td className="cell-mono">{s.namespace}/{s.name}</td>
                                    <td>{t(`panels:migration.skip.${s.reason}` as never)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </details>
            )}

            {workloads.length > 0 && (
                <section className="mig-section">
                    <h3 className="mig-section__title">{t('panels:migration.result.source')}</h3>
                    <p className="mig-route">
                        <ClusterName name={result.source} />
                        <StatusLamp tone={result.sourceStopped ? 'idle' : 'ok'} label={result.sourceStopped ? t('panels:migration.result.stopped') : t('panels:migration.result.sourceRunning')} />
                    </p>
                    {result.sourceStopped && (
                        <Button data-testid="migration-restart" label={t('panels:migration.result.restart')} severity="secondary" onClick={() => setAsking(true)} />
                    )}
                </section>
            )}

            <div className="dlg-actions mig-actions">
                <Button label={t('panels:migration.result.new')} severity="secondary" onClick={onNew} />
            </div>

            <ConfirmActionDialog visible={asking} header={t('panels:migration.result.restartHeader')} severity="warning"
                message={t('panels:migration.result.restartBody', { source: result.source, target: result.target })}
                confirmLabel={t('panels:migration.result.restartButton')}
                onHide={() => setAsking(false)}
                onConfirm={async () => { await MigrationRestartSource(id); load(); }} />
        </div>
    );
}
