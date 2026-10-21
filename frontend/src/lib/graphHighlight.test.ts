import { describe, it, expect } from 'vitest';
import { chainOf } from './graphHighlight';

// ing → svc → pod1 ← rs ← dep, plus svc2 → pod1 (a second Service on the
// same Pod) and an unrelated dep2 → rs2 → pod2.
const e = (source: string, target: string) => ({ id: `${source}->${target}`, source, target });
const edges = [
    e('ing', 'svc'), e('svc', 'pod1'), e('svc2', 'pod1'),
    e('dep', 'rs'), e('rs', 'pod1'),
    e('dep2', 'rs2'), e('rs2', 'pod2'),
];
const sorted = (s: Set<string>) => [...s].sort();

describe('chainOf', () => {
    it('related: a Deployment brings in the Services and Ingress that route to its Pods', () => {
        expect(sorted(chainOf(edges, 'dep', 'related').nodes))
            .toEqual(['dep', 'ing', 'pod1', 'rs', 'svc', 'svc2']);
    });

    it('related: a Pod brings in its owners and every Service in front of it', () => {
        expect(sorted(chainOf(edges, 'pod1', 'related').nodes))
            .toEqual(['dep', 'ing', 'pod1', 'rs', 'svc', 'svc2']);
    });

    it('related: never crosses into an unrelated workload', () => {
        const chain = chainOf(edges, 'svc', 'related');
        expect(chain.nodes.has('pod2')).toBe(false);
        expect(chain.nodes.has('dep2')).toBe(false);
        expect(chain.edges.has('svc->pod1')).toBe(true);
    });

    it('lineage: does not reverse direction, so a sibling Service stays out', () => {
        expect(sorted(chainOf(edges, 'svc', 'lineage').nodes)).toEqual(['ing', 'pod1', 'svc']);
    });

    it('neighbors: one hop only', () => {
        expect(sorted(chainOf(edges, 'rs', 'neighbors').nodes)).toEqual(['dep', 'pod1', 'rs']);
    });
});

describe('chainOf related, with dependency edges', () => {
    // Two workloads that share only the namespace's default ServiceAccount,
    // and one of which mounts a claim on a StorageClass.
    const k = (source: string, target: string, kind: string) => ({ id: `${source}->${target}`, source, target, kind });
    const deps = [
        k('svcA', 'podA', 'selector'), k('depA', 'podA', 'owner'),
        k('depB', 'podB', 'owner'),
        k('podA', 'sa', 'config'), k('podB', 'sa', 'config'),
        k('podA', 'pvc', 'storage'), k('pvc', 'sc', 'storage'),
    ];
    const structural = (e: { kind: string }) => ['owner', 'selector', 'ingress'].includes(e.kind);

    it('does not leak into another workload through a shared ServiceAccount', () => {
        expect(sorted(chainOf(deps, 'depA', 'related', structural).nodes))
            .toEqual(['depA', 'podA', 'pvc', 'sa', 'sc', 'svcA']);
    });

    it('a dependency lights everything that uses it', () => {
        expect(sorted(chainOf(deps, 'sc', 'related', structural).nodes))
            .toEqual(['depA', 'podA', 'pvc', 'sc', 'svcA']);
        expect(sorted(chainOf(deps, 'sa', 'related', structural).nodes))
            .toEqual(['depA', 'depB', 'podA', 'podB', 'sa', 'svcA']);
    });
});
