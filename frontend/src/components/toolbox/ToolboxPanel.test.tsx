import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview';

const status = vi.fn();
let clusters = ['a', 'b'];
vi.mock('../../../wailsjs/go/controller_app/App', () => ({ GetToolboxStatus: (...a: unknown[]) => status(...a) }));
vi.mock('../../../wailsjs/go/models', () => ({ models: { ToolboxStatus: { createFrom: (x: unknown) => x } } }));
vi.mock('../../contexts/TabContext', () => ({ useTabContext: () => ({ openClusterHistory: vi.fn(), openMigration: vi.fn() }) }));
vi.mock('../../contexts/ClusterContext', () => ({ useClusterContext: () => ({ clusters }) }));
vi.mock('./RecordingHealth', () => ({ default: () => null }));

import ToolboxPanel from './ToolboxPanel';

const props = { params: { clusterName: 'a' }, api: { id: 'toolbox:a' } } as unknown as IDockviewPanelProps<{ clusterName: string }>;
const rows = () => [...document.querySelectorAll('.tool-row')];

describe('ToolboxPanel', () => {
    beforeEach(() => { status.mockReset().mockResolvedValue({ state: 'notInstalled' }); clusters = ['a', 'b']; });

    it('gives each tool its own row and state', async () => {
        render(<ToolboxPanel {...props} />);
        await waitFor(() => expect(status).toHaveBeenCalledWith('a'));
        await waitFor(() => expect(rows()[0].getAttribute('aria-disabled')).toBe('true'));
        expect(rows()).toHaveLength(2);
        // The recorder missing says nothing about migration, which installs nothing.
        expect(rows()[1].getAttribute('aria-disabled')).toBe('false');
        expect(screen.getAllByRole('button').some((b) => (b as HTMLButtonElement).disabled === false)).toBe(true);
    });

    it('holds migration off with no other cluster to move to', async () => {
        clusters = ['a'];
        render(<ToolboxPanel {...props} />);
        await waitFor(() => expect(status).toHaveBeenCalled());
        expect(rows()[1].getAttribute('aria-disabled')).toBe('true');
    });
});
