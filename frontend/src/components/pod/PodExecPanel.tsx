import { useCallback } from 'react';
import { IDockviewPanelProps } from 'dockview';
import { CreatePodExecSession, ClosePodExecSession } from '../../../wailsjs/go/controller_app/App';
import ExecTerminal from '../terminal/ExecTerminal';

export interface PodExecPanelParams {
    clusterName: string;
    sessionId: string;
    name: string;
    namespace: string;
    container: string;
}

export default function PodExecPanel({ params }: IDockviewPanelProps<PodExecPanelParams>) {
    const { clusterName, sessionId, name, namespace, container } = params;
    const cn = clusterName ?? '';

    const connect = useCallback(
        () => CreatePodExecSession(cn, sessionId, namespace, name, container),
        [cn, sessionId, namespace, name, container],
    );
    const close = useCallback(() => ClosePodExecSession(sessionId), [sessionId]);

    return (
        <ExecTerminal
            sessionId={sessionId}
            banner={`Connecting to ${namespace}/${name}${container ? ` [${container}]` : ''}...`}
            connect={connect}
            close={close}
            saveName={`exec-${namespace}-${name}`}
        />
    );
}
