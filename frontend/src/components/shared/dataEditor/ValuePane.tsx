import { useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react';
// Configures @monaco-editor/react to use the bundled Monaco (see there).
import '../../../lib/monacoBootstrap';
import type * as monacoEditor from 'monaco-editor';
import { Button } from 'primereact/button';
import { InputText } from 'primereact/inputtext';
import { VscCloudDownload, VscCloudUpload, VscCopy, VscDiscard, VscEye, VscEyeClosed, VscTrash } from 'react-icons/vsc';
import { SaveDataValue } from '../../../../wailsjs/go/controller_app/App';
import { useT } from '../../../i18n/useT';
import { errText } from '../../../lib/errText';
import { PLAIN_YAML_PATH } from '../../../lib/k8sYamlIntellisense';
import { MONACO_BASE_OPTIONS, MONACO_THEME, defineMonacoTheme, useMonacoTheme } from '../../../lib/monacoTheme';
import RowAction from '../RowAction';
import Segmented from '../Segmented';
import StatusLamp from '../StatusLamp';
import DockerConfigForm from './DockerConfigForm';
import TlsSummary from './TlsSummary';
import {
    byteSize, keyProblem, languageFor, parseDockerConfig, parseProblem, textToBase64,
    type DataKind, type Entry,
} from './dataEditorModel';
import type { DataEditorState } from './useDataEditor';

const EDITOR_OPTIONS: monacoEditor.editor.IStandaloneEditorConstructionOptions = {
    ...MONACO_BASE_OPTIONS,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: 'line',
    tabSize: 2,
};

const DOCKER_TYPE = 'kubernetes.io/dockerconfigjson';
const DOCKER_FORM = 'form';
const DOCKER_RAW = 'raw';
const TLS_TYPE = 'kubernetes.io/tls';

/** Human size: bytes below 1 KiB, then KiB / MiB with one decimal. */
export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

/** Reads a picked file's bytes; resolves null when the picker was dismissed. */
export function pickFile(): Promise<{ name: string; bytes: Uint8Array } | null> {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return resolve(null);
            resolve({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
        };
        input.oncancel = () => resolve(null);
        input.click();
    });
}

/**
 * The right pane: the selected key's name and value. Text values open in
 * Monaco with the grammar their extension suggests; a binary value is a file
 * to download or replace; a Secret value stays hidden until asked for.
 */
