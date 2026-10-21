import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import DeleteImpactSummary from './DeleteImpactSummary';
import type { ClusterGraph } from './graphLayout';

const getGraph = vi.fn();
vi.mock('../../../wailsjs/go/controller_app/App', () => ({
    GetClusterGraph: (...args: unknown[]) => getGraph(...args),
}));

// svc → pod, owned by rs ← dep; the pod mounts a claim on a Delete-policy volume.
const node = (kind: string, name: string, ns = 'shop', extra = {}) =>
    ({ id: `${kind.toLowerCase()}/${ns}/${name}`, kind, name, namespace: ns, labels: {}, ...extra });
const dep = node('Deployment', 'web');
const rs = node('ReplicaSet', 'web-1');
const pod = node('Pod', 'web-a');
const svc = node('Service', 'web');
const pvc = node('PersistentVolumeClaim', 'data');
const pv = node('PersistentVolume', 'pv-1', '', { details: { reclaimPolicy: 'Delete' } });
const edge = (s: { id: string }, t: { id: string }, kind: string) => ({ id: `${s.id}->${t.id}`, source: s.id, target: t.id, kind });
const graph: ClusterGraph = {
    nodes: [dep, rs, pod, svc, pvc, pv],
    edges: [edge(dep, rs, 'owner'), edge(rs, pod, 'owner'), edge(svc, pod, 'selector'), edge(pod, pvc, 'storage'), edge(pvc, pv, 'storage')],
};

// A block body: vitest runs a function returned from beforeEach as teardown,
// and mockReset returns the mock itself.
beforeEach(() => { getGraph.mockReset(); });

describe('DeleteImpactSummary', () => {
    it('reads the selected rows\' namespaces and lists what else is removed or breaks', async () => {
        getGraph.mockResolvedValue(graph);
        render(<DeleteImpactSummary clusterName="c1" kind="Deployment" targets={[{ name: 'web', namespace: 'shop' }]} />);
        expect(screen.getByText('Working out what else is affected…')).toBeTruthy();
        expect(await screen.findByText('2 · Removed')).toBeTruthy();
        expect(screen.getByText('1 · Breaks now')).toBeTruthy();
        expect(screen.getByText('shop/web-a')).toBeTruthy();
        expect(screen.getByText(/Analysed in shop/)).toBeTruthy();
        expect(getGraph).toHaveBeenCalledWith('c1', ['shop']);
    });

    it('warns about data loss when a claim\'s volume goes with it', async () => {
        getGraph.mockResolvedValue(graph);
        render(<DeleteImpactSummary clusterName="c1" kind="PersistentVolumeClaim" targets={[{ name: 'data', namespace: 'shop' }]} />);
        expect(await screen.findByRole('alert')).toBeTruthy();
    });

    it('reads every namespace for a cluster-scoped kind', async () => {
        getGraph.mockResolvedValue(graph);
        render(<DeleteImpactSummary clusterName="c1" kind="PersistentVolume" targets={[{ name: 'pv-1' }]} />);
        expect(await screen.findByText('Analysed across all namespaces.')).toBeTruthy();
        expect(getGraph).toHaveBeenCalledWith('c1', []);
    });

    it('says so when nothing else is affected', async () => {
        getGraph.mockResolvedValue(graph);
        render(<DeleteImpactSummary clusterName="c1" kind="Service" targets={[{ name: 'web', namespace: 'shop' }]} />);
        expect(await screen.findByText('Nothing else is affected')).toBeTruthy();
    });

    it('falls back to a note when the graph cannot be read', async () => {
        getGraph.mockRejectedValue(new Error('forbidden'));
        render(<DeleteImpactSummary clusterName="c1" kind="Pod" targets={[{ name: 'web-a', namespace: 'shop' }]} />);
        expect(await screen.findByText(/could not be worked out/)).toBeTruthy();
    });
});
