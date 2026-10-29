import { create } from 'zustand';
import { GetToolboxStatus } from '../../wailsjs/go/controller_app/App';
import { models } from '../../wailsjs/go/models';
import { errText } from '../lib/errText';

// Whether toolbox is usable on each cluster, shared by every "History" entry
// point so a screen full of them costs one check. Kept for STATUS_TTL_MS (the
// backend's endpoint cache lives as long), in memory only.

const STATUS_TTL_MS = 60_000;

interface Entry {
    status: models.ToolboxStatus;
    fetchedAt: number;
}

interface ToolboxStatusStore {
    byCluster: Record<string, Entry>;
    /** Fetches the cluster's status unless a fresh one is cached or on its way. */
    ensure: (clusterName: string) => void;
}

const inFlight = new Set<string>();

export const useToolboxStatusStore = create<ToolboxStatusStore>((set, get) => ({
    byCluster: {},
    ensure: (clusterName) => {
        const cached = get().byCluster[clusterName];
        if (!clusterName || inFlight.has(clusterName) || (cached && Date.now() - cached.fetchedAt < STATUS_TTL_MS)) return;
        inFlight.add(clusterName);
        // Deferred so a binding that throws synchronously (no backend yet)
        // still lands in catch and releases the in-flight mark.
        Promise.resolve()
            .then(() => GetToolboxStatus(clusterName))
            .catch((e) => models.ToolboxStatus.createFrom({ state: 'unreachable', detail: errText(e) }))
            .then((status) => set((s) => ({ byCluster: { ...s.byCluster, [clusterName]: { status, fetchedAt: Date.now() } } })))
            .finally(() => inFlight.delete(clusterName));
    },
}));

/** The cluster's toolbox status, or null while the first check runs. */
export function useToolboxStatus(clusterName: string): models.ToolboxStatus | null {
    return useToolboxStatusStore((s) => s.byCluster[clusterName]?.status ?? null);
}