export default function ValuePane({ kind, state, entry, secretType, readOnly, revealed, setRevealed, notify }: {
    kind: DataKind;
    state: DataEditorState;
    entry: Entry | undefined;
    secretType: string;
    readOnly: boolean;
    revealed: boolean;
    setRevealed: (v: boolean) => void;
    notify: (severity: 'success' | 'error', summary: string, detail?: string) => void;
}) {
    useMonacoTheme();
    const t = useT();
    const { draft, revs, setValue, setKey, remove, restore, replaceWithFile } = state;
    const monacoRef = useRef<Monaco | null>(null);
    const editorRef = useRef<monacoEditor.editor.IStandaloneCodeEditor | null>(null);
    const modelPaths = useRef(new Set<string>());
    const [dockerMode, setDockerMode] = useState<typeof DOCKER_FORM | typeof DOCKER_RAW>(DOCKER_FORM);

    // Models are kept per key (each with its own undo history) and dropped
    // with the panel. Deferred, so the editor lets go of its model first.
    useEffect(() => () => {
        const paths = modelPaths.current;
        window.setTimeout(() => {
            monacoRef.current?.editor.getModels()
                .filter((m) => paths.has(m.uri.toString()))
                .forEach((m) => m.dispose());
        });
    }, []);

    const problem = entry && !entry.deleted ? keyProblem(entry.key, draft, entry.id) : null;
    const parse = entry && !entry.binary && !entry.deleted ? parseProblem(entry.key, entry.value) : null;

    // The parse problem as an editor marker, so the line is underlined too.
    const markParse = () => {
        const monaco = monacoRef.current;
        const model = editorRef.current?.getModel();
        if (!monaco || !model) return;
        const line = parse ? Math.min(parse.line, model.getLineCount()) : 1;
        monaco.editor.setModelMarkers(model, 'data-editor', parse ? [{
            severity: monaco.MarkerSeverity.Error,
            message: parse.message,
            startLineNumber: line, startColumn: parse.column,
            endLineNumber: line, endColumn: model.getLineMaxColumn(line),
        }] : []);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(markParse, [parse?.line, parse?.column, parse?.message, entry?.id]);

    const isSecret = kind === 'Secret';
    const dockerRegs = useMemo(
        () => (entry && isSecret && secretType === DOCKER_TYPE && entry.key === '.dockerconfigjson' && !entry.binary ? parseDockerConfig(entry.value) : null),
        // Parsed once per key and external change: the form owns the rows while it is shown.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [entry?.id, entry && revs[entry.id], secretType],
    );
    const tlsPair = isSecret && secretType === TLS_TYPE && entry && (entry.key === 'tls.crt' || entry.key === 'tls.key')
        ? {
            cert: draft.find((e) => e.key === 'tls.crt' && !e.deleted && !e.binary)?.value ?? '',
            keyPem: draft.find((e) => e.key === 'tls.key' && !e.deleted && !e.binary)?.value ?? '',
        }
        : null;

    if (!entry) {
        return <div className="de-value de-value--empty"><p className="dlg-note">{t('panels:dataEditor.selectKey')}</p></div>;
    }

    const size = byteSize(entry);
    const valueB64 = () => (entry.binary ? entry.value : textToBase64(entry.value));
    const showDockerForm = dockerRegs !== null && dockerMode === DOCKER_FORM;
    // A Secret value stays hidden until asked for — except in the registry
    // form, which hides its passwords itself.
    const hidden = isSecret && !revealed && !entry.binary && !showDockerForm;

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(entry.value);
            notify('success', t('panels:dataEditor.copied', { key: entry.key }));
        } catch (e) {
            notify('error', t('panels:dataEditor.copyFailed'), errText(e));
        }
    };

    const download = async () => {
        try {
            const path = await SaveDataValue(entry.key || 'value', valueB64());
            if (path) notify('success', t('panels:dataEditor.saved', { path }));
        } catch (e) {
            notify('error', t('panels:dataEditor.saveFailed'), errText(e));
        }
    };

    const replace = async () => {
        const file = await pickFile();
        if (file) replaceWithFile(entry.id, file.bytes);
    };

    const path = `inmemory://model${PLAIN_YAML_PATH}${entry.id}-${revs[entry.id] ?? 0}`;
    modelPaths.current.add(path);

    const handleMount: OnMount = (editor) => {
        editorRef.current = editor;
        markParse();
    };

    let body: React.ReactNode;
    if (entry.deleted) {
        body = (
            <div className="de-card">
                <StatusLamp tone="warn" label={t('panels:dataEditor.willRemove')} />
                <Button label={t('panels:dataEditor.restore')} icon={<VscDiscard size={14} />} outlined size="small" onClick={() => restore(entry.id)} />
            </div>
        );
    } else if (entry.binary) {
        body = (
            <div className="de-card">
                <p className="de-card__title">{t('panels:dataEditor.binaryValue', { size: formatBytes(size) })}</p>
                <p className="dlg-note">{t('panels:dataEditor.binaryHint')}</p>
                <div className="dlg-actions">
                    <Button label={t('panels:dataEditor.download')} icon={<VscCloudDownload size={14} />} outlined size="small" onClick={download} />
                    <Button label={t('panels:dataEditor.replaceFromFile')} icon={<VscCloudUpload size={14} />} outlined size="small" onClick={replace} disabled={readOnly} />
                </div>
            </div>
        );
    } else if (showDockerForm) {
        body = <DockerConfigForm key={`${entry.id}-${revs[entry.id] ?? 0}`} initial={dockerRegs} readOnly={readOnly} onChange={(json) => setValue(entry.id, json, true)} />;
    } else if (hidden) {
        body = (
            <div className="de-card">
                <p className="de-card__title">{t('panels:dataEditor.hiddenValue', { size: formatBytes(size) })}</p>
                <div className="dlg-actions">
                    <Button label={t('panels:dataEditor.show')} icon={<VscEye size={14} />} outlined size="small" onClick={() => setRevealed(true)} />
                    <Button label={t('panels:dataEditor.copy')} icon={<VscCopy size={14} />} text size="small" onClick={copy} />
                </div>
            </div>
        );
    } else {
        body = (
            <div className="de-editor dark-display">
                <Editor
                    // A model per key and external change: switching keys keeps
                    // each key's undo history, and a file or form change starts fresh.
                    path={path}
                    defaultValue={entry.value}
                    language={languageFor(entry.key)}
                    theme={MONACO_THEME}
                    beforeMount={(m) => { monacoRef.current = m; defineMonacoTheme(m); }}
                    onMount={handleMount}
                    onChange={(v) => setValue(entry.id, v ?? '', true)}
                    options={{ ...EDITOR_OPTIONS, readOnly }}
                />
            </div>
        );
    }

    return (
        <div className="de-value">
            <div className="de-value__head">
                <label className="de-value__key">
                    <span className="sr-only">{t('panels:dataEditor.keyName')}</span>
                    <InputText
                        value={entry.key}
                        onChange={(e) => setKey(entry.id, e.target.value)}
                        placeholder={t('panels:dataEditor.keyPlaceholder')}
                        disabled={readOnly || entry.deleted}
                        invalid={problem !== null}
                        className="cell-mono"
                    />
                </label>
                <span className="de-value__meta">{entry.binary ? t('panels:dataEditor.binary') : languageFor(entry.key)} · {formatBytes(size)}</span>
                <div className="de-value__actions">
                    {dockerRegs !== null && (
                        <Segmented
                            value={dockerMode}
                            ariaLabel={t('panels:dataEditor.docker.mode')}
                            options={[{ value: DOCKER_FORM, label: t('panels:dataEditor.docker.form') }, { value: DOCKER_RAW, label: t('panels:dataEditor.docker.raw') }]}
                            onChange={setDockerMode}
                        />
                    )}
                    {isSecret && !entry.binary && !entry.deleted && !showDockerForm && (
                        <RowAction icon={revealed ? <VscEyeClosed size={15} /> : <VscEye size={15} />}
                            label={t(revealed ? 'panels:dataEditor.hide' : 'panels:dataEditor.show')} onClick={() => setRevealed(!revealed)} />
                    )}
                    {!entry.binary && <RowAction icon={<VscCopy size={15} />} label={t('panels:dataEditor.copy')} onClick={copy} disabled={entry.deleted} />}
                    <RowAction icon={<VscCloudUpload size={15} />} label={t('panels:dataEditor.replaceFromFile')} onClick={replace} disabled={readOnly || entry.deleted} />
                    <RowAction icon={<VscCloudDownload size={15} />} label={t('panels:dataEditor.download')} onClick={download} disabled={entry.deleted} />
                    {entry.deleted
                        ? <RowAction icon={<VscDiscard size={15} />} label={t('panels:dataEditor.restore')} onClick={() => restore(entry.id)} />
                        : <RowAction icon={<VscTrash size={15} />} label={t('panels:dataEditor.remove')} severity="danger" onClick={() => remove(entry.id)} disabled={readOnly} />}
                </div>
            </div>
            {problem && <p className="de-value__problem dlg-error">{t(`panels:dataEditor.problem.${problem}`)}</p>}
            {tlsPair && <TlsSummary cert={tlsPair.cert} keyPem={tlsPair.keyPem} />}
            {parse && (
                <p className="de-value__problem dlg-error">{t('panels:dataEditor.parseError', { line: parse.line, message: parse.message })}</p>
            )}
            {body}
        </div>
    );
}
