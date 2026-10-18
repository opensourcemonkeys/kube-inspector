import { useRef, useState } from 'react';
import { IDockviewPanelProps } from 'dockview';
import Editor, { OnMount } from '@monaco-editor/react';
// Configures @monaco-editor/react to use the bundled Monaco. Side-effect
// import: this panel is lazily loaded, so Monaco arrives with it.
import '../../lib/monacoBootstrap';
import { Button } from 'primereact/button';
import { Dropdown } from 'primereact/dropdown';
import { VscCloudUpload, VscTrash, VscOutput, VscClose } from 'react-icons/vsc';
import { Toast } from 'primereact/toast';
import type * as monaco from 'monaco-editor';
import { ApplyYaml } from '../../../wailsjs/go/controller_app/App';
import { MONACO_BASE_OPTIONS, MONACO_THEME, defineMonacoTheme, useMonacoTheme } from '../../lib/monacoTheme';
import { ensureK8sYamlIntellisense, k8sYamlSuggestOptions } from '../../lib/k8sYamlIntellisense';
import { useClusterContext } from '../../contexts/ClusterContext';
import { renderPanelTitle } from '../../contexts/TabContext';
import { useT } from '../../i18n/useT';
import RowAction from '../shared/RowAction';
import StatusLamp from '../shared/StatusLamp';

interface ApplyYamlPanelParams {
    clusterName?: string;
    titleKey?: string;
    titleVars?: Record<string, string | number | undefined>;
}

export default function ApplyYamlPanel({ api, params }: IDockviewPanelProps<ApplyYamlPanelParams>) {
    useMonacoTheme();
    const t = useT();
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const toast = useRef<Toast | null>(null);
    const [applying, setApplying] = useState(false);
    const [output, setOutput] = useState('');
    // The output is a result, so it is read in the result's tone: kubectl's
    // "configured" lines are not a warning.
    const [outputFailed, setOutputFailed] = useState(false);
    const [outputHeight, setOutputHeight] = useState(200);

    const { clusters, activeCluster } = useClusterContext();
    // This panel writes, so unlike the read-only views it is retargetable: the
    // seeded cluster is only a default, and the choice is mirrored back into
    // params so a panel moved to another window keeps its target.
    const [cluster, setCluster] = useState(params.clusterName || activeCluster || '');

    const handleClusterChange = (next: string) => {
        setCluster(next);
        // See TerminalPanel: retitle from the key so the tab survives a
        // language switch instead of freezing at the English string.
        const titleVars = { ...(params.titleVars ?? {}), suffix: next || undefined };
        api.updateParameters({ clusterName: next, titleVars });
        api.setTitle(renderPanelTitle(t, { titleKey: params.titleKey, titleVars }));
    };

    const handleMount: OnMount = (editor) => {
        editorRef.current = editor;
        // Expose the most-recently-mounted editor for E2E tests.
        // window.__kubeInsYamlEditor is overwritten each time a new panel opens,
        // so it always refers to the newest ApplyYamlPanel instance.
        (window as unknown as Record<string, unknown>).__kubeInsYamlEditor = editor;
        requestAnimationFrame(() => editor.layout());
        ensureK8sYamlIntellisense();
    };

    const handleApply = async () => {
        const yaml = editorRef.current?.getValue() ?? '';
        if (!yaml.trim()) {
            toast.current?.show({
                severity: 'warn',
                summary: t('panels:applyYaml.emptyTitle'),
                detail: t('panels:applyYaml.emptyDetail'),
                life: 2500,
            });
            return;
        }

        if (!cluster) {
            toast.current?.show({
                severity: 'warn',
                summary: t('panels:applyYaml.noClusterTitle'),
                detail: t('panels:applyYaml.noClusterDetail'),
                life: 2500,
            });
            return;
        }

        setApplying(true);
        setOutput('');
        try {
            const result = await ApplyYaml(cluster, yaml);
            setOutput(result);
            setOutputFailed(false);
            toast.current?.show({
                severity: 'success',
                summary: t('panels:applyYaml.applied'),
                detail: t('panels:applyYaml.appliedDetail', { cluster }),
                life: 2500,
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setOutput(msg);
            setOutputFailed(true);
            toast.current?.show({
                severity: 'error',
                summary: t('panels:applyYaml.failed'),
                detail: msg,
                life: 4000,
            });
        } finally {
            setApplying(false);
        }
    };

    const handleClear = () => {
        editorRef.current?.setValue('');
        setOutput('');
    };

    const handleResizeMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        const startY = e.clientY;
        const startHeight = outputHeight;

        const onMouseMove = (me: MouseEvent) => {
            const delta = startY - me.clientY;
            const containerH = containerRef.current?.clientHeight ?? 800;
            const next = Math.max(60, Math.min(startHeight + delta, containerH - 80));
            setOutputHeight(next);
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    };

    return (
        <div className="yaml-editor-panel flex flex-column h-full">
            <Toast ref={toast} position="bottom-right" />

            <div className="panel-toolbar">
                <span className="panel-toolbar__label">
                    <VscCloudUpload size={14} aria-hidden />
                    {t('panels:applyYaml.label')}
                </span>
                <div className="panel-toolbar__actions">
                    <Dropdown
                        value={cluster || null}
                        options={clusters}
                        onChange={(e) => handleClusterChange(e.value ?? '')}
                        placeholder={t('panels:applyYaml.selectCluster')}
                        disabled={applying}
                        className="yaml-editor-toolbar__cluster apply-yaml__cluster"
                        aria-label={t('panels:applyYaml.clusterAria')}
                    />
                    <Button
                        label={t('panels:applyYaml.clear')}
                        icon={<VscTrash size={16} />}
                        text
                        size="small"
                        severity="secondary"
                        disabled={applying}
                        onClick={handleClear}
                    />
                    <Button
                        label={t('panels:applyYaml.apply')}
                        icon={<VscOutput size={16} />}
                        size="small"
                        loading={applying}
                        onClick={handleApply}
                    />
                </div>
            </div>

            <div ref={containerRef} className="flex flex-column flex-1 overflow-hidden min-h-0">
                <div className="apply-yaml__editor">
                    <Editor
                        height="100%"
                        defaultLanguage="yaml"
                        language="yaml"
                        defaultValue=""
                        theme={MONACO_THEME}
                        beforeMount={defineMonacoTheme}
                        onMount={handleMount}
                        options={{
                            ...MONACO_BASE_OPTIONS,
                            ...k8sYamlSuggestOptions,
                            minimap: { enabled: false },
                            scrollBeyondLastLine: false,
                            wordWrap: 'on',
                            automaticLayout: true,
                            lineNumbers: 'on',
                            folding: true,
                        }}
                    />
                </div>

                {output && (
                    <>
                        <div
                            className="graph-divider"
                            role="separator"
                            aria-orientation="horizontal"
                            aria-label={t('panels:applyYaml.resizeOutput')}
                            onMouseDown={handleResizeMouseDown}
                        >
                            <span className="graph-divider__grip" />
                        </div>

                        <div className="apply-yaml__output" style={{ height: outputHeight }}>
                            <div className="panel-toolbar apply-yaml__output-bar">
                                <span className="panel-toolbar__label">
                                    <StatusLamp
                                        label={t('panels:applyYaml.output')}
                                        tone={outputFailed ? 'err' : 'ok'}
                                    />
                                </span>
                                <RowAction icon={<VscClose size={14} />} label={t('panels:applyYaml.closeOutput')} onClick={() => setOutput('')} />
                            </div>
                            <pre className={`apply-yaml__text dark-display${outputFailed ? ' apply-yaml__text--err' : ''}`}>{output}</pre>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
