import { lazy, Suspense } from 'react';
import { Button } from 'primereact/button';
import { VscCheck } from 'react-icons/vsc';
import { useClusterColor } from '../../stores/clusterColorStore';
import { useT } from '../../i18n/useT';
import Spinner from '../shared/Spinner';

// Monaco is only loaded once something actually needs approving.
const YamlDiff = lazy(() => import('../toolbox/history/YamlDiff'));

export interface PreviewItem {
    verb: 'create' | 'update' | 'delete';
    kind: string;
    namespace: string;
    name: string;
    before: string;
    after: string;
}

export interface ConfirmReq {
    id: string;
    name: string;
    args: Record<string, unknown>;
    cluster: string;
    /** The API server's dry run of the action; absent for a tool without one. */
    preview?: { items: PreviewItem[] } | null;
}

/**
 * The approval for a mutating tool call. It names the cluster the change lands
 * on (with that cluster's colour) and shows, per object, the dry-run result
 * against the live object — the same diff a rollback shows — so the user
 * approves an outcome rather than a JSON blob of arguments.
 */
export default function ConfirmCard({ req, onAnswer }: { req: ConfirmReq; onAnswer: (approved: boolean) => void }) {
    const t = useT();
    const color = useClusterColor(req.cluster);
    const items = req.preview?.items ?? [];
    return (
        <div className="ai-confirm" role="alertdialog" aria-label={t('panels:ai.approveAction')}>
            <div className="ai-confirm__title">
                <span>{t('panels:ai.approveAction')} <b>{req.name}</b></span>
                <span className="ai-confirm__cluster" style={color ? { ['--dot' as string]: color } : undefined}>
                    <span className="ai-confirm__dot" aria-hidden />
                    {t('panels:ai.confirmOn', { cluster: req.cluster })}
                </span>
            </div>

            {items.length > 0 ? (
                <>
                    <div className="ai-confirm__note">{t('panels:ai.dryRunPassed')}</div>
                    {items.map((it) => (
                        <div className="ai-confirm__item" key={`${it.kind}/${it.namespace}/${it.name}`}>
                            <div className="ai-confirm__obj">
                                <span className={`ai-confirm__verb ai-confirm__verb--${it.verb}`}>{t(`panels:ai.verb.${it.verb}`)}</span>
                                <span className="ai-confirm__ref">{it.kind} {it.namespace ? `${it.namespace}/` : ''}{it.name}</span>
                            </div>
                            <div className="ai-confirm__diff dark-display">
                                <Suspense fallback={<Spinner />}>
                                    <YamlDiff original={it.before} modified={it.after} sideBySide={false} />
                                </Suspense>
                            </div>
                        </div>
                    ))}
                </>
            ) : (
                <pre className="ai-confirm__args">{JSON.stringify(req.args, null, 2)}</pre>
            )}

            {/* Approving runs a change against the cluster (delete, apply,
                scale), so it carries the danger role, like every other
                destructive confirm in the app. */}
            <div className="ai-confirm__btns">
                <Button label={t('panels:ai.deny')} severity="secondary" size="small" onClick={() => onAnswer(false)} autoFocus />
                <Button label={t('panels:ai.approve')} icon={<VscCheck size={14} />} severity="danger" size="small" onClick={() => onAnswer(true)} />
            </div>
        </div>
    );
}
