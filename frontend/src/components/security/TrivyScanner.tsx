import { useEffect, useMemo, useRef, useState } from 'react';

import { VscPlay, VscShield, VscLinkExternal, VscExport, VscStopCircle } from 'react-icons/vsc';

import { DataTable, DataTableFilterMeta } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { Toast } from 'primereact/toast';
import { Message } from 'primereact/message';
import { TabView, TabPanel } from 'primereact/tabview';
import { InputText } from 'primereact/inputtext';
import { MultiSelect } from 'primereact/multiselect';
import { ProgressBar } from 'primereact/progressbar';
import { FilterMatchMode } from 'primereact/api';
import { BrowserOpenURL, EventsOn } from '../../../wailsjs/runtime/runtime';

import {
    TrivyListPodImages,
    TrivyScanImage,
    TrivyStartK8sScan,
    TrivyStopK8sScan,
    TrivyListPodImagesWithContext,
    SaveReport,
} from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useT } from '../../i18n/useT';
import StatusLamp from '../shared/StatusLamp';

// ─── Types ────────────────────────────────────────────────────────────────────

type VulnRow = {
    _uid: string;
    image: string;
    resourceKind: string;
    resourceName: string;
    resourceNs: string;
    target: string;
    vulnerabilityID: string;
    pkgName: string;
    installedVersion: string;
    fixedVersion: string;
    severity: string;
    title: string;
    description: string;
    primaryURL: string;
    references: string[];
    publishedDate: string;
};

type MisconfigRow = {
    _uid: string;
    resourceKind: string;
    resourceName: string;
    namespace: string;
    checkID: string;
    severity: string;
    title: string;
    message: string;
    description: string;
    resolution: string;
    primaryURL: string;
    references: string[];
};

type SecretRow = {
    _uid: string;
    resourceKind: string;
    resourceName: string;
    namespace: string;
    ruleID: string;
    category: string;
    severity: string;
    title: string;
    match: string;
};

// Matches models.TrivyK8sScanResult emitted via Wails event
type K8sScanResult = {
    misconfigs: Array<{
        resourceKind: string; resourceName: string; namespace: string;
        checkID: string; severity: string; title: string; message: string;
        description: string; resolution: string; primaryURL: string; references: string[]; status: string;
    }>;
    secrets: Array<{
        resourceKind: string; resourceName: string; namespace: string;
        ruleID: string; category: string; severity: string; title: string; match: string;
    }>;
    misconfigSummary: Record<string, number>;
    secretSummary: Record<string, number>;
    resourceCount: number;
    scannedAt: string;
};

type Progress = { current: number; total: number; image: string } | null;
type PushToast = (severity: 'success' | 'warn' | 'error', summary: string, detail?: string) => void;

// ─── Shared constants & helpers ───────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
    CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, UNKNOWN: 1,
};
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

function severitySeverity(sev: string): 'danger' | 'warning' | 'info' | undefined {
    switch (sev) {
        case 'CRITICAL': case 'HIGH': return 'danger';
        case 'MEDIUM': return 'warning';
        case 'LOW': return 'info';
        default: return undefined;
    }
}

function vulnUrl(id: string, primaryURL: string): string {
    if (/^CVE-\d{4}-\d+$/i.test(id || '')) {
        return `https://www.cve.org/CVERecord?id=${id.toUpperCase()}`;
    }
    return primaryURL || '';
}

function rowsFromResult(imgInfo: models.TrivyK8sImageInfo, res: models.TrivyScanResult): VulnRow[] {
    const out: VulnRow[] = [];
    (res.targets || []).forEach((t) => {
        (t.vulnerabilities || []).forEach((v, i) => {
            out.push({
                _uid: `${imgInfo.image}|${t.target}|${v.vulnerabilityID}|${v.pkgName}|${i}`,
                image: imgInfo.image,
                resourceKind: imgInfo.resourceKind || '',
                resourceName: imgInfo.resourceName || '',
                resourceNs: imgInfo.namespace || '',
                target: t.target,
                vulnerabilityID: v.vulnerabilityID,
                pkgName: v.pkgName,
                installedVersion: v.installedVersion,
                fixedVersion: v.fixedVersion,
                severity: (v.severity || 'UNKNOWN').toUpperCase(),
                title: v.title,
                description: v.description || '',
                primaryURL: v.primaryURL,
                references: v.references || [],
                publishedDate: v.publishedDate || '',
            });
        });
    });
    return out;
}

const escapeHtml = (s: string) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

// ─── SeverityTag ──────────────────────────────────────────────────────────────

// A severity is a state of the finding, so a lamp: ■ critical/high, ▲ medium,
// ◆ low, ○ unknown — the shape says it before the colour does.
function SeverityTag({ sev }: { sev: string }) {
    return <StatusLamp label={sev} severity={severitySeverity(sev)} />;
}

// ─── Finding detail modal ─────────────────────────────────────────────────────

