import { VscPass, VscHubot } from 'react-icons/vsc';
import { Button } from 'primereact/button';
import { models } from '../../../../wailsjs/go/models';
import { useT } from '../../../i18n/useT';
import { useSplitPane } from '../../../lib/useSplitPane';
import { useTrivyState, useTrivyStore } from '../../../stores/trivyStore';
import { useAiChatStore } from '../../../stores/aiChatStore';
import { fixItemPrompt } from './fixPrompt';
import StatusLamp from '../../shared/StatusLamp';
import { SEVERITIES, SeverityTag } from './severity';
import { WorkloadCell, workloadLabel } from './workloadNav';
import { fixItemExceptions } from './trivyModel';
import type { AcceptRequest } from './AcceptRiskDialog';

const MAX_IDS = 40;

/** The action an item stands for, as one line. */
export function useFixTitle() {
    const t = useT();
    return (it: models.TrivyFixItem): string => {
        switch (it.kind) {
            case 'package':
                return t('panels:trivy.fix.upgrade', { pkg: it.package, from: it.installedVersion || '?', to: it.fixedVersion || '?' });
            case 'baseOS':
                return t('panels:trivy.fix.rebuild', { image: it.image, os: [it.os?.family, it.os?.name].filter(Boolean).join(' ') });
            default:
                return `${it.checkId} ${it.title}`;
        }
    };
}

/** "CRITICAL 2 · HIGH 5" — only the severities the item closes. */
function Closes({ closes }: { closes: Record<string, number> | null }) {
    return (
        <span className="trivy-closes">
            {SEVERITIES.filter((s) => (closes?.[s] ?? 0) > 0).map((s) => (
                <span key={s} className="trivy-closes__item"><SeverityTag sev={s} markOnly /><span className="cell-count">{closes?.[s]}</span></span>
            ))}
        </span>
    );
}

function Detail({ clusterName, item, vulns, onAccept }: {
    clusterName: string;
    item: models.TrivyFixItem;
    vulns: models.TrivyVulnRow[];
    onAccept: (req: AcceptRequest) => void;
}) {
    const t = useT();
    const title = useFixTitle();
    const ids = item.vulnIds ?? [];
    const workloads = item.workloads ?? [];
    const images = item.images ?? [];
    const aiSuggestions = useTrivyStore((s) => s.aiSuggestions);
    const ask = useAiChatStore((s) => s.ask);

    const accept = () => {
        if (item.kind === 'misconfig') {
            onAccept({
                subject: workloads.map((w) => `${item.checkId} · ${w.kind} ${workloadLabel(w)}`),
                build: (reason, expiresAt) => fixItemExceptions(item, vulns, reason, expiresAt),
            });
            return;
        }
        const pairs = fixItemExceptions(item, vulns, '-', '-');
        onAccept({
            subject: pairs.map((e) => `${e.vulnerabilityId} · ${e.imageRepo}`),
            build: (reason, expiresAt) => fixItemExceptions(item, vulns, reason, expiresAt),
        });
    };

    return (
        <div className="trivy-fix-detail">
            <div className="trivy-fix-detail__head">
                <SeverityTag sev={item.severity} />
                <h3 className="trivy-fix-detail__title">{title(item)}</h3>
            </div>
            {item.kind === 'baseOS' && item.os?.eosl && (
                <StatusLamp tone="err" label={t('panels:trivy.fix.eosl')} />
            )}

            <dl className="dlg-facts">
                <div className="dlg-facts__row">
                    <dt>{t('panels:trivy.fix.closes')}</dt>
                    <dd><Closes closes={item.closes} /></dd>
                </div>
                {item.kind === 'package' && (item.fixedVersions ?? []).length > 0 && (
                    <div className="dlg-facts__row">
                        <dt>{t('panels:trivy.fix.fixedVersions')}</dt>
                        <dd className="dlg-facts__mono">{(item.fixedVersions ?? []).join(', ')}</dd>
                    </div>
                )}
                {item.kind === 'misconfig' && item.resolution && (
                    <div className="dlg-facts__row">
                        <dt>{t('panels:trivy.fix.resolution')}</dt>
                        <dd>{item.resolution}</dd>
                    </div>
                )}
                {ids.length > 0 && (
                    <div className="dlg-facts__row">
                        <dt>{t('panels:trivy.fix.vulnIds')}</dt>
                        <dd className="dlg-facts__mono">
                            {ids.slice(0, MAX_IDS).join(', ')}
                            {ids.length > MAX_IDS && <> {t('panels:trivy.fix.more', { count: ids.length - MAX_IDS })}</>}
                        </dd>
                    </div>
                )}
                {item.kind !== 'misconfig' && images.length > 0 && (
                    <div className="dlg-facts__row">
                        <dt>{t('panels:trivy.fix.images')}</dt>
                        <dd className="dlg-facts__mono">{images.join(', ')}</dd>
                    </div>
                )}
            </dl>

            <h4 className="trivy-fix-detail__sub">
                {t('panels:trivy.fix.affected')}
                {item.exposedWorkloads > 0 && <span className="trivy-muted"> · {t('panels:trivy.fix.exposed', { count: item.exposedWorkloads })}</span>}
            </h4>
            {workloads.length === 0 ? (
                <p className="trivy-muted">{t('panels:trivy.fix.noWorkloads')}</p>
            ) : (
                <ul className="trivy-fix-detail__workloads">
                    {workloads.map((w) => (
                        <li key={`${w.namespace}/${w.kind}/${w.name}`}><WorkloadCell clusterName={clusterName} w={w} /></li>
                    ))}
                </ul>
            )}

            <div className="trivy-fix-detail__actions">
                <Button label={t('panels:trivy.fix.accept')} icon={<VscPass className="mr-2" />} severity="secondary" outlined size="small" onClick={accept} />
                {aiSuggestions && (
                    <Button label={t('panels:trivy.ai.ask')} icon={<VscHubot className="mr-2" />} severity="secondary" size="small"
                        onClick={() => ask(fixItemPrompt(item, clusterName, t))} />
                )}
            </div>
        </div>
    );
}

