import { useCallback, useEffect, useRef, useState } from 'react';
import type { DockviewPanelApi } from 'dockview';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { VscAdd, VscCheck, VscCloudUpload, VscDiscard, VscLock, VscSettings } from 'react-icons/vsc';
import { GetDataConsumers } from '../../../../wailsjs/go/controller_app/App';
import { useT } from '../../../i18n/useT';
import { errText } from '../../../lib/errText';
import { usePanelActive } from '../../../lib/usePanelActive';
import { useSplitPane } from '../../../lib/useSplitPane';
import PanelSkeleton from '../PanelSkeleton';
import StatusLamp from '../StatusLamp';
import ConsumersSection, { type Consumers } from './ConsumersSection';
import { hasKeyProblems, type DataKind } from './dataEditorModel';
import KeyList from './KeyList';
import ReviewDialog from './ReviewDialog';
import { useDataEditor } from './useDataEditor';
import ValuePane, { pickFile } from './ValuePane';
import { TOAST_LIFE } from '../../../lib/toast';

const KEYS_WIDTH_KEY = 'kube-ins-data-editor-keys';
const DEFAULT_KEYS_WIDTH = 280;
const MIN_PANE = 200;

const isInMonaco = (target: EventTarget | null) =>
    target instanceof Element && target.closest('.monaco-editor') !== null;

/**
 * The ConfigMap and Secret editor: keys on the left, the selected value on
 * the right in Monaco, and a reviewed, dry-run save. Both panels are thin
 * wrappers around this.
 */