// Trivy does not provide remediation for detected secrets, so we surface curated
// guidance keyed by the secret category (falling back to generic advice).
function secretRemediation(category: string, _ruleID: string): string {
    const c = (category || '').toLowerCase();
    const generic =
        'Treat this credential as compromised. Rotate/revoke it immediately at the provider, ' +
        'remove the literal value from the manifest, and purge it from Git history (e.g. git filter-repo / BFG). ' +
        'Store the secret in a Kubernetes Secret (or External Secrets / Sealed Secrets / a vault) and ' +
        'inject it via envFrom or a mounted volume instead of hardcoding it.';
    if (c.includes('aws'))
        return 'Rotate this AWS key in IAM (deactivate then delete the exposed access key) and audit CloudTrail for misuse. ' + generic;
    if (c.includes('gcp') || c.includes('google'))
        return 'Revoke this Google Cloud service-account key and create a new one; review IAM audit logs for misuse. ' + generic;
    if (c.includes('private') || c.includes('rsa') || c.includes('ssh'))
        return 'Consider this private key compromised: revoke/replace the key pair and rotate anything it protected. ' + generic;
    if (c.includes('token') || c.includes('jwt') || c.includes('github'))
        return 'Revoke this token at the issuing service and generate a new one with least-privilege scopes. ' + generic;
    return generic;
}

type DetailFinding = {
    kind: 'misconfig' | 'secret' | 'vuln';
    severity: string;
    title: string;
    idLabel: string; // e.g. "KSV001" | "CVE-2023-1234" | rule id
    resource: { kind: string; name: string; namespace: string };
    description: string;
    details: string;
    recommendation: string;
    references: string[];
    externalUrl: string;
};

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
    if (!value) return null;
    return (
        <div className="trivy-detail">
            <span className="trivy-detail__label">{label}</span>
            <span className={`trivy-detail__value${mono ? ' trivy-detail__value--mono' : ''}`}>{value}</span>
        </div>
    );
}

