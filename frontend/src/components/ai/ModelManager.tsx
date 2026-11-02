import { useCallback, useEffect, useState } from 'react';
import { VscCheck, VscChromeClose, VscCloudDownload, VscChevronRight, VscChevronDown } from 'react-icons/vsc';
import { ListAiModelCatalog, ListAiModelTags } from '../../../wailsjs/go/controller_app/App';
import { models as goModels } from '../../../wailsjs/go/models';
import { useAiPullStore } from '../../stores/aiPullStore';
import { useT } from '../../i18n/useT';
import RowAction from '../shared/RowAction';
import StatusLamp from '../shared/StatusLamp';

function fmtBytes(n?: number): string {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/**
 * The model manager: the catalog (registry recommendations + curated list +
 * what is installed), size variants per model, and free-text pulls. Downloads
 * live in useAiPullStore, so they survive switching back to the chat.
 */
export default function ModelManager({ host, installed, reloadKey }: { host: string; installed: string[]; reloadKey: number }) {
    const t = useT();
    const { pulls, start, cancel } = useAiPullStore();
    const [catalog, setCatalog] = useState<goModels.OllamaModelInfo[]>([]);
    const [catalogError, setCatalogError] = useState('');
    const [search, setSearch] = useState('');
    const [pullInput, setPullInput] = useState('');
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [tags, setTags] = useState<Record<string, string[] | 'loading' | 'error'>>({});

    const loadCatalog = useCallback(() => {
        setCatalogError('');
        ListAiModelCatalog(host)
            .then((c) => setCatalog(c || []))
            .catch((e) => setCatalogError(String(e)));
    }, [host]);
    useEffect(() => { loadCatalog(); }, [loadCatalog, reloadKey]);

    const startPull = (name: string) => start(host, name, t('panels:ai.pullStarting'));
    const pullFreeText = () => {
        const v = pullInput.trim();
        if (!v) return;
        startPull(v);
        setPullInput('');
    };
    const toggleExpand = (base: string) => {
        setExpanded((prev) => ({ ...prev, [base]: !prev[base] }));
        if (!tags[base]) {
            setTags((prev) => ({ ...prev, [base]: 'loading' }));
            ListAiModelTags(base)
                .then((tg) => setTags((prev) => ({ ...prev, [base]: tg || [] })))
                .catch(() => setTags((prev) => ({ ...prev, [base]: 'error' })));
        }
    };

    const installedSet = new Set(installed);
    const isInstalled = (ref: string) => installedSet.has(ref) || installedSet.has(`${ref}:latest`);
    const activePulls = Object.entries(pulls);
    const q = search.trim().toLowerCase();
    const filtered = catalog.filter((m) => !q || m.name.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q));

    const action = (ref: string, size: number) => {
        const pull = pulls[ref];
        if (isInstalled(ref)) {
            return <span className="ai-model__installed" title={t('panels:ai.installed')}><VscCheck size={size} aria-label={t('panels:ai.installed')} /></span>;
        }
        if (pull && !pull.error) {
            return <RowAction icon={<VscChromeClose size={size} />} label={t('panels:ai.cancel')} onClick={() => cancel(ref)} />;
        }
        return <RowAction icon={<VscCloudDownload size={size + 1} />} label={t('panels:ai.downloadModel', { name: ref })} onClick={() => startPull(ref)} />;
    };

    return (
        <div className="ai-models">
            <div className="ai-models__search">
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('panels:ai.searchCatalog')} />
            </div>
            <div className="ai-models__pull">
                <input
                    value={pullInput}
                    onChange={(e) => setPullInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); pullFreeText(); } }}
                    placeholder={t('panels:ai.pullPlaceholder')}
                />
                <RowAction icon={<VscCloudDownload size={15} />} label={t('panels:ai.download')} disabled={!pullInput.trim()} onClick={pullFreeText} />
            </div>
            {catalogError && <div className="ai-panel__hint">{t('panels:ai.catalogError', { error: catalogError })}</div>}

            <div className="ai-models__list">
                {/* active downloads (covers free-text pulls not shown elsewhere) */}
                {activePulls.length > 0 && (
                    <div className="ai-models__active">
                        {activePulls.map(([name, pull]) => (
                            <div className="ai-model ai-model--pulling" key={`p-${name}`}>
                                <div className="ai-model__info">
                                    <div className="ai-model__name">{name}</div>
                                    <div className="ai-model__progress">
                                        <div className="ai-model__bar"><div className="ai-model__barfill" style={{ width: `${Math.max(2, pull.percent)}%` }} /></div>
                                        <div className={`ai-model__pstatus${pull.error ? ' ai-model__pstatus--err' : ''}`}>
                                            {pull.error ? t('panels:ai.pullFailed', { error: pull.error }) : (
                                                <>
                                                    <span>{pull.status}</span>
                                                    {pull.percent > 0 && <span>{pull.percent.toFixed(0)}%</span>}
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </div>
                                <div className="ai-model__action">
                                    <RowAction icon={<VscChromeClose size={14} />} label={t('panels:ai.cancel')} onClick={() => cancel(name)} />
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {filtered.map((m) => {
                    const base = m.name.split(':')[0];
                    const isOpen = !!expanded[base];
                    const tagState = tags[base];
                    return (
                        <div className="ai-model-group" key={m.name}>
                            <div className="ai-model">
                                <button className="ai-model__expand" title={t('panels:ai.showSizes')} aria-label={t('panels:ai.showSizes')} aria-expanded={isOpen} onClick={() => toggleExpand(base)}>
                                    {isOpen ? <VscChevronDown size={13} /> : <VscChevronRight size={13} />}
                                </button>
                                <div className="ai-model__info ai-model__info--toggle" onClick={() => toggleExpand(base)}>
                                    <div className="ai-model__name">
                                        {m.name}
                                        {m.installed && <StatusLamp label={t('panels:ai.installed')} tone="ok" />}
                                        {!!m.vramBytes && <span className="ai-model__meta">~{fmtBytes(m.vramBytes)} VRAM</span>}
                                    </div>
                                    {m.description && <div className="ai-model__desc">{m.description}</div>}
                                </div>
                                <div className="ai-model__action">{action(m.name, 14)}</div>
                            </div>

                            {isOpen && (
                                <div className="ai-variants">
                                    {tagState === 'loading' && <div className="ai-variants__msg">{t('panels:ai.loadingSizes')}</div>}
                                    {tagState === 'error' && <div className="ai-variants__msg">{t('panels:ai.sizesError')}</div>}
                                    {Array.isArray(tagState) && tagState.length === 0 && <div className="ai-variants__msg">{t('panels:ai.noTags')}</div>}
                                    {Array.isArray(tagState) && tagState.map((tag) => {
                                        const ref = `${base}:${tag}`;
                                        const vpull = pulls[ref];
                                        return (
                                            <div className="ai-variant" key={ref}>
                                                <span className="ai-variant__tag">{tag}</span>
                                                {vpull && (
                                                    <span className={`ai-variant__status${vpull.error ? ' ai-model__pstatus--err' : ''}`}>
                                                        {vpull.error ? t('panels:ai.pullError') : `${vpull.percent ? vpull.percent.toFixed(0) + '%' : vpull.status}`}
                                                    </span>
                                                )}
                                                {action(ref, 13)}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}
                {filtered.length === 0 && !catalogError && <div className="ai-panel__empty">{t('panels:ai.noModelsMatch')}</div>}
            </div>
        </div>
    );
}
