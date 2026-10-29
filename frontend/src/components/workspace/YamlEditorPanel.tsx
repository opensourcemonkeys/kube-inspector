import { useEffect, useRef, useState } from 'react';
import { IDockviewPanelProps } from 'dockview';
import Editor, { OnMount } from '@monaco-editor/react';
// Configures @monaco-editor/react to use the bundled Monaco. Side-effect
// import: this panel is lazily loaded, so Monaco arrives with it.
import '../../lib/monacoBootstrap';


import { VscNote, VscDiscard, VscCheck } from 'react-icons/vsc';
import * as monacoEditor from 'monaco-editor';
import { MONACO_BASE_OPTIONS, MONACO_THEME, defineMonacoTheme, useMonacoTheme } from '../../lib/monacoTheme';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { ensureK8sYamlIntellisense, k8sYamlSuggestOptions } from '../../lib/k8sYamlIntellisense';
import PanelLoading from '../shared/PanelLoading';
import HistoryButton from '../toolbox/history/HistoryButton';
import { useT } from '../../i18n/useT';
import {
    GetPodYaml,
    GetDeploymentYaml, UpdateDeploymentYaml,
    GetStatefulSetYaml, UpdateStatefulSetYaml,
    GetReplicaSetYaml, UpdateReplicaSetYaml,
    GetDaemonSetYaml, UpdateDaemonSetYaml,
    GetJobYaml, UpdateJobYaml,
    GetCronJobYaml, UpdateCronJobYaml,
    GetConfigMapYaml, UpdateConfigMapYaml,
    GetSecretYaml, UpdateSecretYaml,
    GetNodeYaml, UpdateNodeYaml,
    GetNamespaceYaml,
    GetResourceQuotaYaml, UpdateResourceQuotaYaml,
    GetServiceYaml, UpdateServiceYaml,
    GetIngressYaml, UpdateIngressYaml,
    GetIngressClassYaml, UpdateIngressClassYaml,
    GetEndpointYaml, UpdateEndpointYaml,
    GetLimitRangeYaml, UpdateLimitRangeYaml,
    GetPersistentVolumeYaml, UpdatePersistentVolumeYaml,
    GetPersistentVolumeClaimYaml, UpdatePersistentVolumeClaimYaml,
    GetStorageClassYaml, UpdateStorageClassYaml,
    GetServiceAccountYaml, UpdateServiceAccountYaml,
    GetRoleYaml, UpdateRoleYaml,
    GetRoleBindingYaml, UpdateRoleBindingYaml,
} from '../../../wailsjs/go/controller_app/App';

interface YamlEditorPanelParams {
    clusterName: string;
    resourceKind: 'pod' | 'deployment' | 'statefulset' | 'replicaset' | 'daemonset' | 'job' | 'cronjob' | 'service' | 'ingress' | 'ingressclass' | 'endpoint' | 'configmap' | 'secret' | 'node' | 'namespace' | 'resourcequota' | 'limitrange' | 'persistentvolume' | 'persistentvolumeclaim' | 'storageclass' | 'serviceaccount' | 'role' | 'rolebinding';
    name: string;
    namespace: string;
}

// `job` is editable even though most of its spec is immutable: the API server
// rejects an immutable change with a precise message, which the toast now shows
// — that is more honest than a read-only editor that gives no reason (S9d).
const editable = (kind: string) => [
    'deployment', 'statefulset', 'replicaset', 'daemonset', 'job', 'cronjob',
    'service', 'ingress', 'ingressclass', 'endpoint', 'configmap', 'secret',
    'node', 'resourcequota', 'limitrange', 'persistentvolume',
    'persistentvolumeclaim', 'storageclass', 'serviceaccount', 'role', 'rolebinding',
].includes(kind);