function FindingDetailDialog({ finding, onHide }: { finding: DetailFinding | null; onHide: () => void }) {
    const t = useT();
    if (!finding) return null;
    const res = finding.resource;
    const resourceLine = [res.kind, res.namespace ? `${res.namespace}/${res.name}` : res.name]
        .filter(Boolean)
        .join(' ');
    return (
        <Dialog
            visible={!!finding}
            onHide={onHide}
            dismissableMask
            className="trivy-detail-dialog"
            header={
                <div className="trivy-detail-head">
                    <SeverityTag sev={finding.severity} />
                    {finding.idLabel && <span className="trivy-detail-head__id">{finding.idLabel}</span>}
                    <span className="trivy-detail-head__title">{finding.title}</span>
                </div>
            }
        >
            <div className="flex flex-column gap-3">
                <DetailRow label={t('panels:trivy.detailResource')} value={resourceLine} />
                <DetailRow label={t('panels:trivy.detailDescription')} value={finding.description} />
                <DetailRow label={t('panels:trivy.detailDetails')} value={finding.details} mono={finding.kind === 'secret'} />

                <div className="trivy-rec">
                    <span className="trivy-detail__label">{t('panels:trivy.recommendation')}</span>
                    <span className="trivy-detail__value">{finding.recommendation || t('panels:trivy.noRemediation')}</span>
                </div>

                {finding.references.length > 0 && (
                    <div className="flex flex-column gap-1">
                        <span className="trivy-detail__label">{t('panels:trivy.references')}</span>
                        <ul className="m-0 pl-3 flex flex-column gap-1">
                            {finding.references.map((url) => (
                                <li key={url}>
                                    <a className="trivy-link" onClick={() => BrowserOpenURL(url)}>
                                        {url}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {finding.externalUrl && (
                    <div>
                        <Button
                            label={t('panels:trivy.openAdvisory')}
                            icon={<VscLinkExternal className="mr-2" />}
                            size="small"
                            outlined
                            onClick={() => BrowserOpenURL(finding.externalUrl)}
                        />
                    </div>
                )}
            </div>
        </Dialog>
    );
}

// ─── Row → DetailFinding adapters ─────────────────────────────────────────────

function misconfigToFinding(r: MisconfigRow): DetailFinding {
    return {
        kind: 'misconfig',
        severity: r.severity,
        title: r.title,
        idLabel: r.checkID,
        resource: { kind: r.resourceKind, name: r.resourceName, namespace: r.namespace },
        description: r.description,
        details: r.message,
        recommendation: r.resolution,
        references: r.references,
        externalUrl: r.primaryURL,
    };
}

function secretToFinding(r: SecretRow): DetailFinding {
    const masked = r.match ? r.match.replace(/.(?=.{4})/g, '*') : '';
    return {
        kind: 'secret',
        severity: r.severity,
        title: r.title,
        idLabel: r.ruleID,
        resource: { kind: r.resourceKind, name: r.resourceName, namespace: r.namespace },
        description: r.category ? `Detected secret category: ${r.category}` : '',
        details: masked ? `Match: ${masked}` : '',
        recommendation: secretRemediation(r.category, r.ruleID),
        references: [],
        externalUrl: '',
    };
}

function vulnToFinding(r: VulnRow): DetailFinding {
    const recommendation = r.fixedVersion
        ? `Upgrade package "${r.pkgName}" from ${r.installedVersion || '?'} to ${r.fixedVersion} (or later).`
        : 'No fixed version is available yet. Track the advisory below and apply a fix when released, or mitigate by restricting exposure.';
    const details = [
        `Package: ${r.pkgName}`,
        `Installed: ${r.installedVersion || '—'}`,
        `Fixed: ${r.fixedVersion || '—'}`,
        r.publishedDate ? `Published: ${r.publishedDate}` : '',
    ].filter(Boolean).join('\n');
    return {
        kind: 'vuln',
        severity: r.severity,
        title: r.title,
        idLabel: r.vulnerabilityID,
        resource: { kind: r.resourceKind, name: r.resourceName, namespace: r.resourceNs },
        description: r.description,
        details,
        recommendation,
        references: r.references || [],
        externalUrl: vulnUrl(r.vulnerabilityID, r.primaryURL),
    };
}

// ─── SummaryGrid ──────────────────────────────────────────────────────────────

type SummaryCategory = { label: string; counts: Record<string, number> };

// Aligned table of all finding categories: one row per category, one column
// per severity plus a total. A readout, not a wall of tinted tiles: a count is
// only coloured when it is non-zero, and the header carries each severity's
// lamp, so the colour is never the only cue.
function SummaryGrid({ categories }: { categories: SummaryCategory[] }) {
    const t = useT();
    const visible = categories.filter((c) => Object.values(c.counts).reduce((a, b) => a + b, 0) > 0);
    if (visible.length === 0) return null;
    return (
        <table className="trivy-summary">
            <thead>
                <tr>
                    <th />
                    {SEVERITIES.map((s) => <th key={s}><SeverityTag sev={s} /></th>)}
                    <th>{t('panels:trivy.total')}</th>
                </tr>
            </thead>
            <tbody>
                {visible.map((cat) => {
                    const total = Object.values(cat.counts).reduce((a, b) => a + b, 0);
                    return (
                        <tr key={cat.label}>
                            <th scope="row">{cat.label}</th>
                            {SEVERITIES.map((s) => {
                                const n = cat.counts[s] || 0;
                                return <td key={s} className={n > 0 ? `trivy-summary__n trivy-summary__n--${severitySeverity(s) ?? 'none'}` : 'trivy-summary__n trivy-summary__n--zero'}>{n}</td>;
                            })}
                            <td className="trivy-summary__n trivy-summary__n--total">{total}</td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

// ─── Shared filter templates ──────────────────────────────────────────────────

// A component rather than a plain template function: it needs `t`, and PrimeReact
// invokes a filterElement template inline during the table's own render — a hook
// called there would join the *table's* hook sequence conditionally. As an element
// it gets its own.
function SeverityFilter({ options }: { options: any }) {
    const t = useT();
    return (
        <MultiSelect
            value={options.value}
            options={SEVERITIES.map((s) => ({ label: s, value: s }))}
            onChange={(e) => options.filterApplyCallback(e.value)}
            placeholder={t('panels:trivy.severity')}
            className="p-column-filter"
        />
    );
}

const severityFilterTemplate = (options: any) => <SeverityFilter options={options} />;

// ─── MisconfigTable ───────────────────────────────────────────────────────────

const defaultMisconfigFilters: DataTableFilterMeta = {
    severity: { value: null, matchMode: FilterMatchMode.IN },
    checkID: { value: null, matchMode: FilterMatchMode.CONTAINS },
    resourceKind: { value: null, matchMode: FilterMatchMode.CONTAINS },
    resourceName: { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace: { value: null, matchMode: FilterMatchMode.CONTAINS },
};

function MisconfigTable({ rows, scanning }: { rows: MisconfigRow[]; scanning: boolean }) {
    const t = useT();
    const [globalFilter, setGlobalFilter] = useState('');
    const [filters, setFilters] = useState<DataTableFilterMeta>(defaultMisconfigFilters);
    const [selected, setSelected] = useState<DetailFinding | null>(null);

    const sorted = useMemo(
        () => [...rows].sort((a, b) => (SEVERITY_ORDER[b.severity] || 0) - (SEVERITY_ORDER[a.severity] || 0)),
        [rows]
    );

    return (
        <>
        <DataTable
            value={sorted}
            dataKey="_uid"
            size="small"
            scrollable
            paginator
            rows={50}
            rowsPerPageOptions={[25, 50, 100]}
            filters={filters}
            onFilter={(e) => setFilters(e.filters)}
            globalFilter={globalFilter}
            globalFilterFields={['checkID', 'resourceKind', 'resourceName', 'namespace', 'title', 'message']}
            filterDisplay="menu"
            onRowDoubleClick={(e) => setSelected(misconfigToFinding(e.data as MisconfigRow))}
            rowClassName={() => 'cursor-pointer'}
            emptyMessage={t(scanning ? 'panels:trivy.scanning' : 'panels:trivy.noMisconfigs')}
            header={
                <div className="flex justify-content-end">
                    <InputText value={globalFilter} onChange={(e) => setGlobalFilter(e.target.value)} placeholder={t('panels:trivy.search')} />
                </div>
            }
        >
            <Column field="severity" header={t('resources:column.severity')} body={(r: MisconfigRow) => <SeverityTag sev={r.severity} />} sortable filter filterElement={severityFilterTemplate} showFilterMatchModes={false} style={{ width: 110 }} />
            <Column field="checkID" header={t('resources:column.check')} sortable filter style={{ width: 100 }} />
            <Column field="resourceKind" header={t('resources:column.kind')} sortable filter style={{ width: 120 }} />
            <Column field="resourceName" header={t('resources:column.resource')} sortable filter />
            <Column field="namespace" header={t('resources:column.namespace')} sortable filter style={{ width: 130 }} />
            <Column field="title" header={t('resources:column.title')} />
            <Column field="resolution" header={t('resources:column.resolution')} style={{ maxWidth: 300 }} />
        </DataTable>
        <FindingDetailDialog finding={selected} onHide={() => setSelected(null)} />
        </>
    );
}

// ─── SecretTable ──────────────────────────────────────────────────────────────

const defaultSecretFilters: DataTableFilterMeta = {
    severity: { value: null, matchMode: FilterMatchMode.IN },
    ruleID: { value: null, matchMode: FilterMatchMode.CONTAINS },
    resourceKind: { value: null, matchMode: FilterMatchMode.CONTAINS },
    resourceName: { value: null, matchMode: FilterMatchMode.CONTAINS },
};

function SecretTable({ rows, scanning }: { rows: SecretRow[]; scanning: boolean }) {
    const t = useT();
    const [globalFilter, setGlobalFilter] = useState('');
    const [filters, setFilters] = useState<DataTableFilterMeta>(defaultSecretFilters);
    const [selected, setSelected] = useState<DetailFinding | null>(null);

    const sorted = useMemo(
        () => [...rows].sort((a, b) => (SEVERITY_ORDER[b.severity] || 0) - (SEVERITY_ORDER[a.severity] || 0)),
        [rows]
    );

    return (
        <>
        <DataTable
            value={sorted}
            dataKey="_uid"
            size="small"
            scrollable
            paginator
            rows={50}
            rowsPerPageOptions={[25, 50, 100]}
            filters={filters}
            onFilter={(e) => setFilters(e.filters)}
            globalFilter={globalFilter}
            globalFilterFields={['ruleID', 'category', 'resourceKind', 'resourceName', 'namespace', 'title', 'match']}
            filterDisplay="menu"
            onRowDoubleClick={(e) => setSelected(secretToFinding(e.data as SecretRow))}
            rowClassName={() => 'cursor-pointer'}
            emptyMessage={t(scanning ? 'panels:trivy.scanning' : 'panels:trivy.noSecrets')}
            header={
                <div className="flex justify-content-end">
                    <InputText value={globalFilter} onChange={(e) => setGlobalFilter(e.target.value)} placeholder={t('panels:trivy.search')} />
                </div>
            }
        >
            <Column field="severity" header={t('resources:column.severity')} body={(r: SecretRow) => <SeverityTag sev={r.severity} />} sortable filter filterElement={severityFilterTemplate} showFilterMatchModes={false} style={{ width: 110 }} />
            <Column field="ruleID" header={t('resources:column.ruleId')} sortable filter style={{ width: 160 }} />
            <Column field="category" header={t('resources:column.category')} sortable style={{ width: 160 }} />
            <Column field="resourceKind" header={t('resources:column.kind')} sortable filter style={{ width: 120 }} />
            <Column field="resourceName" header={t('resources:column.resource')} sortable filter />
            <Column field="namespace" header={t('resources:column.namespace')} sortable style={{ width: 130 }} />
            <Column field="title" header={t('resources:column.title')} />
            <Column field="match" header={t('resources:column.match')} className="cell-mono" style={{ maxWidth: 220 }} />
        </DataTable>
        <FindingDetailDialog finding={selected} onHide={() => setSelected(null)} />
        </>
    );
}

// ─── VulnTable ────────────────────────────────────────────────────────────────

const defaultVulnFilters: DataTableFilterMeta = {
    severity: { value: null, matchMode: FilterMatchMode.IN },
    vulnerabilityID: { value: null, matchMode: FilterMatchMode.CONTAINS },
    pkgName: { value: null, matchMode: FilterMatchMode.CONTAINS },
    image: { value: null, matchMode: FilterMatchMode.CONTAINS },
    resourceKind: { value: null, matchMode: FilterMatchMode.CONTAINS },
    resourceName: { value: null, matchMode: FilterMatchMode.CONTAINS },
};

const cveBody = (r: VulnRow) => {
    const url = vulnUrl(r.vulnerabilityID, r.primaryURL);
    return url ? (
        <a className="trivy-link trivy-link--inline" onClick={() => BrowserOpenURL(url)}>
            {r.vulnerabilityID} <VscLinkExternal />
        </a>
    ) : <span>{r.vulnerabilityID}</span>;
};
const fixedBody = (r: VulnRow) =>
    r.fixedVersion ? <span>{r.fixedVersion}</span> : <span className="trivy-muted">—</span>;

function VulnTable({ rows, scanning, showImageColumn }: { rows: VulnRow[]; scanning: boolean; showImageColumn: boolean }) {
    const t = useT();
    const [globalFilter, setGlobalFilter] = useState('');
    const [filters, setFilters] = useState<DataTableFilterMeta>(defaultVulnFilters);
    const [selected, setSelected] = useState<DetailFinding | null>(null);

    const sorted = useMemo(
        () => [...rows].sort((a, b) => (SEVERITY_ORDER[b.severity] || 0) - (SEVERITY_ORDER[a.severity] || 0)),
        [rows]
    );

    return (
        <>
        <DataTable
            value={sorted}
            dataKey="_uid"
            size="small"
            scrollable
            paginator
            rows={50}
            rowsPerPageOptions={[25, 50, 100]}
            filters={filters}
            onFilter={(e) => setFilters(e.filters)}
            globalFilter={globalFilter}
            globalFilterFields={['vulnerabilityID', 'pkgName', 'image', 'title', 'resourceName']}
            filterDisplay="menu"
            onRowDoubleClick={(e) => setSelected(vulnToFinding(e.data as VulnRow))}
            rowClassName={() => 'cursor-pointer'}
            emptyMessage={t(scanning ? 'panels:trivy.scanningImages' : 'panels:trivy.noVulnerabilities')}
            header={
                <div className="flex justify-content-end">
                    <InputText value={globalFilter} onChange={(e) => setGlobalFilter(e.target.value)} placeholder={t('panels:trivy.search')} />
                </div>
            }
        >
            <Column field="severity" header={t('resources:column.severity')} body={(r: VulnRow) => <SeverityTag sev={r.severity} />} sortable filter filterElement={severityFilterTemplate} showFilterMatchModes={false} style={{ width: 110 }} />
            <Column field="vulnerabilityID" header={t('resources:column.vulnerability')} body={cveBody} sortable filter style={{ width: 170 }} />
            <Column field="pkgName" header={t('resources:column.package')} sortable filter />
            <Column field="installedVersion" header={t('resources:column.installed')} style={{ width: 110 }} />
            <Column field="fixedVersion" header={t('resources:column.fixed')} body={fixedBody} style={{ width: 110 }} />
            {showImageColumn && <Column field="image" header={t('resources:column.image')} sortable filter className="cell-mono" style={{ maxWidth: 280 }} />}
            <Column field="resourceKind" header={t('resources:column.kind')} sortable filter style={{ width: 110 }} />
            <Column field="resourceName" header={t('resources:column.resource')} sortable filter />
            <Column field="title" header={t('resources:column.title')} />
        </DataTable>
        <FindingDetailDialog finding={selected} onHide={() => setSelected(null)} />
        </>
    );
}

// ─── useK8sScan hook ──────────────────────────────────────────────────────────

function useK8sScan(clusterName: string, pushToast: PushToast) {
    const t = useT();
    const [misconfigRows, setMisconfigRows] = useState<MisconfigRow[]>([]);
    const [secretRows, setSecretRows] = useState<SecretRow[]>([]);
    const [vulnRows, setVulnRows] = useState<VulnRow[]>([]);
    const [misconfigSummary, setMisconfigSummary] = useState<Record<string, number>>({});
    const [secretSummary, setSecretSummary] = useState<Record<string, number>>({});
    const [vulnSummary, setVulnSummary] = useState<Record<string, number>>({});
    const [scanning, setScanning] = useState(false);
    const [log, setLog] = useState('');
    const [vulnProgress, setVulnProgress] = useState<Progress>(null);
    const [error, setError] = useState('');

    // Stable scanId for the lifetime of this hook instance (one panel = one session)
    const scanId = useMemo(() => Math.random().toString(36).slice(2), []);

    // Wire Wails event listeners once on mount
    useEffect(() => {
        const offProgress = EventsOn(`trivy:k8s:progress:${scanId}`, (p: { phase: string; current: number; total: number; message: string }) => {
            setLog(`[${p.phase}] ${p.message} (${p.current}/${p.total})`);
        });

        const offDone = EventsOn(`trivy:k8s:done:${scanId}`, (result: K8sScanResult) => {
            const mc: MisconfigRow[] = (result.misconfigs || []).map((m, i) => ({
                _uid: `mc|${m.resourceKind}|${m.resourceName}|${m.namespace}|${m.checkID}|${i}`,
                resourceKind: m.resourceKind,
                resourceName: m.resourceName,
                namespace: m.namespace,
                checkID: m.checkID,
                severity: (m.severity || 'UNKNOWN').toUpperCase(),
                title: m.title,
                message: m.message,
                description: m.description || '',
                resolution: m.resolution,
                primaryURL: m.primaryURL || '',
                references: m.references || [],
            }));
            const sc: SecretRow[] = (result.secrets || []).map((s, i) => ({
                _uid: `sec|${s.resourceKind}|${s.resourceName}|${s.namespace}|${s.ruleID}|${i}`,
                resourceKind: s.resourceKind,
                resourceName: s.resourceName,
                namespace: s.namespace,
                ruleID: s.ruleID,
                category: s.category,
                severity: (s.severity || 'UNKNOWN').toUpperCase(),
                title: s.title,
                match: s.match,
            }));
            setMisconfigRows(mc);
            setSecretRows(sc);
            setMisconfigSummary(result.misconfigSummary || {});
            setSecretSummary(result.secretSummary || {});
        });

        const offError = EventsOn(`trivy:k8s:error:${scanId}`, (err: string) => {
            setError(err);
            pushToast('error', t('panels:trivy.toastK8sFailed'), err);
        });

        return () => { offProgress(); offDone(); offError(); };
    }, [scanId]);

    const startScan = async (namespace: string) => {
        setScanning(true);
        setError('');
        setMisconfigRows([]);
        setSecretRows([]);
        setVulnRows([]);
        setMisconfigSummary({});
        setSecretSummary({});
        setVulnSummary({});
        setVulnProgress(null);

        try {
            // Phase 1: misconfig + secret (async via events; runs concurrently with phase 2)
            setLog(`[fetch] ${t('panels:trivy.logStartK8s')}`);
            TrivyStartK8sScan(scanId, clusterName, namespace).catch((e: any) => {
                setError(String(e));
                pushToast('error', t('panels:trivy.toastK8sFailed'), String(e));
            });

            // Phase 2: vulnerability (sequential image scanning)
            setLog(`[vuln] ${t('panels:trivy.logListing')}`);
            let images: models.TrivyK8sImageInfo[] = [];
            try {
                images = await TrivyListPodImagesWithContext(clusterName, namespace);
            } catch (e: any) {
                pushToast('warn', t('panels:trivy.toastListFailed'), String(e));
            }

            if (images.length > 0) {
                const acc: VulnRow[] = [];
                const summ: Record<string, number> = {};
                for (let i = 0; i < images.length; i++) {
                    const imgInfo = images[i];
                    setVulnProgress({ current: i + 1, total: images.length, image: imgInfo.image });
                    setLog(`[vuln] ${t('panels:trivy.logScanning', { image: imgInfo.image, current: i + 1, total: images.length })}${i === 0 ? ` ${t('panels:trivy.logFirstRun')}` : ''}`);
                    try {
                        const res = await TrivyScanImage(clusterName, imgInfo.image);
                        if (res.error) {
                            pushToast('warn', t('panels:trivy.toastScanIssue', { image: imgInfo.image }), res.error);
                        } else {
                            const found = rowsFromResult(imgInfo, res);
                            acc.push(...found);
                            for (const r of found) summ[r.severity] = (summ[r.severity] || 0) + 1;
                            setVulnRows([...acc]);
                            setVulnSummary({ ...summ });
                        }
                    } catch (e: any) {
                        pushToast('error', t('panels:trivy.toastScanFailed', { image: imgInfo.image }), String(e));
                    }
                }
                setLog(`[vuln] ${t('panels:trivy.logDone', { findings: acc.length, images: images.length })}`);
            } else {
                setLog(`[vuln] ${t('panels:trivy.logNoImages')}`);
            }
        } finally {
            setScanning(false);
            setVulnProgress(null);
        }
    };

    const stopScan = () => {
        TrivyStopK8sScan(scanId).catch(() => {});
        setScanning(false);
        setVulnProgress(null);
        setLog(t('panels:trivy.logCancelled'));
    };

    return {
        misconfigRows, secretRows, vulnRows,
        misconfigSummary, secretSummary, vulnSummary,
        scanning, log, vulnProgress, error,
        startScan, stopScan,
    };
}

// ─── useImageScanner (for standalone Image Scan tab) ──────────────────────────

function useImageScanner(clusterName: string, pushToast: PushToast) {
    const t = useT();
    const [rows, setRows] = useState<VulnRow[]>([]);
    const [scanning, setScanning] = useState(false);
    const [progress, setProgress] = useState<Progress>(null);
    const [log, setLog] = useState('');
    const [error, setError] = useState('');

    const scanImages = async (images: string[]) => {
        if (images.length === 0) { setError(t('panels:trivy.logNoImages')); return; }
        setError('');
        setRows([]);
        setScanning(true);
        setLog(`$ trivy image  ${t('panels:trivy.logQueued', { count: images.length })}`);
        const acc: VulnRow[] = [];
        try {
            for (let i = 0; i < images.length; i++) {
                const image = images[i];
                setProgress({ current: i + 1, total: images.length, image });
                setLog(`${t('panels:trivy.logScanning', { image, current: i + 1, total: images.length })}${i === 0 ? ` ${t('panels:trivy.logFirstRun')}` : ''}`);
                try {
                    const res = await TrivyScanImage(clusterName, image);
                    if (res.error) {
                        pushToast('warn', t('panels:trivy.toastScanIssue', { image }), res.error);
                    } else {
                        // plain image scan — no resource context
                        const fakeInfo: models.TrivyK8sImageInfo = { image, resourceKind: '', resourceName: '', namespace: '' };
                        const found = rowsFromResult(fakeInfo, res);
                        acc.push(...found);
                        setRows([...acc]);
                    }
                } catch (e: any) {
                    pushToast('error', t('panels:trivy.toastScanFailed', { image }), String(e));
                }
            }
            setLog(t('panels:trivy.logDone', { findings: acc.length, images: images.length }));
            if (acc.length === 0) pushToast('success', t('panels:trivy.toastNoVulns'));
        } finally {
            setScanning(false);
            setProgress(null);
        }
    };

    return { rows, scanning, progress, log, error, setError, scanImages };
}

// ─── K8s Security Scan Tab ────────────────────────────────────────────────────

function K8sSecurityTab({
    scan,
}: {
    scan: ReturnType<typeof useK8sScan>;
}) {
    const t = useT();
    const {
        misconfigRows, secretRows, vulnRows,
        misconfigSummary, secretSummary, vulnSummary,
        scanning, log, vulnProgress, error,
        startScan, stopScan,
    } = scan;

    const totalFindings = misconfigRows.length + secretRows.length + vulnRows.length;

    return (
        <div className="flex flex-column gap-3">
            {/* Controls — always scans the whole cluster (all namespaces) */}
            <div className="flex flex-wrap align-items-center gap-2">
                {!scanning ? (
                    <Button label={t('panels:trivy.scanCluster')} icon={<VscPlay />} onClick={() => startScan('')} />
                ) : (
                    <Button label={t('panels:trivy.stop')} icon={<VscStopCircle />} severity="danger" outlined onClick={stopScan} />
                )}
                <span className="trivy-muted">{t('panels:trivy.clusterHint')}</span>
            </div>

            {/* Progress */}
            {log && (
                <div className="flex flex-column gap-1">
                    <div className="trivy-console">
                        <span className="trivy-console__prompt">›</span>
                        <span className="trivy-console__text">{log}</span>
                        {scanning && <span className="trivy-console__caret" />}
                    </div>
                    {vulnProgress && (
                        <ProgressBar value={Math.round((vulnProgress.current / vulnProgress.total) * 100)} showValue={false} className="trivy-progress" />
                    )}
                </div>
            )}

            {error && <Message severity="error" text={error} />}

            {/* Summary */}
            {totalFindings > 0 && (
                <SummaryGrid
                    categories={[
                        { label: t('panels:trivy.tabMisconfigs'), counts: misconfigSummary },
                        { label: t('panels:trivy.tabVulnerabilities'), counts: vulnSummary },
                        { label: 'Secrets', counts: secretSummary },
                    ]}
                />
            )}

            {/* Results sub-tabs */}
            <TabView>
                <TabPanel header={`Misconfigs${misconfigRows.length ? ` (${misconfigRows.length})` : ''}`}>
                    <MisconfigTable rows={misconfigRows} scanning={scanning} />
                </TabPanel>
                <TabPanel header={`Vulnerabilities${vulnRows.length ? ` (${vulnRows.length})` : ''}`}>
                    <VulnTable rows={vulnRows} scanning={scanning} showImageColumn />
                </TabPanel>
                <TabPanel header={`Secrets${secretRows.length ? ` (${secretRows.length})` : ''}`}>
                    <SecretTable rows={secretRows} scanning={scanning} />
                </TabPanel>
            </TabView>
        </div>
    );
}

// ─── Image Scan Tab (standalone image scan, unchanged logic) ──────────────────

function ImageScanTab({
    clusterName,
    scanner,
    imageInput,
    setImageInput,
    pushToast,
}: {
    clusterName: string;
    scanner: ReturnType<typeof useImageScanner>;
    imageInput: string;
    setImageInput: (v: string) => void;
    pushToast: PushToast;
}) {
    const t = useT();
    const run = () => {
        const ref = imageInput.trim();
        if (!ref) { pushToast('warn', t('panels:trivy.toastEnterImage'), t('panels:trivy.toastEnterImageHint')); return; }
        scanner.scanImages([ref]);
    };

    const exportHtml = async () => {
        const counts: Record<string, number> = {};
        for (const r of scanner.rows) counts[r.severity] = (counts[r.severity] || 0) + 1;
        const sorted = [...scanner.rows].sort((a, b) => (SEVERITY_ORDER[b.severity] || 0) - (SEVERITY_ORDER[a.severity] || 0));
        const body = sorted.map((r) => {
            const url = vulnUrl(r.vulnerabilityID, r.primaryURL);
            const id = url ? `<a href="${escapeHtml(url)}">${escapeHtml(r.vulnerabilityID)}</a>` : escapeHtml(r.vulnerabilityID);
            return `<tr><td>${escapeHtml(r.severity)}</td><td>${id}</td><td>${escapeHtml(r.pkgName)}</td><td>${escapeHtml(r.installedVersion)}</td><td>${escapeHtml(r.fixedVersion) || '—'}</td><td>${escapeHtml(r.title)}</td></tr>`;
        }).join('\n');
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Vuln report</title></head><body><table><thead><tr><th>Severity</th><th>CVE</th><th>Package</th><th>Installed</th><th>Fixed</th><th>Title</th></tr></thead><tbody>${body}</tbody></table></body></html>`;
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        try { await SaveReport(`vuln-report-image-${clusterName}-${stamp}.html`, html); } catch { /* ignore */ }
    };

    const summary = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const r of scanner.rows) counts[r.severity] = (counts[r.severity] || 0) + 1;
        return counts;
    }, [scanner.rows]);

    return (
        <div className="flex flex-column gap-3">
            <Message severity="info" text={t('panels:trivy.dbHint')} />
            {scanner.error && <Message severity="error" text={scanner.error} />}

            <div className="flex flex-wrap align-items-center gap-2">
                <InputText
                    value={imageInput}
                    onChange={(e) => setImageInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && run()}
                    placeholder={t('panels:trivy.imagePlaceholder')}
                    disabled={scanner.scanning}
                    style={{ minWidth: 280 }}
                />
                <Button label={t('panels:trivy.scanImage')} icon={<VscPlay />} onClick={run} loading={scanner.scanning} />
            </div>

            {scanner.scanning && scanner.progress && (
                <div className="flex flex-column gap-1">
                    <div className="trivy-console">
                        <span className="trivy-console__prompt">›</span>
                        <span className="trivy-console__text">{scanner.log}</span>
                        <span className="trivy-console__caret" />
                    </div>
                    <ProgressBar value={Math.round((scanner.progress.current / scanner.progress.total) * 100)} showValue={false} className="trivy-progress" />
                </div>
            )}

            {scanner.rows.length > 0 && (
                <div className="trivy-tally">
                    {SEVERITIES.map((s) => summary[s] ? (
                        <span key={s} className="trivy-tally__item"><SeverityTag sev={s} /><span className="cell-count">{summary[s]}</span></span>
                    ) : null)}
                    <span className="trivy-tally__item trivy-tally__item--total">{t('panels:trivy.total')} <span className="cell-count">{scanner.rows.length}</span></span>
                </div>
            )}

            <div className="flex justify-content-end">
                <Button
                    label={t('panels:trivy.exportHtml')}
                    icon={<VscExport />}
                    outlined
                    size="small"
                    disabled={scanner.rows.length === 0}
                    onClick={exportHtml}
                />
            </div>

            <VulnTable rows={scanner.rows} scanning={scanner.scanning} showImageColumn={false} />
        </div>
    );
}

// ─── Root component ───────────────────────────────────────────────────────────

export default function TrivyScanner({ clusterName }: { clusterName: string }) {
    const t = useT();
    const toast = useRef<Toast | null>(null);
    const pushToast: PushToast = (severity, summary, detail) =>
        toast.current?.show({ severity, summary, detail, life: 4000 });

    // Scan state is lifted here so it survives switching between the top-level
    // tabs — PrimeReact's TabView unmounts the inactive panel, which would
    // otherwise destroy the hook, stop the running scan and clear the tables.
    const [imageInput, setImageInput] = useState('');
    const k8sScan = useK8sScan(clusterName, pushToast);
    const imageScanner = useImageScanner(clusterName, pushToast);

    return (
        <div className="trivy-root">
            <Toast ref={toast} />

            <div className="mon-header">
                <VscShield /> <span>{t('panels:trivy.title')}</span>
                {clusterName && <span className="mon-cluster">{clusterName}</span>}
            </div>

            <TabView>
                <TabPanel header={t('panels:trivy.tab.cluster')}>
                    <K8sSecurityTab scan={k8sScan} />
                </TabPanel>
                <TabPanel header={t('panels:trivy.tab.image')}>
                    <ImageScanTab
                        clusterName={clusterName}
                        scanner={imageScanner}
                        imageInput={imageInput}
                        setImageInput={setImageInput}
                        pushToast={pushToast}
                    />
                </TabPanel>
            </TabView>
        </div>
    );
}
