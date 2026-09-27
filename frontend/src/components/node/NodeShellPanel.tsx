import { useCallback } from 'react';
import { IDockviewPanelProps } from 'dockview';
import { CreateNodeShellSession, CloseNodeShellSession } from '../../../wailsjs/go/controller_app/App';
import ExecTerminal from '../terminal/ExecTerminal';

export interface NodeShellPanelParams {
    clusterName: string;
    sessionId: string;
    nodeName: string;
}

/**
 * A root shell on a node.
 *
 * Kubernetes has no node-exec API, so the backend creates a privileged helper
 * pod pinned to the node and execs nsenter into PID 1's namespaces. That takes
 * seconds to tens of seconds, so `connect` stays pending while the backend
 * narrates the wait through the same `exec:output:${id}` channel the shell
 * itself uses — the progress lines land in this terminal.
 */
export default function NodeShellPanel({ params }: IDockviewPanelProps<NodeShellPanelParams>) {
    const { clusterName, sessionId, nodeName } = params;
    const cn = clusterName ?? '';

    const connect = useCallback(
        () => CreateNodeShellSession(cn, sessionId, nodeName),
        [cn, sessionId, nodeName],
    );
    const close = useCallback(() => CloseNodeShellSession(sessionId), [sessionId]);

    return (
        <ExecTerminal
            sessionId={sessionId}
            banner={`Opening a host shell on node ${nodeName}...`}
            connect={connect}
            close={close}
            saveName={`node-shell-${nodeName}`}
        />
    );
}
