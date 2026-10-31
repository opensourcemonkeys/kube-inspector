import type { ReactNode } from 'react';
import { models } from '../../../../wailsjs/go/models';
import { useT } from '../../../i18n/useT';
import { absTime } from '../../../lib/time';
import ErrorBanner from '../../shared/ErrorBanner';
import { SeverityTag } from './severity';
import { WorkloadCell } from './workloadNav';
import { countDelta, sumSeverities, verdictParams } from './trivyModel';

const MAX_CHANGES = 6;

/** "▲ 3" / "▼ 2" against the compared scan: an increase is bad news. */
function Delta({ delta, since }: { delta: number | null; since: string }) {
    const t = useT();
    if (delta == null) return <div className="trivy-tile__delta">{t('panels:trivy.summary.noCompare')}</div>;
    if (delta === 0) return <div className="trivy-tile__delta">{t('panels:trivy.summary.deltaSame', { date: since })}</div>;
    return delta > 0
        ? <div className="trivy-tile__delta trivy-tile__delta--up">{t('panels:trivy.summary.deltaUp', { n: delta, date: since })}</div>
        : <div className="trivy-tile__delta trivy-tile__delta--down">{t('panels:trivy.summary.deltaDown', { n: -delta, date: since })}</div>;
}

function Tile({ label, value, children }: { label: string; value: string | number; children?: ReactNode }) {
    return (
        <div className="trivy-tile">
            <div className="trivy-tile__label">{label}</div>
            <div className="trivy-tile__value">{value}</div>
            {children}
        </div>
    );
}

/** The reasons a workload ranks where it does, one chip each. */
function Reasons({ w, exposureKnown }: { w: models.TrivyWorkloadRisk; exposureKnown: boolean }) {
    const t = useT();
    const exposure = w.exposure ?? [];
    const privileges = w.privileges ?? [];
    return (
        <span className="trivy-chips">
            {!exposureKnown && <span className="trivy-chip trivy-chip--muted">{t('panels:trivy.summary.exposureUnknown')}</span>}
            {exposure.map((e) => <span key={e} className="trivy-chip trivy-chip--exposed">{e}</span>)}
            {privileges.map((p) => (
                <span key={p} className="trivy-chip">{t(`panels:trivy.privilege.${p}` as never, { defaultValue: p })}</span>
            ))}
        </span>
    );
}

