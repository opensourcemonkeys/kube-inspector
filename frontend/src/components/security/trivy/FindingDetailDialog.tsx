import { VscLinkExternal, VscPass } from 'react-icons/vsc';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { BrowserOpenURL } from '../../../../wailsjs/runtime/runtime';
import { models } from '../../../../wailsjs/go/models';
import { useT } from '../../../i18n/useT';
import { SeverityTag } from './severity';

export type DetailFinding = {
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
    accepted: boolean;
    /** Accept the risk; absent for secrets, which are rotated, never accepted. */
    onAccept?: () => void;
};

export function vulnUrl(id: string, primaryURL: string): string {
    if (/^CVE-\d{4}-\d+$/i.test(id || '')) {
        return `https://www.cve.org/CVERecord?id=${id.toUpperCase()}`;
    }
    return primaryURL || '';
}

// Trivy does not provide remediation for detected secrets, so we surface curated
// guidance keyed by the secret category (falling back to generic advice).
function secretRemediation(category: string): string {
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

export function misconfigToFinding(r: models.TrivyMisconfigRow, onAccept?: () => void): DetailFinding {
    return {
        kind: 'misconfig',
        severity: r.severity,
        title: r.title,
        idLabel: r.checkID,
        resource: { kind: r.resourceKind, name: r.resourceName, namespace: r.namespace },
        description: r.description,
        details: r.message,
        recommendation: r.resolution,
        references: r.references ?? [],
        externalUrl: r.primaryURL,
        accepted: r.accepted,
        onAccept,
    };
}

export function secretToFinding(r: models.TrivySecretRow): DetailFinding {
    const masked = r.match ? r.match.replace(/.(?=.{4})/g, '*') : '';
    return {
        kind: 'secret',
        severity: r.severity,
        title: r.title,
        idLabel: r.ruleID,
        resource: { kind: r.resourceKind, name: r.resourceName, namespace: r.namespace },
        description: r.category ? `Detected secret category: ${r.category}` : '',
        details: masked ? `Match: ${masked}` : '',
        recommendation: secretRemediation(r.category),
        references: [],
        externalUrl: '',
        accepted: false,
    };
}

export function vulnToFinding(r: models.TrivyVulnRow, onAccept?: () => void): DetailFinding {
    const recommendation = r.fixedVersion
        ? `Upgrade package "${r.pkgName}" from ${r.installedVersion || '?'} to ${r.fixedVersion} (or later).`
        : 'No fixed version is available yet. Track the advisory below and apply a fix when released, or mitigate by restricting exposure.';
    const details = [
        `Package: ${r.pkgName}`,
        `Installed: ${r.installedVersion || '—'}`,
        `Fixed: ${r.fixedVersion || '—'}`,
        r.image ? `Image: ${r.image}` : '',
        r.publishedDate ? `Published: ${r.publishedDate}` : '',
    ].filter(Boolean).join('\n');
    return {
        kind: 'vuln',
        severity: r.severity,
        title: r.title,
        idLabel: r.vulnerabilityID,
        resource: { kind: r.workload?.kind ?? '', name: r.workload?.name ?? '', namespace: r.workload?.namespace ?? '' },
        description: r.description,
        details,
        recommendation,
        references: r.references ?? [],
        externalUrl: vulnUrl(r.vulnerabilityID, r.primaryURL),
        accepted: r.accepted,
        onAccept,
    };
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
    if (!value) return null;
    return (
        <div className="trivy-detail">
            <span className="trivy-detail__label">{label}</span>
            <span className={`trivy-detail__value${mono ? ' trivy-detail__value--mono' : ''}`}>{value}</span>
        </div>
    );
}

export default function FindingDetailDialog({ finding, onHide }: { finding: DetailFinding | null; onHide: () => void }) {
    const t = useT();
    if (!finding) return null;
    const res = finding.resource;
    const resourceLine = [res.kind, res.namespace ? `${res.namespace}/${res.name}` : res.name]
        .filter(Boolean)
        .join(' ');
    const canAccept = finding.kind !== 'secret' && !!finding.onAccept && !finding.accepted;
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
            footer={canAccept || finding.accepted ? (
                <div className="dlg-actions">
                    {finding.accepted && <span className="trivy-muted trivy-detail__accepted">{t('panels:trivy.findings.acceptedNote')}</span>}
                    {canAccept && (
                        <Button label={t('panels:trivy.fix.accept')} icon={<VscPass className="mr-2" />} severity="secondary" outlined
                            onClick={() => { const accept = finding.onAccept; onHide(); accept?.(); }} />
                    )}
                </div>
            ) : undefined}
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
