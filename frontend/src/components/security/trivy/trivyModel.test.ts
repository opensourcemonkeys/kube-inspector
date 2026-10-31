import { describe, it, expect } from 'vitest';
import i18n from 'i18next';
import { models } from '../../../../wailsjs/go/models';
import {
    defaultCompareId, defaultExpiryDate, endOfDayRFC3339, fixItemExceptions, misconfigException, olderScans,
    severityDelta, sumSeverities, verdictParams, verdictText, vulnException, workloadYamlTarget,
} from './trivyModel';

const ref = (kind: string, name: string, namespace = 'default') => ({ kind, name, namespace }) as models.TrivyWorkloadRef;

const vulnRow = (p: Partial<models.TrivyVulnRow>): models.TrivyVulnRow => ({
    key: '', workload: ref('Deployment', 'api'), image: 'nginx:1.25', imageRepo: 'index.docker.io/library/nginx',
    target: '', class: 'os-pkgs', vulnerabilityID: 'CVE-1', pkgName: 'openssl', pkgPath: '', installedVersion: '1',
    fixedVersion: '2', severity: 'HIGH', title: '', description: '', primaryURL: '', publishedDate: '', references: [],
    isNew: false, accepted: false, ...p,
}) as models.TrivyVulnRow;

describe('endOfDayRFC3339', () => {
    it('is the last second of the chosen local day, without milliseconds', () => {
        const day = new Date(2026, 11, 31, 9, 30);
        const s = endOfDayRFC3339(day);
        expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        const back = new Date(s);
        expect(back.getFullYear()).toBe(2026);
        expect(back.getMonth()).toBe(11);
        expect(back.getDate()).toBe(31);
        expect(back.getHours()).toBe(23);
        expect(back.getMinutes()).toBe(59);
        expect(back.getSeconds()).toBe(59);
    });
});

describe('defaultExpiryDate', () => {
    it('is 90 days from today at local midnight', () => {
        const d = defaultExpiryDate(new Date(2026, 0, 1, 15, 0));
        expect(d.getFullYear()).toBe(2026);
        expect(d.getMonth()).toBe(3);
        expect(d.getDate()).toBe(1);
        expect(d.getHours()).toBe(0);
    });
});

describe('exception payloads', () => {
    it('scopes a vulnerability to the CVE and the image repository', () => {
        const e = vulnException(vulnRow({ vulnerabilityID: 'CVE-9' }), ' risk ok ', '2027-01-01T00:00:00Z');
        expect(e).toMatchObject({ kind: 'vuln', vulnerabilityId: 'CVE-9', imageRepo: 'index.docker.io/library/nginx', reason: 'risk ok', expiresAt: '2027-01-01T00:00:00Z' });
        expect(e.checkId).toBe('');
    });

    it('scopes a misconfiguration to the check and the workload', () => {
        const row = { resourceKind: 'Deployment', resourceName: 'api', namespace: 'prod', checkID: 'KSV012' } as models.TrivyMisconfigRow;
        const e = misconfigException(row, 'needed', '2027-01-01T00:00:00Z');
        expect(e).toMatchObject({ kind: 'misconfig', checkId: 'KSV012', workload: { kind: 'Deployment', name: 'api', namespace: 'prod' } });
        expect(e.vulnerabilityId).toBe('');
    });

    it('turns a package item into one exception per (CVE, image repository) it covers', () => {
        const item = { kind: 'package', vulnIds: ['CVE-1', 'CVE-2'], images: ['nginx:1.25', 'redis:7'] } as models.TrivyFixItem;
        const rows = [
            vulnRow({ vulnerabilityID: 'CVE-1', image: 'nginx:1.25', imageRepo: 'repo/nginx' }),
            vulnRow({ vulnerabilityID: 'CVE-1', image: 'nginx:1.25', imageRepo: 'repo/nginx', workload: ref('Deployment', 'web') }),
            vulnRow({ vulnerabilityID: 'CVE-2', image: 'redis:7', imageRepo: 'repo/redis' }),
            vulnRow({ vulnerabilityID: 'CVE-1', image: 'other:1', imageRepo: 'repo/other' }),
            vulnRow({ vulnerabilityID: 'CVE-3', image: 'nginx:1.25', imageRepo: 'repo/nginx' }),
            vulnRow({ vulnerabilityID: 'CVE-2', image: 'nginx:1.25', imageRepo: 'repo/nginx', accepted: true }),
        ];
        const out = fixItemExceptions(item, rows, 'r', 'x');
        expect(out.map((e) => `${e.vulnerabilityId}@${e.imageRepo}`)).toEqual(['CVE-1@repo/nginx', 'CVE-2@repo/redis']);
        expect(out.every((e) => e.kind === 'vuln' && e.reason === 'r' && e.expiresAt === 'x')).toBe(true);
    });

    it('turns a misconfiguration item into one exception per workload', () => {
        const item = { kind: 'misconfig', checkId: 'KSV017', workloads: [ref('Deployment', 'a'), ref('DaemonSet', 'b', 'kube-system')] } as models.TrivyFixItem;
        const out = fixItemExceptions(item, [], 'r', 'x');
        expect(out).toHaveLength(2);
        expect(out[1]).toMatchObject({ kind: 'misconfig', checkId: 'KSV017', workload: { kind: 'DaemonSet', name: 'b', namespace: 'kube-system' } });
    });
});