export default function SummaryView({ clusterName, view, onShowNew }: {
    clusterName: string;
    view: models.TrivyScanView;
    onShowNew: () => void;
}) {
    const t = useT();
    const s = view.summary;
    const compared = s.prevVulns != null || s.prevMisconfigs != null || s.prevSecrets != null;
    const since = absTime(view.compareStartedAt);
    const total = (sev: string, prev: boolean) => prev
        ? sumSeverities(sev, s.prevVulns, s.prevMisconfigs, s.prevSecrets)
        : sumSeverities(sev, s.vulns, s.misconfigs, s.secrets);
    const crit = total('CRITICAL', false);
    const high = total('HIGH', false);
    const failed = s.imagesTotal - s.imagesScanned;

    const { topItems, closes } = verdictParams(view.fixPlan);
    const exposedCritical = view.exposureKnown
        ? String(s.exposedCritical ?? 0)
        : t('panels:trivy.summary.unknown');
    const verdict = topItems > 0
        ? t('panels:trivy.summary.verdict', { exposedCritical, topItems, closes })
        : t('panels:trivy.summary.verdictNoPlan', { exposedCritical });

    const top = view.topWorkloads ?? [];
    const changes = view.changes;
    const newChanges = changes?.new ?? [];

    return (
        <div className="trivy-summary-view">
            <ErrorBanner message={view.misconfigError || null} context={t('panels:trivy.summary.misconfigContext')} />

            <div className="trivy-tiles">
                <Tile label={t('panels:trivy.summary.critical')} value={crit}>
                    <Delta delta={compared ? countDelta(crit, total('CRITICAL', true)) : null} since={since} />
                </Tile>
                <Tile label={t('panels:trivy.summary.high')} value={high}>
                    <Delta delta={compared ? countDelta(high, total('HIGH', true)) : null} since={since} />
                </Tile>
                <Tile label={t('panels:trivy.summary.fixable')} value={s.fixableRatio < 0 ? '—' : `${Math.round(s.fixableRatio * 100)}%`}>
                    <div className="trivy-tile__delta">
                        {s.fixableRatio < 0 ? t('panels:trivy.summary.fixableNone') : t('panels:trivy.summary.fixableHint')}
                    </div>
                </Tile>
                <Tile label={t('panels:trivy.summary.coverage')} value={`${s.imagesScanned}/${s.imagesTotal}`}>
                    <div className={`trivy-tile__delta${failed > 0 ? ' trivy-tile__delta--up' : ''}`}>
                        {failed > 0 ? t('panels:trivy.summary.coverageFailed', { count: failed }) : t('panels:trivy.summary.coverageHint')}
                    </div>
                </Tile>
            </div>

            <p className="trivy-verdict">{verdict}</p>

            <section className="trivy-card">
                <h3 className="trivy-card__title">{t('panels:trivy.summary.topWorkloads')}</h3>
                {top.length === 0 ? (
                    <p className="trivy-muted">{t('panels:trivy.summary.noTopWorkloads')}</p>
                ) : (
                    <table className="trivy-table">
                        <thead>
                            <tr>
                                <th>{t('panels:trivy.col.workload')}</th>
                                <th>{t('panels:trivy.col.reasons')}</th>
                                <th className="trivy-table__n">{t('panels:trivy.summary.critical')}</th>
                                <th className="trivy-table__n">{t('panels:trivy.summary.high')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {top.map((w) => (
                                <tr key={`${w.workload.namespace}/${w.workload.kind}/${w.workload.name}`}>
                                    <td><WorkloadCell clusterName={clusterName} w={w.workload} /></td>
                                    <td><Reasons w={w} exposureKnown={view.exposureKnown} /></td>
                                    <td className="trivy-table__n">{w.counts?.CRITICAL ?? 0}</td>
                                    <td className="trivy-table__n">{w.counts?.HIGH ?? 0}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>

            <section className="trivy-card">
                <h3 className="trivy-card__title">{t('panels:trivy.summary.changes')}</h3>
                {!changes ? (
                    <p className="trivy-muted">{t('panels:trivy.summary.noComparison')}</p>
                ) : (
                    <>
                        <p className="trivy-changes__counts">
                            {t('panels:trivy.summary.changesCounts', {
                                new: newChanges.length, closed: (changes.closed ?? []).length, workloads: (changes.newWorkloads ?? []).length,
                            })}
                            {newChanges.length > 0 && (
                                <button type="button" className="trivy-linkbtn" onClick={onShowNew}>{t('panels:trivy.summary.showNew')}</button>
                            )}
                        </p>
                        {newChanges.length === 0 ? (
                            <p className="trivy-muted">{t('panels:trivy.summary.noChanges')}</p>
                        ) : (
                            <ul className="trivy-changes">
                                {newChanges.slice(0, MAX_CHANGES).map((c) => (
                                    <li key={`${c.kind}|${c.key}`}>
                                        <SeverityTag sev={c.severity} markOnly />
                                        <span className="trivy-changes__id">{c.id}</span>
                                        <span className="trivy-changes__where">{c.workload.kind} {c.workload.namespace ? `${c.workload.namespace}/` : ''}{c.workload.name}</span>
                                    </li>
                                ))}
                                {newChanges.length > MAX_CHANGES && (
                                    <li className="trivy-muted">{t('panels:trivy.fix.more', { count: newChanges.length - MAX_CHANGES })}</li>
                                )}
                            </ul>
                        )}
                    </>
                )}
            </section>
        </div>
    );
}
