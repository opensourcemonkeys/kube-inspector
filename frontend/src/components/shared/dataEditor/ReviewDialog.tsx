import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'primereact/button';
import { Checkbox } from 'primereact/checkbox';
import { Dialog } from 'primereact/dialog';
import { VscCheck, VscClose, VscDebugRestart, VscEye, VscEyeClosed, VscRefresh } from 'react-icons/vsc';
import { RestartWorkload, SaveDataObject } from '../../../../wailsjs/go/controller_app/App';
import type { models } from '../../../../wailsjs/go/models';
import { useT } from '../../../i18n/useT';
import { errText } from '../../../lib/errText';
import StatusLamp from '../StatusLamp';
import { RESTARTABLE, type Consumers } from './ConsumersSection';
import { byteSize, entriesForSave, languageFor, type Change, type DataKind, type Entry } from './dataEditorModel';
import type { DataEditorState } from './useDataEditor';
import { formatBytes } from './ValuePane';

const YamlDiff = lazy(() => import('../../toolbox/history/YamlDiff'));

type Phase =
    | { step: 'checking' }
    | { step: 'ready' }
    | { step: 'failed'; code: string; message: string }
    | { step: 'saving' }
    | { step: 'restart'; consumers: models.DataConsumer[] };

type RestartState = Record<string, 'running' | 'ok' | string>;

const consumerKey = (c: models.DataConsumer) => `${c.kind}/${c.name}`;

/** The DataSaveResult codes the dialog words itself; anything else is the API server's refusal. */
const codeKey = (code: string) => (['conflict', 'immutable', 'invalid'] as const).find((c) => c === code) ?? 'rejected';

const MARK: Record<Change['kind'], string> = { added: '+', modified: '●', removed: '−' };

/**
 * The one way a change is saved: the API server dry-runs exactly the write
 * first, the save stays off until that passes, and the user sees every key it
 * touches. After the save it offers to restart the workloads that only read
 * the object when their containers start.
 */
