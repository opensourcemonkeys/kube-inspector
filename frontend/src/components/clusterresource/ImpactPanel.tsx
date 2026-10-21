import { useMemo, useState } from 'react';
import type React from 'react';
import { VscCopy, VscClose, VscCheck } from 'react-icons/vsc';
import { useT } from '../../i18n/useT';
import RowAction from '../shared/RowAction';
import StatusLamp, { type LampTone } from '../shared/StatusLamp';
import { rankOf, type ResourceNode } from './graphLayout';
import { groupImpacts, IMPACT_LEVELS, type Impact, type ImpactLevel, type ImpactMode, type ImpactReason, type ImpactResult } from './impact';

type TFn = ReturnType<typeof useT>;

/** removed/breaks are errors, a restart-time failure a warning, capacity info. */
export const IMPACT_TONE: Record<ImpactLevel, LampTone> = {
    removed: 'err',
    breaks: 'err',
    breaksOnRestart: 'warn',
    degraded: 'info',
};

// Reason and note params carry {kind, name}; the kind is shown the way the
// graph labels it (PVC, PV).
export function reasonText(t: TFn, r: ImpactReason, kindLabel: (k: string) => string, group: 'reason' | 'note'): string {
    const params: Record<string, unknown> = { ...r.params };
    if (typeof params.kind === 'string') params.kind = kindLabel(params.kind);
    return t(`panels:resourceGraph.impact.${group}.${r.code}` as never, params);
}

export function impactLabel(t: TFn, impact: Pick<Impact, 'level' | 'recreated' | 'dataLoss'>): string {
    const parts: string[] = [t(`panels:resourceGraph.impact.level.${impact.level}` as never)];
    if (impact.recreated) parts.push(t('panels:resourceGraph.impact.recreated'));
    if (impact.dataLoss) parts.push(t('panels:resourceGraph.impact.dataLoss'));
    return parts.join(' · ');
}

const objectName = (n: ResourceNode) => (n.namespace ? `${n.namespace}/${n.name}` : n.name);

interface Props {
    mode: ImpactMode;
    target: ResourceNode;
    result: ImpactResult;
    byId: Map<string, ResourceNode>;
    /** Not drawn in the graph right now (a hidden kind, an old ReplicaSet). */
    isHidden: (id: string) => boolean;
    kindLabel: (kind: string) => string;
    kindIcon: (kind: string) => React.ReactNode;
    /** Pan to an object without changing what the analysis is about. */
    onPeek: (id: string) => void;
    onOpen: (node: ResourceNode) => void;
    onClose: () => void;
}

export default function ImpactPanel({ mode, target, result, byId, isHidden, kindLabel, kindIcon, onPeek, onOpen, onClose }: Props) {
    const t = useT();
    const [copied, setCopied] = useState(false);
    const groups = useMemo(() => groupImpacts(result, byId, rankOf), [result, byId]);
    const title = t(mode === 'delete' ? 'panels:resourceGraph.impact.titleDelete' : 'panels:resourceGraph.impact.titleFail', {
        kind: kindLabel(target.kind), name: objectName(target),
    });
    const total = result.impacts.size;
    const noteText = (r: ImpactReason) => reasonText(t, r, kindLabel, 'note');
    const whyText = (r: ImpactReason) => reasonText(t, r, kindLabel, 'reason');

    const markdown = () => {
        const lines = [`### ${title}`, ''];
        if (result.dataLoss) lines.push(`> ⚠ ${t('panels:resourceGraph.impact.dataLossBanner')}`, '');
        for (const note of result.notes) lines.push(`- ${noteText(note)}`);
        if (result.notes.length) lines.push('');
        for (const level of IMPACT_LEVELS) {
            const list = groups.get(level)!;
            if (!list.length) continue;
            lines.push(`**${t(`panels:resourceGraph.impact.level.${level}` as never)} (${list.length})**`);
            for (const { node, impact } of list) {
                const why = impact.reasons.map(whyText).join('; ');
                lines.push(`- ${kindLabel(node.kind)} \`${objectName(node)}\` — ${why}`);
            }
            lines.push('');
        }
        if (!total) lines.push(t('panels:resourceGraph.impact.none'), '');
        lines.push(`_${t('panels:resourceGraph.impact.scope')}_`);
        return lines.join('\n');
    };

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(markdown());
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
        } catch {
            /* clipboard unavailable */
        }
    };

    return (
        <aside className="impact-panel" aria-label={title}>
            <div className="panel-toolbar">
                <span className="panel-toolbar__label">{kindIcon(target.kind)}<span className="cell-clip">{title}</span></span>
                <div className="panel-toolbar__actions">
                    <RowAction
                        icon={copied ? <VscCheck size={15} /> : <VscCopy size={15} />}
                        label={t(copied ? 'panels:resourceGraph.impact.copied' : 'panels:resourceGraph.impact.copy')}
                        onClick={copy}
                    />
                    <RowAction icon={<VscClose size={15} />} label={t('panels:resourceGraph.impact.close')} onClick={onClose} />
                </div>
            </div>
            <div className="impact-panel__body">
                <div className="impact-panel__counts">
                    {total === 0 && <StatusLamp tone="ok" label={t('panels:resourceGraph.impact.none')} />}
                    {IMPACT_LEVELS.map(level => {
                        const n = groups.get(level)!.length;
                        return n ? <StatusLamp key={level} tone={IMPACT_TONE[level]} label={`${n} · ${t(`panels:resourceGraph.impact.level.${level}` as never)}`} /> : null;
                    })}
                </div>
                {result.dataLoss && (
                    <div className="impact-panel__banner" role="alert">
                        <StatusLamp tone="err" label={t('panels:resourceGraph.impact.dataLossBanner')} />
                    </div>
                )}
                {result.notes.length > 0 && (
                    <ul className="impact-panel__notes">
                        {result.notes.map(note => <li key={note.code}>{noteText(note)}</li>)}
                    </ul>
                )}
                {IMPACT_LEVELS.map(level => {
                    const list = groups.get(level)!;
                    if (!list.length) return null;
                    return (
                        <section key={level} className="impact-panel__group">
                            <h3 className="impact-panel__heading">
                                <StatusLamp tone={IMPACT_TONE[level]} label={t(`panels:resourceGraph.impact.level.${level}` as never)} />
                                <span className="impact-panel__count">{list.length}</span>
                            </h3>
                            <ul>
                                {list.map(({ node, impact }) => (
                                    <li key={node.id}>
                                        <button
                                            type="button"
                                            className="impact-panel__row"
                                            onClick={() => onPeek(node.id)}
                                            onDoubleClick={() => onOpen(node)}
                                            title={t('panels:resourceGraph.impact.rowTitle')}
                                        >
                                            <span className="impact-panel__obj">
                                                {kindIcon(node.kind)}
                                                <span className="impact-panel__kind">{kindLabel(node.kind)}</span>
                                                <span className="impact-panel__name">{objectName(node)}</span>
                                                {isHidden(node.id) && <span className="impact-panel__tag">{t('panels:resourceGraph.impact.hidden')}</span>}
                                            </span>
                                            <span className="impact-panel__why">
                                                {impact.reasons.map(whyText).join(' · ')}
                                                {impact.recreated && ` · ${t('panels:resourceGraph.impact.recreated')}`}
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    );
                })}
                <p className="impact-panel__scope">{t('panels:resourceGraph.impact.scope')}</p>
            </div>
        </aside>
    );
}
