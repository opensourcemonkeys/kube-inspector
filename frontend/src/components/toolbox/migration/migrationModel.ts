import type { models } from '../../../../wailsjs/go/models';
import type { LampTone } from '../../shared/StatusLamp';

export type Decision = 'skip' | 'overwrite';

export const hasBlocker = (issues: models.MigrationIssue[]) => issues.some((i) => i.blocker);

export const sortIssues = (issues: models.MigrationIssue[]) =>
    [...issues].sort((a, b) => Number(b.blocker) - Number(a.blocker));

/** Every conflict starts on keeping what the target has, the choice that loses nothing. */
export function initialDecisions(conflicts: models.MigrationConflict[]): Record<string, Decision> {
    return Object.fromEntries(conflicts.map((c) => [c.key, 'skip' as Decision]));
}

export function classesOf(disks: models.MigrationDisk[]): Record<string, string> {
    return Object.fromEntries(disks.map((d) => [d.sourceClass, d.targetClass]));
}

export const notReadyCount = (workloads: models.MigrationWorkloadState[]) =>
    workloads.filter((w) => w.ready < w.desired).length;

const SIZE_UNITS = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

export function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    let value = bytes;
    let unit = -1;
    while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

export const isFinished = (phase: string) => phase === 'done' || phase === 'failed' || phase === 'cancelled';

export function phaseTone(phase: string): LampTone {
    switch (phase) {
        case 'done': return 'ok';
        case 'failed': return 'err';
        case 'cancelled': return 'idle';
        case 'cutover': return 'warn';
        default: return 'info';
    }
}

/** The system namespaces a migration refuses, left out of the picker. */
export const SYSTEM_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease']);
