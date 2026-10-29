import { describe, it, expect, vi, beforeEach } from 'vitest';

const getStatus = vi.fn();
vi.mock('../../wailsjs/go/controller_app/App', () => ({ GetToolboxStatus: (c: string) => getStatus(c) }));

import { useToolboxStatusStore } from './toolboxStatusStore';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('toolboxStatusStore', () => {
    beforeEach(() => {
        getStatus.mockReset();
        useToolboxStatusStore.setState({ byCluster: {} });
    });

    it('asks once for a screen full of entry points', async () => {
        getStatus.mockResolvedValue({ state: 'ok' });
        const { ensure } = useToolboxStatusStore.getState();
        ensure('a'); ensure('a'); ensure('a');
        await flush();
        ensure('a');
        expect(getStatus).toHaveBeenCalledTimes(1);
        expect(useToolboxStatusStore.getState().byCluster.a.status.state).toBe('ok');
    });

    it('turns a failed call into an unreachable status instead of throwing', async () => {
        getStatus.mockImplementation(() => { throw new Error('no backend'); });
        useToolboxStatusStore.getState().ensure('b');
        await flush();
        expect(useToolboxStatusStore.getState().byCluster.b.status).toMatchObject({ state: 'unreachable', detail: 'no backend' });
        // The in-flight mark was released: a later check is possible again.
        useToolboxStatusStore.setState({ byCluster: {} });
        useToolboxStatusStore.getState().ensure('b');
        await flush();
        expect(getStatus).toHaveBeenCalledTimes(2);
    });
});
