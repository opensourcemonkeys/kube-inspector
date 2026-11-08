import { describe, it, expect } from 'vitest';
import type { models } from '../../../../wailsjs/go/models';
import { formatSize, hasBlocker, initialDecisions, classesOf, notReadyCount, sortIssues, isFinished, phaseTone } from './migrationModel';

const issue = (code: string, blocker: boolean) => ({ code, blocker }) as models.MigrationIssue;

describe('migrationModel', () => {
    it('finds a blocker among warnings', () => {
        expect(hasBlocker([issue('gitOps', false)])).toBe(false);
        expect(hasBlocker([issue('gitOps', false), issue('accessDenied', true)])).toBe(true);
    });

    it('puts blockers before warnings', () => {
        expect(sortIssues([issue('a', false), issue('b', true)]).map((i) => i.code)).toEqual(['b', 'a']);
    });

    it('starts every conflict on keeping the target, the choice that loses nothing', () => {
        const c = [{ key: 'x' }, { key: 'y', isPvc: true }] as models.MigrationConflict[];
        expect(initialDecisions(c)).toEqual({ x: 'skip', y: 'skip' });
    });

    it('collects the class each source class was given', () => {
        const d = [{ sourceClass: 'ssd', targetClass: 'gp3' }, { sourceClass: 'hdd', targetClass: 'st1' }] as models.MigrationDisk[];
        expect(classesOf(d)).toEqual({ ssd: 'gp3', hdd: 'st1' });
    });

    it('counts workloads below their desired replicas', () => {
        const w = [{ ready: 3, desired: 3 }, { ready: 0, desired: 2 }, { ready: 1, desired: 2 }] as models.MigrationWorkloadState[];
        expect(notReadyCount(w)).toBe(2);
    });

    it('formats sizes in binary units up to terabytes', () => {
        expect(formatSize(0)).toBe('0 B');
        expect(formatSize(1536)).toBe('1.5 KiB');
        expect(formatSize(5 * 1024 ** 3)).toBe('5.0 GiB');
        expect(formatSize(1.8 * 1024 ** 4)).toBe('1.8 TiB');
    });

    it('knows the phases that are over', () => {
        expect(isFinished('done')).toBe(true);
        expect(isFinished('failed')).toBe(true);
        expect(isFinished('cancelled')).toBe(true);
        expect(isFinished('cutover')).toBe(false);
        expect(isFinished('ready')).toBe(false);
    });

    it('gives each phase a lamp tone', () => {
        expect(phaseTone('done')).toBe('ok');
        expect(phaseTone('failed')).toBe('err');
        expect(phaseTone('cancelled')).toBe('idle');
        expect(phaseTone('cutover')).toBe('warn');
    });
});
