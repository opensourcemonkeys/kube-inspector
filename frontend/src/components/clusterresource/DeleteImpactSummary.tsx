import { useEffect, useMemo, useState } from 'react';
import { GetClusterGraph } from '../../../wailsjs/go/controller_app/App';
import { useT } from '../../i18n/useT';
import { errText } from '../../lib/errText';
import Spinner from '../shared/Spinner';
import StatusLamp from '../shared/StatusLamp';
import { IMPACT_TONE, impactLabel, reasonText } from './ImpactPanel';
import { rankOf, type ClusterGraph, type ResourceNode } from './graphLayout';
import { groupImpacts, IMPACT_LEVELS, kindShortLabel, simulateImpactMany, type ImpactResult } from './impact';

// The blast radius of a list's delete, inside its confirmation dialog: what
// else is removed or breaks if the selected rows go. Loaded lazily by
// ResourceListView, so the graph code stays out of every list's bundle.

// Kinds without a namespace; their users can be in any namespace, so the
// whole cluster is read for them.
const CLUSTER_SCOPED = new Set(['PersistentVolume', 'StorageClass']);

// Enough rows to see what kind of damage it is; the counts say how much.
const MAX_ROWS = 8;

export interface DeleteImpactTarget {
    name: string;
    namespace?: string;
}

type State =
    | { phase: 'loading' }
    | { phase: 'failed'; message: string }
    | { phase: 'ready'; graph: ClusterGraph; result: ImpactResult };

export default function DeleteImpactSummary({ clusterName, kind, targets }: {
    clusterName: string;
    /** The graph's kind name, e.g. "Deployment". */
    kind: string;
    targets: DeleteImpactTarget[];
}) {
    const t = useT();
    const clusterScoped = CLUSTER_SCOPED.has(kind);
    // A string key: the dialog re-renders with a new array of the same rows.
    const key = targets.map(x => `${x.namespace ?? ''}/${x.name}`).join('|');
    const namespaces = useMemo(
        () => (clusterScoped ? [] : [...new Set(targets.map(x => x.namespace ?? ''))].filter(Boolean).sort()),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [key, clusterScoped],
    );
    const [state, setState] = useState<State>({ phase: 'loading' });

    useEffect(() => {
        let live = true;
        setState({ phase: 'loading' });
        const ids = targets.map(x => `${kind.toLowerCase()}/${clusterScoped ? '' : x.namespace ?? ''}/${x.name}`);
        GetClusterGraph(clusterName, namespaces)
            .then(raw => {
                if (!live) return;
                const graph = raw as unknown as ClusterGraph;
                setState({ phase: 'ready', graph, result: simulateImpactMany(graph, ids, 'delete') });
            })
            .catch(err => { if (live) setState({ phase: 'failed', message: errText(err) }); });
        return () => { live = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clusterName, kind, key, namespaces]);

    const byId = useMemo(
        () => (state.phase === 'ready' ? new Map<string, ResourceNode>(state.graph.nodes.map(n => [n.id, n])) : new Map<string, ResourceNode>()),
        [state],
    );
    const groups = useMemo(
        () => (state.phase === 'ready' ? groupImpacts(state.result, byId, rankOf) : null),
        [state, byId],
    );

    const title = <h3 className="delete-impact__title">{t('panels:resourceGraph.impact.deleteTitle')}</h3>;

    if (state.phase === 'loading') {
        return (
            <section className="delete-impact" aria-busy="true">
                {title}
                <p className="delete-impact__note"><Spinner /> {t('panels:resourceGraph.impact.computing')}</p>
            </section>
        );
    }
    if (state.phase === 'failed') {
        return (
            <section className="delete-impact">
                {title}
                <p className="delete-impact__note" title={state.message}>{t('panels:resourceGraph.impact.computeFailed')}</p>
            </section>
        );
    }

    const { result } = state;
    const rows = IMPACT_LEVELS.flatMap(level => groups!.get(level)!);
    const why = (r: Parameters<typeof reasonText>[1]) => reasonText(t, r, kindShortLabel, 'reason');
    const noteText = (r: Parameters<typeof reasonText>[1]) => reasonText(t, r, kindShortLabel, 'note');
    const scope = clusterScoped
        ? t('panels:resourceGraph.impact.scopeCluster')
        : t('panels:resourceGraph.impact.scopeNamespaces', { namespaces: namespaces.join(', ') });

    return (
        <section className="delete-impact" aria-live="polite">
            {title}
            <div className="delete-impact__counts">
                {rows.length === 0 && <StatusLamp tone="ok" label={t('panels:resourceGraph.impact.none')} />}
                {IMPACT_LEVELS.map(level => {
                    const n = groups!.get(level)!.length;
                    return n ? <StatusLamp key={level} tone={IMPACT_TONE[level]} label={`${n} · ${t(`panels:resourceGraph.impact.level.${level}` as never)}`} /> : null;
                })}
            </div>
            {result.dataLoss && (
                <div className="impact-panel__banner" role="alert">
                    <StatusLamp tone="err" label={t('panels:resourceGraph.impact.dataLossBanner')} />
                </div>
            )}
            {result.notes.length > 0 && (
                <ul className="delete-impact__notes">
                    {result.notes.map(note => <li key={JSON.stringify(note)}>{noteText(note)}</li>)}
                </ul>
            )}
            {rows.length > 0 && (
                <ul className="delete-impact__rows">
                    {rows.slice(0, MAX_ROWS).map(({ node, impact }) => (
                        <li key={node.id}>
                            <span className="delete-impact__obj">
                                <StatusLamp tone={IMPACT_TONE[impact.level]} label={impactLabel(t, impact)} markOnly />
                                <span className="delete-impact__kind">{kindShortLabel(node.kind)}</span>
                                <span className="delete-impact__name">{node.namespace ? `${node.namespace}/` : ''}{node.name}</span>
                            </span>
                            <span className="delete-impact__why">{impact.reasons.map(why).join(' · ')}</span>
                        </li>
                    ))}
                </ul>
            )}
            {rows.length > MAX_ROWS && (
                <p className="delete-impact__note">{t('panels:resourceGraph.impact.moreAffected', { count: rows.length - MAX_ROWS })}</p>
            )}
            <p className="delete-impact__note">{scope}</p>
        </section>
    );
}
