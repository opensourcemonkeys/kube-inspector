import { describe, it, expect } from 'vitest';
import { parseObjectRef, refLabel, refFromToolArgs } from './refs';
import { splitFences } from './ChatLog';

describe('parseObjectRef', () => {
    it('reads kind/namespace/name and kind/name', () => {
        expect(parseObjectRef('deployment/shop/api')).toEqual({ resource: 'deployments', group: 'apps', namespace: 'shop', name: 'api' });
        expect(parseObjectRef('node/worker-1')).toEqual({ resource: 'nodes', group: '', namespace: '', name: 'worker-1' });
        expect(parseObjectRef('Pod/default/web-0')?.resource).toBe('pods');
        expect(parseObjectRef('pods/default/web-0')?.resource).toBe('pods');
        expect(parseObjectRef('deploy/shop/api')?.resource).toBe('deployments');
    });

    it('rejects anything that is not an object reference', () => {
        for (const s of ['kubectl get pods', 'foo/bar/baz', 'pod', 'pod/a/b/c', 'pod/Bad_Name', '/etc/passwd', 'https://x/y']) {
            expect(parseObjectRef(s)).toBeNull();
        }
    });
});

describe('refLabel', () => {
    it('uses the full singular kind', () => {
        expect(refLabel({ resource: 'deployments', namespace: 'shop', name: 'api' })).toBe('deployment/shop/api');
        expect(refLabel({ resource: 'pods', namespace: 'a', name: 'p', container: 'c' })).toBe('pod/a/p · c');
    });
});

describe('refFromToolArgs', () => {
    it('finds the object a tool call targets', () => {
        expect(refFromToolArgs('get_pod_logs', { namespace: 'a', pod: 'p' })?.resource).toBe('pods');
        expect(refFromToolArgs('scale_workload', { kind: 'deployment', namespace: 'a', name: 'd', replicas: 2 })?.resource).toBe('deployments');
        expect(refFromToolArgs('describe_object', { resource: 'services', namespace: 'a', name: 's' })?.name).toBe('s');
        expect(refFromToolArgs('list_pods', { namespace: 'a' })).toBeNull();
    });
});

describe('splitFences', () => {
    it('separates prose from fenced code, including an unclosed fence', () => {
        expect(splitFences('Hi\n```yaml\na: 1\n```\nBye')).toEqual([{ text: 'Hi' }, { code: 'a: 1' }, { text: 'Bye' }]);
        expect(splitFences('Start\n```\nstill streaming')).toEqual([{ text: 'Start' }, { code: 'still streaming' }]);
    });
});
