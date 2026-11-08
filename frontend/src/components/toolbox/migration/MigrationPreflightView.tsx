import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { Dropdown } from 'primereact/dropdown';
import { MigrationPreflight, MigrationStart } from '../../../../wailsjs/go/controller_app/App';
import { models } from '../../../../wailsjs/go/models';
import { useT } from '../../../i18n/useT';
import { errText } from '../../../lib/errText';
import { ListSkeleton } from '../../shared/PanelSkeleton';
import Segmented from '../../shared/Segmented';
import StatusLamp from '../../shared/StatusLamp';
import ClusterName from './ClusterName';
import { classesOf, hasBlocker, initialDecisions, sortIssues, type Decision } from './migrationModel';

const YamlDiff = lazy(() => import('../history/YamlDiff'));

const KEEP_TARGET: Decision = 'skip';
const OVERWRITE: Decision = 'overwrite';

/**
 * What the migration would do and what stands in its way. Changing a storage
 * class checks again, because a missing class is itself a blocker.
 */
export default function MigrationPreflightView({ request, onBack, onStarted }: {
    request: models.MigrationRequest;
    onBack: () => void;
    onStarted: (id: string) => void;
}) {
    const t = useT();
    const [report, setReport] = useState<models.MigrationPreflight | null>(null);
    const [classes, setClasses] = useState<Record<string, string>>(request.storageClasses ?? {});
    const [decisions, setDecisions] = useState<Record<string, Decision>>({});
    const [error, setError] = useState('');
    const [checking, setChecking] = useState(true);
    const [starting, setStarting] = useState(false);
    const [diff, setDiff] = useState<models.MigrationConflict | null>(null);
    const latest = useRef(0);

    const run = useCallback(async (chosen: Record<string, string>) => {
        const call = ++latest.current;
        setChecking(true);
        setError('');
        try {
            const next = await MigrationPreflight(models.MigrationRequest.createFrom({ ...request, storageClasses: chosen, decisions: {} }));
            if (call !== latest.current) return;
            setReport(next);
            setClasses(classesOf(next.disks ?? []));
            setDecisions((prev) => ({ ...initialDecisions(next.conflicts ?? []), ...prev }));
        } catch (e) {
            if (call === latest.current) setError(errText(e));
        } finally {
            if (call === latest.current) setChecking(false);
        }
    }, [request]);

    useEffect(() => { void run(request.storageClasses ?? {}); }, [run, request]);

    const start = async () => {
        setStarting(true);
        setError('');
        try {
            onStarted(await MigrationStart(models.MigrationRequest.createFrom({ ...request, storageClasses: classes, decisions })));
        } catch (e) {
            setError(errText(e));
            setStarting(false);
        }
    };

    const changeClass = (source: string, target: string) => {
        const next = { ...classes, [source]: target };
        setClasses(next);
        void run(next);
    };

    const issues = sortIssues(report?.issues ?? []);
    const disks = report?.disks ?? [];
    const conflicts = report?.conflicts ?? [];
    const missing = report?.missing ?? [];
    const skipped = report?.skipped ?? [];
    const blocked = !report || hasBlocker(issues);

    return (
        <div className="mig-body">
            <p className="mig-route">
                <ClusterName name={request.source} />
                <span aria-hidden>→</span>
                <ClusterName name={request.target} />
            </p>
            {!report && checking && <ListSkeleton />}
            {error && <p className="dlg-error mig-error">{error}</p>}

            {report && (
                <>
                    <p className="tool-panel__intro">{t('panels:migration.preflight.summary', { objects: report.objects?.length ?? 0, disks: disks.length })}</p>

                    <section className="mig-section">
                        <h3 className="mig-section__title">{t('panels:migration.preflight.problems')}</h3>
                        {issues.length === 0 && <StatusLamp label={t('panels:migration.preflight.noProblems')} tone="ok" />}
                        <ul className="mig-issues">
                            {issues.map((i, n) => (
                                <li key={n} title={i.code === 'listForbidden' || i.code === 'discoveryPartial' ? i.detail : undefined}>
                                    <StatusLamp tone={i.blocker ? 'err' : 'warn'} label={t(`panels:migration.issue.${i.code}` as never, { namespace: i.namespace, name: i.name, detail: i.detail })} />
                                </li>
                            ))}
                        </ul>
                    </section>

                    {disks.length > 0 && (
                        <section className="mig-section">
                            <h3 className="mig-section__title">{t('panels:migration.preflight.disks')}</h3>
                            <table className="mig-table">
                                <thead>
                                    <tr>
                                        <th>{t('panels:migration.preflight.colDisk')}</th>
                                        <th>{t('panels:migration.preflight.colSize')}</th>
                                        <th>{t('panels:migration.preflight.colSourceClass')}</th>
                                        <th>{t('panels:migration.preflight.colTargetClass')}</th>
                                        <th>{t('panels:migration.preflight.colData')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {disks.map((d) => (
                                        <tr key={`${d.namespace}/${d.name}`}>
                                            <td className="cell-mono">{d.namespace}/{d.name}</td>
                                            <td className="cell-mono">{d.size}</td>
                                            <td className="cell-mono">{d.sourceClass || <span className="cell-empty">—</span>}</td>
                                            <td>
                                                <Dropdown value={d.targetClass} options={report.targetClasses ?? []} disabled={!d.copy}
                                                    aria-label={t('panels:migration.preflight.colTargetClass')}
                                                    onChange={(e) => changeClass(d.sourceClass, e.value)} />
                                            </td>
                                            <td>{!d.copy ? t('panels:migration.preflight.copyNo') : d.liveCopy ? t('panels:migration.preflight.copyYes') : t('panels:migration.preflight.copyFinalOnly')}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </section>
                    )}

                    {conflicts.length > 0 && (
                        <section className="mig-section">
                            <h3 className="mig-section__title">{t('panels:migration.preflight.conflicts')}</h3>
                            <p className="mig-section__note">{t('panels:migration.preflight.conflictsIntro')}</p>
                            <table className="mig-table">
                                <tbody>
                                    {conflicts.map((c) => (
                                        <tr key={c.key}>
                                            <td>{c.kind}</td>
                                            <td className="cell-mono">{c.namespace}/{c.name}</td>
                                            <td>
                                                {c.isPvc ? t('panels:migration.preflight.diskKept') : (
                                                    <Segmented<Decision>
                                                        ariaLabel={`${c.kind} ${c.namespace}/${c.name}`}
                                                        value={decisions[c.key] ?? KEEP_TARGET}
                                                        options={[
                                                            { value: KEEP_TARGET, label: t('panels:migration.preflight.skip') },
                                                            { value: OVERWRITE, label: t('panels:migration.preflight.overwrite') },
                                                        ]}
                                                        onChange={(v) => setDecisions((prev) => ({ ...prev, [c.key]: v }))} />
                                                )}
                                            </td>
                                            <td className="mig-table__end">
                                                <Button label={t('panels:migration.preflight.diff')} text size="small" onClick={() => setDiff(c)} />
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </section>
                    )}

                    {missing.length > 0 && (
                        <section className="mig-section">
                            <h3 className="mig-section__title">{t('panels:migration.preflight.missing')}</h3>
                            <p className="mig-section__note">{t('panels:migration.preflight.missingIntro')}</p>
                            <table className="mig-table">
                                <tbody>
                                    {missing.map((m) => (
                                        <tr key={`${m.kind}/${m.name}`}>
                                            <td>{m.kind}</td>
                                            <td className="cell-mono">{m.name}</td>
                                            <td>{t('panels:migration.preflight.usedBy', { name: m.usedBy })}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </section>
                    )}

                    {skipped.length > 0 && (
                        <details className="mig-section">
                            <summary className="mig-section__title">{t('panels:migration.preflight.skipped', { count: skipped.length })}</summary>
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
                </>
            )}

            <div className="dlg-actions mig-actions">
                <Button label={t('panels:migration.preflight.back')} severity="secondary" onClick={onBack} />
                <Button label={t('panels:migration.preflight.retry')} severity="secondary" loading={checking} onClick={() => void run(classes)} />
                <Button data-testid="migration-start" label={t('panels:migration.preflight.start')} disabled={blocked || checking || starting} loading={starting} onClick={() => void start()} />
            </div>

            <Dialog visible={diff !== null} onHide={() => setDiff(null)} header={diff ? `${diff.kind} ${diff.namespace}/${diff.name}` : ''} className="mig-diff-dialog" modal>
                {diff && (
                    <div className="mig-diff">
                        <Suspense fallback={<ListSkeleton />}>
                            <YamlDiff original={diff.targetYaml} modified={diff.sourceYaml} sideBySide />
                        </Suspense>
                    </div>
                )}
            </Dialog>
        </div>
    );
}
