import { VscChevronDown, VscChevronRight, VscSymbolNamespace } from 'react-icons/vsc';
import { models } from '../../../wailsjs/go/models';
import { COUNT_UNKNOWN, CrdGroup } from './useCrdExplorer';
import { useT } from '../../i18n/useT';

interface CrdTreeProps {
    groups: CrdGroup[];
    counts: Record<string, number>;
    countsLoading: boolean;
    catalogLoading: boolean;
    selectedName: string | null;
    onSelect: (crd: models.CRDInfo) => void;
    isExpanded: (group: string) => boolean;
    onToggleGroup: (group: string) => void;
}

const groupLabel = (group: string) => group || 'core';

/**
 * Left pane of the CRD explorer: API group → kind, with live instance counts.
 *
 * Hand-rolled rather than PrimeReact's `Tree` because the search-driven
 * auto-expand and the count/scope badges are simpler as plain markup, and it
 * avoids pulling a whole new `.p-tree*` surface into theme-monolith.css.
 */
export default function CrdTree(props: CrdTreeProps) {
    const t = useT();
    const { groups, counts, countsLoading, catalogLoading, selectedName, onSelect, isExpanded, onToggleGroup } = props;

    if (catalogLoading && groups.length === 0) {
        return <div className="crd-tree__empty">{t('panels:crd.loading')}</div>;
    }
    if (groups.length === 0) {
        return <div className="crd-tree__empty">{t('panels:crd.noMatch')}</div>;
    }

    return (
        <div className="crd-tree">
            {groups.map(({ group, crds }) => {
                const expanded = isExpanded(group);
                return (
                    <div key={group || 'core'} className="crd-tree__group">
                        <button
                            type="button"
                            className="crd-tree__group-header"
                            onClick={() => onToggleGroup(group)}
                            title={groupLabel(group)}
                        >
                            {expanded ? <VscChevronDown size={15} /> : <VscChevronRight size={15} />}
                            <VscSymbolNamespace size={15} className="crd-tree__group-icon" />
                            <span className="crd-tree__group-name">{groupLabel(group)}</span>
                            {/* Inline rather than right-aligned: the right edge
                                is where instance counts live, and a kind count
                                sitting in the same column reads as one. */}
                            <span className="crd-tree__group-count">
                                ({crds.length} {t('panels:crd.kind', { count: crds.length })})
                            </span>
                        </button>

                        {expanded && crds.map((crd) => {
                            const count = counts[crd.name];
                            const known = count !== undefined && count !== COUNT_UNKNOWN;
                            return (
                                <button
                                    type="button"
                                    key={crd.name}
                                    className={`crd-tree__kind${crd.name === selectedName ? ' is-selected' : ''}`}
                                    onClick={() => onSelect(crd)}
                                    title={`${crd.plural}${crd.group ? '.' + crd.group : ''}`}
                                >
                                    <span className="crd-tree__kind-name">{crd.kind}</span>
                                    <span className="crd-tree__kind-plural">{crd.plural}</span>
                                    <span className={`crd-tree__scope crd-tree__scope--${t(crd.scope === 'Namespaced' ? 'panels:crd.scopeNamespaced' : 'panels:crd.scopeCluster')}`}>
                                        {t(crd.scope === 'Namespaced' ? 'panels:crd.scopeNamespaced' : 'panels:crd.scopeCluster')}
                                    </span>
                                    <span className={`crd-tree__badge${known && count > 0 ? ' is-live' : ''}`}>
                                        {known ? count : countsLoading ? '·' : '—'}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                );
            })}
        </div>
    );
}