export default function DataEditor({ kind, clusterName, namespace, name, api }: {
    kind: DataKind;
    clusterName: string;
    namespace: string;
    name: string;
    api: DockviewPanelApi;
}) {
    const t = useT();
    const state = useDataEditor(clusterName, kind, namespace, name, api.id);
    const { meta, loadError, original, draft, changes, dirty, selectedId, setSelectedId } = state;
    const panelActive = usePanelActive(api);
    const toast = useRef<Toast | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const { splitRef, width, startResize } = useSplitPane(KEYS_WIDTH_KEY, DEFAULT_KEYS_WIDTH, MIN_PANE, 'x', 'start');
    const [revealed, setRevealed] = useState(false);
    const [reviewOpen, setReviewOpen] = useState(false);
    const [consumers, setConsumers] = useState<Consumers>({ state: 'loading' });

    const notify = useCallback((severity: 'success' | 'error', summary: string, detail?: string) => {
        toast.current?.show({ severity, summary, detail, life: TOAST_LIFE[severity] });
    }, []);

    const loadConsumers = useCallback(() => {
        GetDataConsumers(clusterName, kind, namespace, name)
            .then((items) => setConsumers({ state: 'ok', items: items ?? [] }))
            .catch((e) => setConsumers({ state: 'error', message: errText(e) }));
    }, [clusterName, kind, namespace, name]);

    useEffect(loadConsumers, [loadConsumers]);

    // A shown Secret value hides again on another key, in a background tab and after a save.
    useEffect(() => { setRevealed(false); }, [selectedId, panelActive]);

    const readOnly = meta?.immutable ?? false;
    const canReview = dirty && !readOnly && !hasKeyProblems(draft);
    const selected = draft.find((e) => e.id === selectedId);

    const addFromFile = async () => {
        const file = await pickFile();
        if (file) state.addFile(file.name, file.bytes);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === 's') {
            e.preventDefault();
            if (canReview) setReviewOpen(true);
        } else if (mod && e.key.toLowerCase() === 'f' && !isInMonaco(e.target)) {
            e.preventDefault();
            searchRef.current?.focus();
        } else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !isInMonaco(e.target)) {
            e.preventDefault();
            const order = [...draft].sort((a, b) => a.key.localeCompare(b.key));
            const i = order.findIndex((x) => x.id === selectedId);
            const next = order[i + (e.key === 'ArrowDown' ? 1 : -1)];
            if (next) setSelectedId(next.id);
        }
    };

    const onSaved = () => {
        setRevealed(false);
        loadConsumers();
        notify('success', t('panels:dataEditor.savedObject', { name: `${namespace}/${name}` }));
    };

    const Icon = kind === 'Secret' ? VscLock : VscSettings;
    const emptyKey = kind === 'Secret' ? 'panels:dataEditor.emptySecret' : 'panels:dataEditor.emptyConfigMap';

    return (
        <div className="de" onKeyDown={onKeyDown}>
            <Toast ref={toast} position="bottom-right" />
            <div className="panel-toolbar">
                <span className="panel-toolbar__label">
                    <Icon size={14} aria-hidden />
                    <span className="cell-clip">{namespace}/{name}</span>
                    {meta?.type && <span className="de-toolbar__type">{meta.type}</span>}
                    {readOnly && <StatusLamp tone="info" label={t('panels:dataEditor.immutable')} />}
                </span>
                <div className="panel-toolbar__actions">
                    <Button label={t('panels:dataEditor.addKey')} icon={<VscAdd size={16} />} text size="small" onClick={() => state.add()} disabled={readOnly || !meta} />
                    <Button label={t('panels:dataEditor.addFromFile')} icon={<VscCloudUpload size={16} />} text size="small" onClick={addFromFile} disabled={readOnly || !meta} />
                    <Button label={t('panels:yaml.revert')} icon={<VscDiscard size={16} />} text size="small" onClick={state.revert} disabled={!dirty} />
                    <Button
                        label={dirty ? t('panels:dataEditor.reviewCount', { count: changes.length }) : t('panels:dataEditor.review.open')}
                        icon={<VscCheck size={16} />}
                        size="small"
                        disabled={!canReview}
                        title={t('panels:dataEditor.reviewHint')}
                        onClick={() => setReviewOpen(true)}
                    />
                </div>
            </div>

            {loadError ? (
                <div className="rlv-empty">
                    <StatusLamp tone="err" label={t('panels:dataEditor.loadFailed')} />
                    <p className="dlg-error">{loadError}</p>
                    <Button label={t('action.retry')} outlined size="small" onClick={() => void state.load()} />
                </div>
            ) : !meta ? (
                <PanelSkeleton />
            ) : (
                <div className="de-split" ref={splitRef}>
                    <div className="de-split__keys" style={{ width }}>
                        <KeyList ref={searchRef} original={original} draft={draft} selectedId={selectedId} onSelect={setSelectedId} />
                        <ConsumersSection consumers={consumers} clusterName={clusterName} namespace={namespace} />
                    </div>
                    <div className="pod-split__handle" role="separator" aria-orientation="vertical" onPointerDown={startResize} />
                    <div className="de-split__value">
                        {draft.length === 0 ? (
                            <div className="rlv-empty">
                                <span>{t(emptyKey)}</span>
                                <div className="dlg-actions">
                                    <Button label={t('panels:dataEditor.addKey')} icon={<VscAdd size={14} />} outlined size="small" onClick={() => state.add()} disabled={readOnly} />
                                    <Button label={t('panels:dataEditor.addFromFile')} icon={<VscCloudUpload size={14} />} outlined size="small" onClick={addFromFile} disabled={readOnly} />
                                </div>
                            </div>
                        ) : (
                            <ValuePane
                                kind={kind}
                                state={state}
                                entry={selected}
                                secretType={meta.type}
                                readOnly={readOnly}
                                revealed={revealed}
                                setRevealed={setRevealed}
                                notify={notify}
                            />
                        )}
                    </div>
                </div>
            )}

            <ReviewDialog
                visible={reviewOpen}
                onHide={() => setReviewOpen(false)}
                kind={kind}
                clusterName={clusterName}
                namespace={namespace}
                name={name}
                state={state}
                consumers={consumers}
                onSaved={onSaved}
            />
        </div>
    );
}
