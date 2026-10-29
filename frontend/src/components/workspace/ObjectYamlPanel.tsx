import { useEffect, useRef, useState } from 'react';
import { IDockviewPanelProps } from 'dockview';
import Editor, { OnMount } from '@monaco-editor/react';
// Configures @monaco-editor/react to use the bundled Monaco. Side-effect
// import: this panel is lazily loaded, so Monaco arrives with it.
import '../../lib/monacoBootstrap';
import { VscNote, VscDiscard, VscCheck } from 'react-icons/vsc';
import type * as monacoEditor from 'monaco-editor';
import { MONACO_BASE_OPTIONS, MONACO_THEME, defineMonacoTheme, useMonacoTheme } from '../../lib/monacoTheme';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { GetObjectYaml, UpdateObjectYaml } from '../../../wailsjs/go/controller_app/App';
import { useT } from '../../i18n/useT';
import PanelLoading from '../shared/PanelLoading';
import HistoryButton from '../toolbox/history/HistoryButton';

interface ObjectYamlPanelParams {
    clusterName: string;
    kind: string;
    group: string;
    resource: string;
    name: string;
    namespace: string;
}

// Generic YAML view/edit panel for any Kubernetes object identified by
// (group, resource, namespace, name). Backed by the dynamic-client
// GetObjectYaml / UpdateObjectYaml RPCs.
export default function ObjectYamlPanel({ params, api }: IDockviewPanelProps<ObjectYamlPanelParams>) {
    useMonacoTheme();
    const t = useT();
    const { clusterName, kind, group, resource, name, namespace } = params;
    // Held at null until the document arrives: the editor must be *created*
    // holding the real YAML. @monaco-editor/react applies a later `value`
    // change to a writable editor as executeEdits + pushUndoStop, so seeding
    // the model with a placeholder puts the placeholder->document transition
    // on Monaco's undo stack and Ctrl+Z on an untouched editor wipes the object.
    const [yaml, setYaml] = useState<string | null>(null);
    const [originalYaml, setOriginalYaml] = useState('');
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const editorRef = useRef<monacoEditor.editor.IStandaloneCodeEditor | null>(null);
    const toast = useRef<Toast | null>(null);

    useEffect(() => {
        const fetch = async () => {
            try {
                const result = await GetObjectYaml(clusterName, group ?? '', resource, namespace ?? '', name);
                const content = result || 'No YAML available';
                setYaml(content);
                setOriginalYaml(content);
            } catch (e: any) {
                setYaml('# Failed to load YAML\n# ' + (e?.message ?? String(e)));
            }
        };
        fetch();
    }, [clusterName, group, resource, namespace, name]);

    const handleMount: OnMount = (editor) => {
        editorRef.current = editor;
        requestAnimationFrame(() => editor.layout());
    };

    const handleChange = (value?: string) => setDirty((value ?? '') !== originalYaml);

    const handleSave = async () => {
        const value = editorRef.current?.getValue() ?? yaml ?? '';
        setSaving(true);
        try {
            await UpdateObjectYaml(clusterName, group ?? '', resource, namespace ?? '', name, value);
            setOriginalYaml(value);
            setDirty(false);
            toast.current?.show({ severity: 'success', summary: 'Updated', detail: `${name} updated`, life: 2500 });
        } catch (e: any) {
            toast.current?.show({ severity: 'error', summary: 'Update failed', detail: e?.message ?? String(e), life: 4000 });
        } finally {
            setSaving(false);
        }
    };

    const handleRevert = () => {
        editorRef.current?.setValue(originalYaml);
        setDirty(false);
    };

    const titleLabel = `${namespace ? namespace + '/' : ''}${name}`;

    return (
        <div className="yaml-editor-panel flex flex-column h-full">
            <Toast ref={toast} position="bottom-right" />

            <div className="yaml-editor-toolbar flex align-items-center justify-content-between">
                <span className="yaml-editor-toolbar__label flex align-items-center gap-1">
                    <VscNote size={14} />
                    {kind ? kind + ' · ' : ''}{titleLabel}
                </span>
                <div className="flex align-items-center gap-1 flex-shrink-0">
                    {resource && <HistoryButton def={{ clusterName, resource, group: group || 'core', name, namespace, referencePanel: api.id }} />}
                    <Button label={t('panels:yaml.revert')} icon={<VscDiscard size={16} />} text size="small" disabled={!dirty || saving} onClick={handleRevert} />
                    <Button label={t('panels:yaml.save')} icon={<VscCheck size={16} />} size="small" loading={saving} disabled={!dirty} onClick={handleSave} />
                </div>
            </div>

            <div className="flex-1 overflow-hidden min-h-0">
                {yaml === null ? <PanelLoading /> : <Editor
                    height="100%"
                    defaultLanguage="yaml"
                    language="yaml"
                    value={yaml}
                    theme={MONACO_THEME}
                    beforeMount={defineMonacoTheme}
                    onMount={handleMount}
                    onChange={handleChange}
                    options={{
                        ...MONACO_BASE_OPTIONS,
                        minimap: { enabled: true },
                        scrollBeyondLastLine: false,
                        wordWrap: 'on',
                        automaticLayout: true,
                        lineNumbers: 'on',
                        folding: true,
                        renderLineHighlight: 'all',
                    }}
                />}
            </div>
        </div>
    );
}
