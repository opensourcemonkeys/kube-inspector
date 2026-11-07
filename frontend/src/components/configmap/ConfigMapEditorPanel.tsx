import { IDockviewPanelProps } from 'dockview';
import DataEditor from '../shared/dataEditor/DataEditor';

interface ConfigMapEditorPanelParams {
    clusterName: string;
    name: string;
    namespace: string;
}

export default function ConfigMapEditorPanel({ params, api }: IDockviewPanelProps<ConfigMapEditorPanelParams>) {
    return <DataEditor kind="ConfigMap" clusterName={params.clusterName ?? ''} namespace={params.namespace} name={params.name} api={api} />;
}