describe('summary arithmetic', () => {
    it('sums severities across maps that may be null', () => {
        expect(sumSeverities('CRITICAL', { CRITICAL: 2 }, null, { CRITICAL: 1, HIGH: 4 })).toBe(3);
    });

    it('reads a severity\'s delta from the view, null without a comparison', () => {
        expect(severityDelta('CRITICAL', null)).toBeNull();
        expect(severityDelta('CRITICAL', undefined)).toBeNull();
        expect(severityDelta('CRITICAL', { CRITICAL: 2, HIGH: -3 })).toBe(2);
        expect(severityDelta('HIGH', { CRITICAL: 2, HIGH: -3 })).toBe(-3);
        expect(severityDelta('HIGH', {})).toBe(0);
    });

    it('builds the verdict from the top three fix items', () => {
        const plan = [
            { closes: { CRITICAL: 2, HIGH: 1, LOW: 9 } },
            { closes: { HIGH: 3 } },
            { closes: null },
            { closes: { CRITICAL: 50 } },
        ] as unknown as models.TrivyFixItem[];
        expect(verdictParams(plan)).toEqual({ topItems: 3, closes: 6 });
        expect(verdictParams(null)).toEqual({ topItems: 0, closes: 0 });
    });
});

describe('verdictText', () => {
    const view = (p: { vulns?: Record<string, number>; misconfigs?: Record<string, number>; secrets?: Record<string, number>; fixPlan?: unknown[] }) => ({
        exposureKnown: true,
        fixPlan: p.fixPlan ?? [],
        summary: { vulns: p.vulns ?? {}, misconfigs: p.misconfigs ?? {}, secrets: p.secrets ?? {}, exposedCritical: 0 },
    }) as unknown as models.TrivyScanView;

    it('says there is nothing open rather than that nothing has a fix', () => {
        const text = verdictText(i18n.t, view({}));
        expect(text).toBe(i18n.t('panels:trivy.summary.verdictClean'));
        expect(text).not.toMatch(/fix/i);
    });
    it('keeps the no-fix wording while findings are open', () => {
        expect(verdictText(i18n.t, view({ vulns: { LOW: 1 } }))).toMatch(/None of the open findings has a fix yet/);
        expect(verdictText(i18n.t, view({ secrets: { HIGH: 1 } }))).toMatch(/None of the open findings has a fix yet/);
    });
});

describe('olderScans', () => {
    const scans = [{ id: 's3' }, { id: 's2' }, { id: 's1' }] as models.TrivyScanMeta[];
    it('offers only scans older than the selected one', () => {
        expect(olderScans(scans, 's3').map((s) => s.id)).toEqual(['s2', 's1']);
        expect(olderScans(scans, 's2').map((s) => s.id)).toEqual(['s1']);
        expect(olderScans(scans, 's1')).toEqual([]);
    });
    it('offers nothing when no scan is selected', () => {
        expect(olderScans(scans, null)).toEqual([]);
        expect(olderScans(scans, 'nope')).toEqual([]);
    });
});

describe('defaultCompareId', () => {
    const scans = [{ id: 's3' }, { id: 's2' }, { id: 's1' }] as models.TrivyScanMeta[];
    it('is the scan before the selected one', () => {
        expect(defaultCompareId(scans, 's3')).toBe('s2');
        expect(defaultCompareId(scans, 's2')).toBe('s1');
    });
    it('is empty for the oldest or an unknown scan', () => {
        expect(defaultCompareId(scans, 's1')).toBe('');
        expect(defaultCompareId(scans, 'nope')).toBe('');
    });
});

describe('workloadYamlTarget', () => {
    it('maps a typed kind to its YAML panel kind and sidebar view', () => {
        expect(workloadYamlTarget('Deployment')).toEqual({ typed: { yaml: 'deployment', view: 'deployments' } });
        expect(workloadYamlTarget('CronJob')).toEqual({ typed: { yaml: 'cronjob', view: 'cronjobs' } });
    });
    it('falls back to the generic object YAML for known untyped kinds', () => {
        expect(workloadYamlTarget('ClusterRole')).toEqual({ object: { group: 'rbac.authorization.k8s.io', resource: 'clusterroles' } });
    });
    it('has no target for an unknown kind', () => {
        expect(workloadYamlTarget('Widget')).toBeNull();
        expect(workloadYamlTarget('')).toBeNull();
    });
});
