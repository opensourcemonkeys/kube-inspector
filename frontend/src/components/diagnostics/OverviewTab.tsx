import { useCallback, useEffect, useState } from 'react';
import { Button } from 'primereact/button';
import { models } from '../../../wailsjs/go/models';
import { GetDiagnostics, RunHealthChecks } from '../../../wailsjs/go/controller_app/App';
import { useAiChatStore } from '../../stores/aiChatStore';
import HealthCheckList from './HealthCheckList';
import { useT } from '../../i18n/useT';
import { VscRefresh } from 'react-icons/vsc';

function Row({ label, value }: { label: string; value: string | number | undefined }) {
    if (value === undefined || value === '' || value === null) return null;
    return (
        <div className="diag-row">
            <span className="diag-row__label">{label}</span>
            <span className="diag-row__value">{value}</span>
        </div>
    );
}

/**
 * Environment facts plus the on-demand preflight.
 *
 * The checks do not auto-refresh: they reach every configured cluster and the
 * update manifest, so running them on a timer would turn a diagnostics tab into
 * a background load generator.
 */
export default function OverviewTab({
    report,
    onReport,
}: {
    report: models.DiagnosticsReport | null;
    onReport: (r: models.DiagnosticsReport) => void;
}) {
    const t = useT();
    const [checks, setChecks] = useState<models.HealthCheck[]>([]);
    const [running, setRunning] = useState(false);
    const ollamaHost = useAiChatStore((s) => s.host);

    const refresh = useCallback(() => {
        GetDiagnostics().then(onReport).catch(() => { /* panel still renders */ });
    }, [onReport]);

    const runChecks = useCallback(() => {
        setRunning(true);
        RunHealthChecks(ollamaHost)
            .then(setChecks)
            .catch(() => setChecks([]))
            .finally(() => setRunning(false));
    }, [ollamaHost]);

    useEffect(() => {
        refresh();
        runChecks();
        // Deliberately once per mount: see the note above about load.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className="diag-tab">
            <section className="diag-section">
                <h3 className="diag-section__title">{t('panels:diagnostics.environment')}</h3>
                <Row label={t('panels:diagnostics.version')} value={report?.appVersion} />
                <Row label={t('panels:diagnostics.commit')} value={report?.commit} />
                <Row label={t('panels:diagnostics.built')} value={report?.buildDate} />
                <Row label="Go" value={report?.goVersion} />
                <Row
                    label={t('panels:diagnostics.platform')}
                    value={report ? `${report.goos}/${report.goarch}` : undefined}
                />
                <Row label="OS" value={report?.osRelease} />
                <Row label={t('panels:diagnostics.shell')} value={report?.shell} />
                <Row label={t('panels:diagnostics.instanceHub')} value={report?.hub?.role} />
                <Row label={t('panels:diagnostics.thisInstance')} value={report?.hub?.instanceName} />
                <Row label={t('panels:diagnostics.instances')} value={report?.hub?.instanceCount} />
            </section>

            <section className="diag-section">
                <h3 className="diag-section__title">{t('panels:diagnostics.configuration')}</h3>
                <Row label={t('panels:diagnostics.clusters')} value={`${report?.clusterCount ?? 0} (names redacted)`} />
                <Row label={t('panels:diagnostics.activeCluster')} value={report?.activeCluster || '—'} />
                <Row label={t('panels:diagnostics.logDirectory')} value={report?.logDir} />
                <Row label={t('panels:diagnostics.logLevel')} value={report?.logLevel} />
            </section>

            <section className="diag-section">
                <div className="diag-section__head">
                    <h3 className="diag-section__title">{t('panels:diagnostics.healthChecks')}</h3>
                    <Button
                        label={t(running ? 'panels:diagnostics.rerunning' : 'panels:diagnostics.rerun')}
                        icon={<VscRefresh />}
                        size="small"
                        outlined
                        disabled={running}
                        onClick={() => {
                            refresh();
                            runChecks();
                        }}
                    />
                </div>
                <HealthCheckList checks={checks} running={running} />
            </section>
        </div>
    );
}