/** The fix plan: what to do, in order of what it closes, with the item's detail beside it. */
export default function FixPlanView({ clusterName, view, onAccept }: {
    clusterName: string;
    view: models.TrivyScanView;
    onAccept: (req: AcceptRequest) => void;
}) {
    const t = useT();
    const title = useFixTitle();
    const { splitRef, width, startResize } = useSplitPane('trivy-fix-split', 420, 280);
    const selectedFix = useTrivyState(clusterName).selectedFix;
    const patch = useTrivyStore((s) => s.patch);
    const plan = view.fixPlan ?? [];
    const selected = plan.find((it) => it.id === selectedFix) ?? plan[0] ?? null;

    return (
        <div className="pod-split trivy-fix-split" ref={splitRef}>
            <div className="pod-split__list trivy-fix-list">
                {plan.length === 0 ? (
                    <p className="trivy-muted trivy-fix-list__empty">{t('panels:trivy.fix.empty')}</p>
                ) : (
                    <ul className="trivy-fix-items" aria-label={t('panels:trivy.fix.listAria')}>
                        {plan.map((it) => {
                            const on = selected?.id === it.id;
                            const n = (it.workloads ?? []).length;
                            return (
                                <li key={it.id}>
                                    <button type="button" className={`trivy-fix-item${on ? ' is-on' : ''}`} aria-current={on || undefined}
                                        onClick={() => patch(clusterName, { selectedFix: it.id })}>
                                        <span className="trivy-fix-item__head">
                                            <SeverityTag sev={it.severity} markOnly />
                                            <span className="trivy-fix-item__title">{title(it)}</span>
                                        </span>
                                        <span className="trivy-fix-item__meta">
                                            <Closes closes={it.closes} />
                                            <span>{t('panels:trivy.fix.workloads', { count: n })}</span>
                                            {it.exposedWorkloads > 0 && <span>{t('panels:trivy.fix.exposed', { count: it.exposedWorkloads })}</span>}
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
                {view.unfixableCount > 0 && (
                    <p className="trivy-fix-list__unfixable">{t('panels:trivy.fix.unfixable', { count: view.unfixableCount })}</p>
                )}
            </div>
            {selected && (
                <>
                    <div className="pod-split__handle" role="separator" aria-orientation="vertical" onPointerDown={startResize} />
                    <div className="pod-split__detail" style={{ width }}>
                        <Detail key={selected.id} clusterName={clusterName} item={selected} vulns={view.vulns ?? []} onAccept={onAccept} />
                    </div>
                </>
            )}
        </div>
    );
}