// Each kind's resource and API group as toolbox records them, for History.
const HISTORY_RESOURCE: Record<YamlEditorPanelParams['resourceKind'], [resource: string, group: string]> = {
    pod: ['pods', 'core'], deployment: ['deployments', 'apps'], statefulset: ['statefulsets', 'apps'],
    replicaset: ['replicasets', 'apps'], daemonset: ['daemonsets', 'apps'], job: ['jobs', 'batch'],
    cronjob: ['cronjobs', 'batch'], service: ['services', 'core'], ingress: ['ingresses', 'networking.k8s.io'],
    ingressclass: ['ingressclasses', 'networking.k8s.io'], endpoint: ['endpoints', 'core'], configmap: ['configmaps', 'core'],
    secret: ['secrets', 'core'], node: ['nodes', 'core'], namespace: ['namespaces', 'core'],
    resourcequota: ['resourcequotas', 'core'], limitrange: ['limitranges', 'core'],
    persistentvolume: ['persistentvolumes', 'core'], persistentvolumeclaim: ['persistentvolumeclaims', 'core'],
    storageclass: ['storageclasses', 'storage.k8s.io'], serviceaccount: ['serviceaccounts', 'core'],
    role: ['roles', 'rbac.authorization.k8s.io'], rolebinding: ['rolebindings', 'rbac.authorization.k8s.io'],
};

