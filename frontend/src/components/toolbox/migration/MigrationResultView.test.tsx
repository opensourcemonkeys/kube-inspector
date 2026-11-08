import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const getResult = vi.fn();
const restart = vi.fn();
vi.mock('../../../../wailsjs/go/controller_app/App', () => ({
    MigrationGetResult: (...a: unknown[]) => getResult(...a),
    MigrationRestartSource: (...a: unknown[]) => restart(...a),
}));
vi.mock('../../../lib/usePanelActive', () => ({ usePanelActive: () => true }));
vi.mock('../../../stores/clusterColorStore', () => ({ useClusterColor: () => undefined }));

import MigrationResultView from './MigrationResultView';

const result = (over: object = {}) => ({
    id: 'm1', source: 'prod-a', target: 'prod-b', phase: 'done', namespaces: ['shop'], objectCount: 214, bytesCopied: 1024 ** 3, downtimeSeconds: 252,
    workloads: [{ kind: 'Deployment', namespace: 'shop', name: 'api', ready: 3, desired: 3 }, { kind: 'Deployment', namespace: 'shop', name: 'worker', ready: 0, desired: 2, reason: 'CrashLoopBackOff' }],
    disks: [{ namespace: 'db', name: 'data', size: '500Gi', sourceClass: 'ssd', targetClass: 'gp3', status: 'Bound', copied: true, bytesCopied: 1024 ** 3 }],
    addresses: [{ kind: 'Ingress', namespace: 'shop', name: 'web', host: 'shop.example.com', address: '203.0.113.10' }],
    skipped: [{ kind: 'Job', namespace: 'shop', name: 'once', reason: 'standaloneJob' }],
    sourceStopped: true, ...over,
});

describe('MigrationResultView', () => {
    beforeEach(() => { getResult.mockReset(); restart.mockReset().mockResolvedValue(undefined); });

    it('shows every section of a finished migration on one page', async () => {
        getResult.mockResolvedValue(result());
        render(<MigrationResultView id="m1" onNew={() => {}} />);
        await waitFor(() => expect(screen.getByText('shop/worker')).toBeTruthy());
        expect(screen.getByText('CrashLoopBackOff')).toBeTruthy();
        expect(screen.getByText('db/data')).toBeTruthy();
        expect(screen.getByText('shop.example.com')).toBeTruthy();
        expect(screen.getByText('203.0.113.10')).toBeTruthy();
    });

    it('offers to start a stopped source, and asks first', async () => {
        getResult.mockResolvedValue(result());
        render(<MigrationResultView id="m1" onNew={() => {}} />);
        const open = await screen.findByTestId('migration-restart');
        fireEvent.click(open);
        expect(restart).not.toHaveBeenCalled();
    });

    it('does not offer to start a source that is running', async () => {
        getResult.mockResolvedValue(result({ sourceStopped: false }));
        render(<MigrationResultView id="m1" onNew={() => {}} />);
        await waitFor(() => expect(screen.getByText('shop/worker')).toBeTruthy());
        expect(screen.queryByTestId('migration-restart')).toBeNull();
    });
});
