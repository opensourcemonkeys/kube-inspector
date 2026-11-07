import { useState } from 'react';
import { Toast } from 'primereact/toast';
import type { MenuItem } from 'primereact/menuitem';
import { VscArrowBoth, VscDebugRestart, VscDebugPause, VscDebugStart } from 'react-icons/vsc';
import { RestartWorkload, SetCronJobSuspend } from '../../../wailsjs/go/controller_app/App';
import ScaleDialog from './ScaleDialog';
import ConfirmActionDialog from './ConfirmActionDialog';
import { Trans } from 'react-i18next';
import { useT } from '../../i18n/useT';
import { TOAST_LIFE } from '../../lib/toast';

export type ScalableKind = 'deployment' | 'statefulset' | 'replicaset';
export type RestartableKind = 'deployment' | 'statefulset' | 'daemonset';

/**
 * Which mutating actions a given row offers. The capability matrix is not
 * uniform — ReplicaSets have no rollout, DaemonSets have no replica count,
 * CronJobs have neither — so the view decides per row. The backend
 * independently rejects unsupported (kind, action) pairs; this only keeps dead
 * entries off the menu.
 */
export interface WorkloadActionSpec {
    /** Enables Scale for a scalable kind, seeded with its current replica count. */
    scale?: { kind: ScalableKind; replicas: number };
    /** Enables Rollout restart for a kind that has a rollout. */
    restart?: { kind: RestartableKind };
    /** Enables the Pause/Resume toggle for CronJobs. `suspended` picks which way it goes. */
    suspend?: { suspended: boolean };
}

export interface WorkloadActionTarget {
    name: string;
    namespace: string;
}

/**
 * Per-row mutating actions for workload lists (scale / rollout restart /
 * cronjob suspend), as **menu items plus one shared set of dialogs**.
 *
 * It is a hook rather than a per-row component because the actions now live in
 * the row's ⋮ menu: a DataTable body renderer runs for every visible row, so a
 * component that owned its own dialog state mounted one ScaleDialog and two
 * ConfirmActionDialogs per row. Hoisting the state here means one of each for
 * the whole list, with the target row carried in state.
 *
 * `clusterName`, `reload` and `toastRef` come from the list (ResourceListView
 * calls this), so body renderers stay free of closures over list state.
 */
export function useWorkloadActions({
    clusterName,
    reload,
    toastRef,
}: {
    clusterName: string;
    reload: () => Promise<void>;
    toastRef: React.RefObject<Toast>;
}) {
    const t = useT();
    const [scaleT, setScaleT] = useState<(WorkloadActionTarget & { kind: ScalableKind; replicas: number }) | null>(null);
    const [restartT, setRestartT] = useState<(WorkloadActionTarget & { kind: RestartableKind }) | null>(null);
    const [suspendT, setSuspendT] = useState<(WorkloadActionTarget & { suspended: boolean }) | null>(null);

    const notify = (detail: string) =>
        toastRef.current?.show({ severity: 'success', summary: t('panels:workload.doneSummary'), detail, life: TOAST_LIFE.success });

    const target = (r: WorkloadActionTarget) => `${r.namespace}/${r.name}`;

    /** The row's entries for the ⋮ menu, in capability order. */
    const menuItems = (row: WorkloadActionTarget, spec: WorkloadActionSpec | undefined): MenuItem[] => {
        if (!spec) return [];
        const items: MenuItem[] = [];
        if (spec.scale) {
            const { kind, replicas } = spec.scale;
            items.push({
                label: t('panels:workload.scale'),
                icon: <VscArrowBoth size={13} />,
                command: () => setScaleT({ name: row.name, namespace: row.namespace, kind, replicas }),
            });
        }
        if (spec.restart) {
            const { kind } = spec.restart;
            items.push({
                label: t('panels:workload.restart'),
                icon: <VscDebugRestart size={13} />,
                command: () => setRestartT({ name: row.name, namespace: row.namespace, kind }),
            });
        }
        if (spec.suspend) {
            const { suspended } = spec.suspend;
            items.push({
                label: t(suspended ? 'panels:workload.resume' : 'panels:workload.suspend'),
                icon: suspended ? <VscDebugStart size={13} /> : <VscDebugPause size={13} />,
                command: () => setSuspendT({ name: row.name, namespace: row.namespace, suspended }),
            });
        }
        return items;
    };

    // Rendered once by the list, not once per row. Each dialog is mounted only
    // while it has a target so it always opens with that row's seed values
    // (ScaleDialog reads `currentReplicas` into state).
    const dialogs = (
        <>
            {scaleT && (
                <ScaleDialog
                    visible
                    clusterName={clusterName}
                    kind={scaleT.kind}
                    name={scaleT.name}
                    namespace={scaleT.namespace}
                    currentReplicas={scaleT.replicas}
                    onHide={() => setScaleT(null)}
                    onDone={async (replicas) => {
                        notify(t('panels:workload.scaled', { target: target(scaleT), replicas }));
                        await reload();
                    }}
                />
            )}

            {restartT && (
                <ConfirmActionDialog
                    visible
                    header={t('panels:workload.restartHeader')}
                    message={
                        <Trans
                            t={t}
                            i18nKey="panels:workload.restartMessage"
                            values={{ target: target(restartT) }}
                            components={{ 1: <strong /> }}
                        />
                    }
                    warning={t('panels:workload.restartWarning')}
                    confirmLabel={t('panels:workload.restartConfirm')}
                    onHide={() => setRestartT(null)}
                    onConfirm={async () => {
                        await RestartWorkload(clusterName, restartT.kind, restartT.name, restartT.namespace);
                        notify(t('panels:workload.restarted', { target: target(restartT) }));
                        await reload();
                    }}
                />
            )}

            {suspendT && (
                <ConfirmActionDialog
                    visible
                    header={t(suspendT.suspended ? 'panels:workload.resumeHeader' : 'panels:workload.suspendHeader')}
                    message={
                        <Trans
                            t={t}
                            i18nKey={suspendT.suspended ? 'panels:workload.resumeMessage' : 'panels:workload.suspendMessage'}
                            values={{ target: target(suspendT) }}
                            components={{ 1: <strong /> }}
                        />
                    }
                    warning={suspendT.suspended ? undefined : t('panels:workload.suspendWarning')}
                    confirmLabel={t(suspendT.suspended ? 'panels:workload.resume' : 'panels:workload.suspend')}
                    onHide={() => setSuspendT(null)}
                    onConfirm={async () => {
                        await SetCronJobSuspend(clusterName, suspendT.name, suspendT.namespace, !suspendT.suspended);
                        notify(t(suspendT.suspended ? 'panels:workload.resumed' : 'panels:workload.suspended', { target: target(suspendT) }));
                        await reload();
                    }}
                />
            )}
        </>
    );

    return { menuItems, dialogs };
}
