import { IDockviewPanelProps } from 'dockview';
import DataEditor from '../shared/dataEditor/DataEditor';

interface SecretEditorPanelParams {
    clusterName: string;
    name: string;
    namespace: string;
}

export default function SecretEditorPanel({ params, api }: IDockviewPanelProps<SecretEditorPanelParams>) {
    return <DataEditor kind="Secret" clusterName={params.clusterName ?? ''} namespace={params.namespace} name={params.name} api={api} />;
}