export default function YamlEditorPanel({ params, api }: IDockviewPanelProps<YamlEditorPanelParams>) {
    useMonacoTheme();
    const t = useT();
    const { clusterName, resourceKind, name, namespace } = params;
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
                let result = '';
                if (resourceKind === 'pod') {
                    result = await GetPodYaml(clusterName, name, namespace);
                } else if (resourceKind === 'deployment') {
                    result = await GetDeploymentYaml(clusterName, name, namespace);
                } else if (resourceKind === 'statefulset') {
                    result = await GetStatefulSetYaml(clusterName, name, namespace);
                } else if (resourceKind === 'replicaset') {
                    result = await GetReplicaSetYaml(clusterName, name, namespace);
                } else if (resourceKind === 'daemonset') {
                    result = await GetDaemonSetYaml(clusterName, name, namespace);
                } else if (resourceKind === 'job') {
                    result = await GetJobYaml(clusterName, name, namespace);
                } else if (resourceKind === 'cronjob') {
                    result = await GetCronJobYaml(clusterName, name, namespace);
                } else if (resourceKind === 'configmap') {
                    result = await GetConfigMapYaml(clusterName, name, namespace);
                } else if (resourceKind === 'secret') {
                    result = await GetSecretYaml(clusterName, name, namespace);
                } else if (resourceKind === 'node') {
                    result = await GetNodeYaml(clusterName, name);
                } else if (resourceKind === 'namespace') {
                    result = await GetNamespaceYaml(clusterName, name);
                } else if (resourceKind === 'resourcequota') {
                    result = await GetResourceQuotaYaml(clusterName, name, namespace);
                } else if (resourceKind === 'service') {
                    result = await GetServiceYaml(clusterName, name, namespace);
                } else if (resourceKind === 'ingress') {
                    result = await GetIngressYaml(clusterName, name, namespace);
                } else if (resourceKind === 'ingressclass') {
                    result = await GetIngressClassYaml(clusterName, name);
                } else if (resourceKind === 'endpoint') {
                    result = await GetEndpointYaml(clusterName, name, namespace);
                } else if (resourceKind === 'limitrange') {
                    result = await GetLimitRangeYaml(clusterName, name, namespace);
                } else if (resourceKind === 'persistentvolume') {
                    result = await GetPersistentVolumeYaml(clusterName, name);
                } else if (resourceKind === 'persistentvolumeclaim') {
                    result = await GetPersistentVolumeClaimYaml(clusterName, name, namespace);
                } else if (resourceKind === 'storageclass') {
                    result = await GetStorageClassYaml(clusterName, name);
                } else if (resourceKind === 'serviceaccount') {
                    result = await GetServiceAccountYaml(clusterName, name, namespace);
                } else if (resourceKind === 'role') {
                    result = await GetRoleYaml(clusterName, name, namespace);
                } else if (resourceKind === 'rolebinding') {
                    result = await GetRoleBindingYaml(clusterName, name, namespace);
                }
                const content = result || 'No YAML available';
                setYaml(content);
                setOriginalYaml(content);
            } catch {
                setYaml('Failed to load YAML.');
            }
        };
        fetch();
    }, [resourceKind, name, namespace]);

    const handleMount: OnMount = (editor) => {
        editorRef.current = editor;
        requestAnimationFrame(() => editor.layout());
        ensureK8sYamlIntellisense();
    };

    const handleChange = (value: string | undefined) => {
        setDirty((value ?? '') !== originalYaml);
    };

    const handleSave = async () => {
        const value = editorRef.current?.getValue() ?? yaml ?? '';
        setSaving(true);
        try {
            if (resourceKind === 'deployment') {
                await UpdateDeploymentYaml(clusterName, name, namespace, value);
            } else if (resourceKind === 'statefulset') {
                await UpdateStatefulSetYaml(clusterName, name, namespace, value);
            } else if (resourceKind === 'replicaset') {
                await UpdateReplicaSetYaml(clusterName, name, namespace, value);
            } else if (resourceKind === 'daemonset') {
                await UpdateDaemonSetYaml(clusterName, name, namespace, value);
            } else if (resourceKind === 'job') {
                await UpdateJobYaml(clusterName, name, namespace, value);
            } else if (resourceKind === 'cronjob') {
                await UpdateCronJobYaml(clusterName, name, namespace, value);
            } else if (resourceKind === 'configmap') {
                await UpdateConfigMapYaml(clusterName, name, namespace, value);
            } else if (resourceKind === 'secret') {
                await UpdateSecretYaml(clusterName, name, namespace, value);
            } else if (resourceKind === 'node') {
                await UpdateNodeYaml(clusterName, name, value);
            } else if (resourceKind === 'resourcequota') {
                await UpdateResourceQuotaYaml(clusterName, name, namespace, value);
            } else if (resourceKind === 'service') {
                await UpdateServiceYaml(clusterName, name, namespace, value);
            } else if (resourceKind === 'ingress') {
                await UpdateIngressYaml(clusterName, name, namespace, value);
            } else if (resourceKind === 'ingressclass') {
                await UpdateIngressClassYaml(clusterName, name, value);
            } else if (resourceKind === 'endpoint') {
                await UpdateEndpointYaml(clusterName, name, namespace, value);
            } else if (resourceKind === 'limitrange') {
                await UpdateLimitRangeYaml(clusterName, name, namespace, value);
            } else if (resourceKind === 'persistentvolume') {
                await UpdatePersistentVolumeYaml(clusterName, name, value);
            } else if (resourceKind === 'persistentvolumeclaim') {
                await UpdatePersistentVolumeClaimYaml(clusterName, name, namespace, value);
            } else if (resourceKind === 'storageclass') {
                await UpdateStorageClassYaml(clusterName, name, value);
            } else if (resourceKind === 'serviceaccount') {
                await UpdateServiceAccountYaml(clusterName, name, namespace, value);
            } else if (resourceKind === 'role') {
                await UpdateRoleYaml(clusterName, name, namespace, value);
            } else if (resourceKind === 'rolebinding') {
                await UpdateRoleBindingYaml(clusterName, name, namespace, value);
            }
            setOriginalYaml(value);
            setYaml(value);
            setDirty(false);
            toast.current?.show({
                severity: 'success',
                summary: 'Updated',
                detail: `${namespace}/${name} updated`,
                life: 2500,
            });
        } catch {
            toast.current?.show({
                severity: 'error',
                summary: 'Update failed',
                detail: `${namespace}/${name} could not be updated`,
                life: 3500,
            });
        } finally {
            setSaving(false);
        }
    };

    const handleRevert = () => {
        editorRef.current?.setValue(originalYaml);
        setDirty(false);
    };

    return (
        <div className="yaml-editor-panel flex flex-column h-full">
            <Toast ref={toast} position="bottom-right" />

            <div className="yaml-editor-toolbar flex align-items-center justify-content-between">
                <span className="yaml-editor-toolbar__label flex align-items-center gap-1">
                    <VscNote size={14} />
                    {namespace}/{name}
                </span>
                <div className="flex align-items-center gap-1 flex-shrink-0">
                    {HISTORY_RESOURCE[resourceKind] && (
                        <HistoryButton def={{
                            clusterName, resource: HISTORY_RESOURCE[resourceKind][0], group: HISTORY_RESOURCE[resourceKind][1],
                            name, namespace, referencePanel: api.id,
                        }} />
                    )}
                    {editable(resourceKind) && (
                        <>
                            <Button
                                label={t('panels:yaml.revert')}
                                icon={<VscDiscard size={16} />}
                                text
                                size="small"
                                disabled={!dirty || saving}
                                onClick={handleRevert}
                            />
                            <Button
                                label={t('panels:yaml.save')}
                                icon={<VscCheck size={16} />}
                                size="small"
                                loading={saving}
                                disabled={!dirty}
                                onClick={handleSave}
                            />
                        </>
                    )}
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
                        ...k8sYamlSuggestOptions,
                        readOnly: !editable(resourceKind),
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
