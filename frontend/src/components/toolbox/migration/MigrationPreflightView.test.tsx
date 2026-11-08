import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const preflight = vi.fn();
const start = vi.fn();
vi.mock('../../../../wailsjs/go/controller_app/App', () => ({
    MigrationPreflight: (...a: unknown[]) => preflight(...a),
    MigrationStart: (...a: unknown[]) => start(...a),
}));
vi.mock('../history/YamlDiff', () => ({ default: () => null }));

import { models } from '../../../../wailsjs/go/models';
import MigrationPreflightView from './MigrationPreflightView';

const base = {
    objects: [{ kind: 'ConfigMap', namespace: 'a', name: 'c' }], disks: [], conflicts: [], issues: [], skipped: [], missing: [], targetClasses: ['gp3'],
};
const request = models.MigrationRequest.createFrom({ source: 's', target: 't', namespaces: ['a'] });
const startButton = () => screen.getByTestId('migration-start') as HTMLButtonElement;

describe('MigrationPreflightView', () => {
    beforeEach(() => { preflight.mockReset(); start.mockReset().mockResolvedValue('new-id'); });

    it('holds the start button while a blocker stands', async () => {
        preflight.mockResolvedValue({ ...base, issues: [{ code: 'accessDenied', blocker: true, namespace: 'a', name: 't', detail: 'create pods' }] });
        render(<MigrationPreflightView request={request} onBack={() => {}} onStarted={() => {}} />);
        await waitFor(() => expect(preflight).toHaveBeenCalled());
        await waitFor(() => expect(startButton().disabled).toBe(true));
    });

    it('sends the decisions and reports the new migration', async () => {
        preflight.mockResolvedValue({ ...base, conflicts: [{ key: 'k1', kind: 'ConfigMap', namespace: 'a', name: 'c', isPvc: false, sourceYaml: '', targetYaml: '' }] });
        const onStarted = vi.fn();
        render(<MigrationPreflightView request={request} onBack={() => {}} onStarted={onStarted} />);
        await waitFor(() => expect(startButton().disabled).toBe(false));
        fireEvent.click(startButton());
        await waitFor(() => expect(onStarted).toHaveBeenCalledWith('new-id'));
        expect(start.mock.calls[0][0].decisions).toEqual({ k1: 'skip' });
    });

    it('offers no overwrite for a disk', async () => {
        preflight.mockResolvedValue({ ...base, conflicts: [{ key: 'd', kind: 'PersistentVolumeClaim', namespace: 'a', name: 'data', isPvc: true, sourceYaml: '', targetYaml: '' }] });
        render(<MigrationPreflightView request={request} onBack={() => {}} onStarted={() => {}} />);
        await waitFor(() => expect(startButton().disabled).toBe(false));
        expect(document.querySelector('.segmented')).toBeNull();
    });
});
