import { describe, it, expect } from 'vitest';
import { models } from '../../../../wailsjs/go/models';
import type { TFn } from '../../../i18n/useT';
import { fixItemPrompt } from './fixPrompt';

// Echoes the key and its options so the test sees what the prompt was built from.
const t = ((k: string, o?: Record<string, unknown>) => `${k.replace('panels:trivy.ai.', '')}${o ? ' ' + JSON.stringify(o) : ''}`) as unknown as TFn;

const wl = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'Deployment', name: `app${i}`, namespace: 'prod' }));
const base = { id: 'i', kind: 'package', package: 'openssl', installedVersion: '1.0', fixedVersion: '1.1', fixedVersions: ['1.1'], image: 'nginx:1', checkId: '', title: '', resolution: '', severity: 'HIGH', closes: {}, vulnIds: [] as string[], images: ['nginx:1'], workloads: wl(2), exposedWorkloads: 0, os: { family: 'debian', name: '12', eosl: false } };

describe('fixItemPrompt', () => {
    it('describes a package item', () => {
        const ids = Array.from({ length: 7 }, (_, i) => `CVE-2024-000${i}`);
        const p = fixItemPrompt(models.TrivyFixItem.createFrom({ ...base, vulnIds: ids }), 'c1', t);
        expect(p).toContain('openssl');
        expect(p).toContain('"installed":"1.0"');
        expect(p).toContain('"fixed":"1.1"');
        expect(p).toContain('CVE-2024-0004');
        expect(p).not.toContain('CVE-2024-0005');
        expect(p).toContain('prod/Deployment/app0');
        expect(p).toContain('prod/Deployment/app1');
    });

    it('caps workloads at five', () => {
        const p = fixItemPrompt(models.TrivyFixItem.createFrom({ ...base, workloads: wl(8) }), 'c1', t);
        expect(p).toContain('app4');
        expect(p).not.toContain('app5');
    });

    it('describes a misconfig item', () => {
        const p = fixItemPrompt(models.TrivyFixItem.createFrom({ ...base, kind: 'misconfig', checkId: 'KSV017', title: 'Privileged', resolution: 'Drop it' }), 'c1', t);
        expect(p).toContain('promptMisconfig');
        expect(p).toContain('KSV017');
        expect(p).toContain('Drop it');
    });

    it('describes a base OS item and flags EOSL', () => {
        const p = fixItemPrompt(models.TrivyFixItem.createFrom({ ...base, kind: 'baseOS', os: { family: 'debian', name: '9', eosl: true } }), 'c1', t);
        expect(p).toContain('promptBaseOS');
        expect(p).toContain('promptEosl');
    });
});
