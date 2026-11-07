import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ClusterProvider, useClusterContext } from './ClusterContext';

const listClusters = vi.fn();
const setActiveCluster = vi.fn();
const getActiveCluster = vi.fn();
const checkConnection = vi.fn();
vi.mock('../../wailsjs/go/controller_app/App', () => ({
    ListClusters: (...a: unknown[]) => listClusters(...a),
    SetActiveCluster: (...a: unknown[]) => setActiveCluster(...a),
    GetActiveCluster: (...a: unknown[]) => getActiveCluster(...a),
    CheckClusterConnection: (...a: unknown[]) => checkConnection(...a),
}));

// restoreMocks does not clear a vi.fn()'s call history, so a selection made in
// one test would count against the next one's "never selected".
beforeEach(() => {
    vi.clearAllMocks();
});

function Probe() {
    const { activeCluster, loaded } = useClusterContext();
    return <div data-testid="state">{loaded ? `loaded:${activeCluster}` : 'loading'}</div>;
}

async function start(clusters: string[], persisted: string) {
    listClusters.mockResolvedValue(clusters);
    getActiveCluster.mockResolvedValue(persisted);
    setActiveCluster.mockResolvedValue(undefined);
    checkConnection.mockResolvedValue(undefined);
    render(<ClusterProvider><Probe /></ClusterProvider>);
    await waitFor(() => expect(screen.getByTestId('state').textContent).not.toBe('loading'));
    return screen.getByTestId('state').textContent;
}

describe('ClusterProvider start-up selection', () => {
    it('keeps a persisted selection that still exists', async () => {
        expect(await start(['alpha', 'beta'], 'beta')).toBe('loaded:beta');
        expect(setActiveCluster).not.toHaveBeenCalled();
    });

    // Without a selection the start screen never opens (it waits for one, see
    // DockviewContainer), which left an empty workspace behind "Select cluster…".
    it('selects the first cluster when none is selected', async () => {
        expect(await start(['alpha', 'beta'], '')).toBe('loaded:alpha');
        expect(setActiveCluster).toHaveBeenCalledWith('alpha');
    });

    // The backend trusts ~/.kube-ins/.active without checking the file exists,
    // so a deleted cluster comes back as the selection.
    it('selects the first cluster when the persisted one is gone', async () => {
        expect(await start(['alpha', 'beta'], 'deleted')).toBe('loaded:alpha');
        expect(setActiveCluster).toHaveBeenCalledWith('alpha');
    });

    it('selects nothing when there are no clusters (the first-run dialog takes over)', async () => {
        expect(await start([], '')).toBe('loaded:');
        expect(setActiveCluster).not.toHaveBeenCalled();
    });
});