export default function ReviewDialog({ visible, onHide, kind, clusterName, namespace, name, state, consumers, onSaved }: {
    visible: boolean;
    onHide: () => void;
    kind: DataKind;
    clusterName: string;
    namespace: string;
    name: string;
    state: DataEditorState;
    consumers: Consumers;
    onSaved: () => void;
}) {
    const t = useT();
    const { changes, draft, meta } = state;
    const [phase, setPhase] = useState<Phase>({ step: 'checking' });
    const [selected, setSelected] = useState<string | null>(null);
    const [showValues, setShowValues] = useState(false);
    const [restartPick, setRestartPick] = useState<Set<string>>(new Set());
    const [restartState, setRestartState] = useState<RestartState>({});
    const isSecret = kind === 'Secret';
    const rv = meta?.resourceVersion ?? '';
    // Set once the save went through: the reload that follows moves rv, and
    // that must not send the dialog back to a dry run.
    const savedRef = useRef(false);

    // Dry-run on open, and again after "apply mine" has moved the draft onto a newer version.
    useEffect(() => {
        if (!visible) {
            savedRef.current = false;
            return;
        }
        if (savedRef.current) return;
        let stale = false;
        setPhase({ step: 'checking' });
        setShowValues(false);
        SaveDataObject(clusterName, kind, namespace, name, rv, entriesForSave(draft), true)
            .then((r) => {
                if (stale) return;
                setPhase(r.code ? { step: 'failed', code: r.code, message: r.message } : { step: 'ready' });
            })
            .catch((e) => { if (!stale) setPhase({ step: 'failed', code: 'error', message: errText(e) }); });
        return () => { stale = true; };
        // The draft cannot change while this modal is open; rv moves after a rebase.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, rv]);

    useEffect(() => {
        if (visible) setSelected(changes[0]?.key ?? null);
    }, [visible, changes]);

    const current = changes.find((c) => c.key === selected) ?? changes[0];

    const save = async () => {
        setPhase({ step: 'saving' });
        try {
            const r = await SaveDataObject(clusterName, kind, namespace, name, rv, entriesForSave(draft), false);
            if (r.code) {
                setPhase({ step: 'failed', code: r.code, message: r.message });
                return;
            }
            savedRef.current = true;
            await state.reloadKeepingSelection();
            onSaved();
            const needing = consumers.state === 'ok' ? consumers.items.filter((c) => c.needsRestart) : [];
            if (needing.length === 0) {
                onHide();
                return;
            }
            setRestartPick(new Set(needing.filter((c) => RESTARTABLE.has(c.kind)).map(consumerKey)));
            setRestartState({});
            setPhase({ step: 'restart', consumers: needing });
        } catch (e) {
            setPhase({ step: 'failed', code: 'error', message: errText(e) });
        }
    };

    const restart = async (list: models.DataConsumer[]) => {
        for (const c of list.filter((x) => restartPick.has(consumerKey(x)))) {
            const k = consumerKey(c);
            setRestartState((s) => ({ ...s, [k]: 'running' }));
            try {
                await RestartWorkload(clusterName, c.kind.toLowerCase(), c.name, namespace);
                setRestartState((s) => ({ ...s, [k]: 'ok' }));
            } catch (e) {
                setRestartState((s) => ({ ...s, [k]: errText(e) }));
            }
        }
    };

    const applyMine = async () => {
        try {
            await state.rebase();
        } catch (e) {
            setPhase({ step: 'failed', code: 'error', message: errText(e) });
        }
    };

    const valueText = (e: Entry | undefined) => {
        if (!e) return '';
        if (e.binary) return t('panels:dataEditor.binaryValue', { size: formatBytes(byteSize(e)) });
        if (isSecret && !showValues) return t('panels:dataEditor.hiddenValue', { size: formatBytes(byteSize(e)) });
        return e.value;
    };

    const diff = useMemo(() => {
        if (!current) return null;
        const before = current.kind === 'added' ? undefined : current.before;
        const after = current.kind === 'removed' ? undefined : current.entry;
        return { before: valueText(before), after: valueText(after), language: languageFor(current.key) };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [current, showValues]);

    const changeLabel = (c: Change) => {
        if (c.kind === 'modified' && c.renamedFrom) return t('panels:dataEditor.review.renamed', { from: c.renamedFrom });
        return t(`panels:dataEditor.review.${c.kind}`);
    };

    if (phase.step === 'restart') {
        const done = phase.consumers.every((c) => !restartPick.has(consumerKey(c)) || restartState[consumerKey(c)] !== undefined);
        const running = Object.values(restartState).includes('running');
        return (
            <Dialog header={t('panels:dataEditor.restart.title')} visible={visible} onHide={onHide} className="de-review-dialog de-review-dialog--small" modal
                footer={
                    <div className="dlg-actions">
                        <Button label={t(done && Object.keys(restartState).length ? 'action.close' : 'panels:dataEditor.restart.skip')} text onClick={onHide} disabled={running} />
                        <Button label={t('panels:dataEditor.restart.confirm')} icon={<VscDebugRestart size={16} />} severity="danger"
                            disabled={running || restartPick.size === 0 || (done && Object.keys(restartState).length > 0)}
                            onClick={() => restart(phase.consumers)} />
                    </div>
                }>
                <div className="dlg-form">
                    <StatusLamp tone="ok" label={t('panels:dataEditor.review.savedOk')} />
                    <p className="dlg-message">{t('panels:dataEditor.restart.message')}</p>
                    <ul className="de-restart">
                        {phase.consumers.map((c) => {
                            const k = consumerKey(c);
                            const can = RESTARTABLE.has(c.kind);
                            const st = restartState[k];
                            return (
                                <li key={k} className="de-restart__row">
                                    <Checkbox inputId={`de-restart-${k}`} checked={restartPick.has(k)} disabled={!can || st !== undefined}
                                        onChange={(e) => setRestartPick((p) => {
                                            const n = new Set(p);
                                            if (e.checked) n.add(k); else n.delete(k);
                                            return n;
                                        })} />
                                    <label htmlFor={`de-restart-${k}`} className="de-restart__ref">{k}</label>
                                    <span className="de-restart__usage">{c.usages.join(', ')}</span>
                                    {!can && <span className="dlg-note">{t('panels:dataEditor.restart.manual')}</span>}
                                    {st === 'running' && <StatusLamp tone="idle" label={t('panels:dataEditor.restart.running')} />}
                                    {st === 'ok' && <StatusLamp tone="ok" label={t('panels:dataEditor.restart.started')} />}
                                    {st !== undefined && st !== 'running' && st !== 'ok' && <StatusLamp tone="err" label={t('panels:dataEditor.restart.failed')} title={st} />}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </Dialog>
        );
    }

    const conflict = phase.step === 'failed' && phase.code === 'conflict';
    const footer = (
        <div className="dlg-actions">
            <Button label={t('action.cancel')} icon={<VscClose size={16} />} text onClick={onHide} disabled={phase.step === 'saving'} />
            {conflict ? (
                <>
                    <Button label={t('panels:dataEditor.conflict.reload')} icon={<VscRefresh size={16} />} outlined
                        onClick={async () => { await state.load(); onHide(); }} />
                    <Button label={t('panels:dataEditor.conflict.applyMine')} icon={<VscCheck size={16} />}
                        onClick={applyMine} />
                </>
            ) : (
                <Button label={t('panels:yaml.save')} icon={<VscCheck size={16} />} loading={phase.step === 'saving'}
                    disabled={phase.step !== 'ready'} onClick={save} />
            )}
        </div>
    );

    return (
        <Dialog header={t('panels:dataEditor.review.title', { name: `${namespace}/${name}` })} visible={visible} onHide={onHide}
            className="de-review-dialog" modal footer={footer}>
            <div className="de-review">
                <div className="de-review__status">
                    {phase.step === 'checking' && <StatusLamp tone="idle" label={t('panels:dataEditor.review.checking')} />}
                    {phase.step === 'ready' && <StatusLamp tone="ok" label={t('panels:dataEditor.review.checked')} />}
                    {phase.step === 'saving' && <StatusLamp tone="idle" label={t('panels:dataEditor.review.saving')} />}
                    {phase.step === 'failed' && (
                        <>
                            <StatusLamp tone="err" label={t(`panels:dataEditor.review.code.${codeKey(phase.code)}`)} />
                            {/* A conflict or an immutable object is said in full by the label. */}
                            {phase.message && codeKey(phase.code) !== 'conflict' && codeKey(phase.code) !== 'immutable' && (
                                <p className="dlg-error">{phase.message}</p>
                            )}
                        </>
                    )}
                    {isSecret && (
                        <Button className="de-review__reveal" text size="small"
                            icon={showValues ? <VscEyeClosed size={14} /> : <VscEye size={14} />}
                            label={t(showValues ? 'panels:dataEditor.review.hideValues' : 'panels:dataEditor.review.showValues')}
                            onClick={() => setShowValues((v) => !v)} />
                    )}
                </div>
                <div className="de-review__body">
                    <ul className="de-review__changes" aria-label={t('panels:dataEditor.review.changes', { count: changes.length })}>
                        {changes.map((c) => (
                            <li key={c.key}>
                                <button type="button" className={`de-change de-change--${c.kind}${c.key === current?.key ? ' is-selected' : ''}`}
                                    onClick={() => setSelected(c.key)}>
                                    <span className="de-key__mark" aria-hidden>{MARK[c.kind]}</span>
                                    <span className="de-change__key">{c.key}</span>
                                    <span className="de-change__kind">{changeLabel(c)}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                    <div className="de-review__diff dark-display">
                        {diff && (
                            <Suspense fallback={null}>
                                <YamlDiff key={`${current?.key}-${showValues}`} original={diff.before} modified={diff.after} sideBySide language={diff.language} />
                            </Suspense>
                        )}
                    </div>
                </div>
            </div>
        </Dialog>
    );
}
