import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import {
    ListClusters,
    SetActiveCluster,
    GetActiveCluster,
    CheckClusterConnection,
} from '../../wailsjs/go/controller_app/App';

const CONNECTION_CHECK_INTERVAL_MS = 20_000;

interface ClusterContextValue {
    clusters: string[];
    activeCluster: string;
    loaded: boolean;
    connectionError: string;
    refreshClusters: () => Promise<void>;
    selectCluster: (name: string) => Promise<void>;
}

const ClusterContext = createContext<ClusterContextValue | null>(null);

export function ClusterProvider({ children }: { children: React.ReactNode }) {
    const [clusters, setClusters] = useState<string[]>([]);
    const [activeCluster, setActiveCluster] = useState<string>('');
    const [loaded, setLoaded] = useState(false);
    const [connectionError, setConnectionError] = useState<string>('');
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const refreshClusters = useCallback(async () => {
        const list = await ListClusters();
        setClusters(list ?? []);
    }, []);

    const selectCluster = useCallback(async (name: string) => {
        await SetActiveCluster(name);
        setActiveCluster(name);
        setConnectionError('');
    }, []);

    useEffect(() => {
        const init = async () => {
            const list = (await ListClusters()) ?? [];
            setClusters(list);
            let active = (await GetActiveCluster()) ?? '';
            // Clusters exist but none is selected — no .active yet, or one that
            // names a cluster since deleted (the backend trusts the file) —
            // so start on the first one, as if picked. Otherwise the start
            // screen, which waits for a selection (DockviewContainer), never
            // opens and the workspace sits empty behind "Select cluster…".
            if (list.length > 0 && !list.includes(active)) {
                try {
                    await SetActiveCluster(list[0]);
                    active = list[0];
                } catch (err) {
                    console.error('Could not select a cluster at start-up:', err);
                    active = '';
                }
            }
            setActiveCluster(active);
            setLoaded(true);
        };
        init();
    }, []);

    // Connection health check — periodic ping if active cluster is set
    useEffect(() => {
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }

        if (!activeCluster) {
            setConnectionError('');
            return;
        }

        const check = async () => {
            try {
                await CheckClusterConnection();
                setConnectionError('');
            } catch (err: unknown) {
                setConnectionError(String(err));
            }
        };

        check();
        intervalRef.current = setInterval(check, CONNECTION_CHECK_INTERVAL_MS);
        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current);
        };
    }, [activeCluster]);

    return (
        <ClusterContext.Provider value={{ clusters, activeCluster, loaded, connectionError, refreshClusters, selectCluster }}>
            {children}
        </ClusterContext.Provider>
    );
}

export function useClusterContext() {
    const ctx = useContext(ClusterContext);
    if (!ctx) throw new Error('useClusterContext must be used within ClusterProvider');
    return ctx;
}
