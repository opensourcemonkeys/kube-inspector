import { useMemo, useState } from 'react';
import { TabView, TabPanel } from 'primereact/tabview';
import { InputSwitch } from 'primereact/inputswitch';
import { models } from '../../../../wailsjs/go/models';
import { useT } from '../../../i18n/useT';
import FindingDetailDialog, { DetailFinding, misconfigToFinding, secretToFinding, vulnToFinding } from './FindingDetailDialog';
import { MisconfigTable, SecretTable, VulnTable } from './findingTables';
import type { AcceptRequest } from './AcceptRiskDialog';
import { misconfigException, vulnException } from './trivyModel';

const label = (n: number, text: string) => (n ? `${text} (${n})` : text);

function filterRows<R extends { isNew: boolean; accepted?: boolean }>(rows: R[] | null | undefined, showAccepted: boolean, newOnly: boolean): R[] {
    return (rows ?? []).filter((r) => (showAccepted || !r.accepted) && (!newOnly || r.isNew));
}

/**
 * The full finding lists of the viewed scan: misconfigurations, image
 * vulnerabilities and secrets. Accepted findings are hidden unless asked for
 * (then shown muted); "only new" keeps what the comparison marked new.
 */
export default function FindingsView({ view, onlyNew, setOnlyNew, onAccept }: {
    view: models.TrivyScanView;
    onlyNew: boolean;
    setOnlyNew: (v: boolean) => void;
    onAccept: (req: AcceptRequest) => void;
}) {
    const t = useT();
    const [showAccepted, setShowAccepted] = useState(false);
    const [detail, setDetail] = useState<DetailFinding | null>(null);
    const compared = !!view.changes;
    const newOnly = compared && onlyNew;

    const misconfigs = useMemo(() => filterRows(view.misconfigs, showAccepted, newOnly), [view, showAccepted, newOnly]);
    const vulns = useMemo(() => filterRows(view.vulns, showAccepted, newOnly), [view, showAccepted, newOnly]);
    const secrets = useMemo(() => filterRows(view.secrets, showAccepted, newOnly), [view, showAccepted, newOnly]);

    const acceptVuln = (r: models.TrivyVulnRow) => onAccept({
        subject: [`${r.vulnerabilityID} · ${r.imageRepo}`],
        build: (reason, expiresAt) => [vulnException(r, reason, expiresAt)],
    });
    const acceptMisconfig = (r: models.TrivyMisconfigRow) => onAccept({
        subject: [`${r.checkID} · ${r.resourceKind} ${r.namespace ? `${r.namespace}/` : ''}${r.resourceName}`],
        build: (reason, expiresAt) => [misconfigException(r, reason, expiresAt)],
    });

    const empty = t(newOnly ? 'panels:trivy.findings.noneNew' : 'panels:trivy.findings.none');

    return (
        <div className="trivy-findings">
            <div className="trivy-findings__filters">
                {compared && (
                    <label className="trivy-switch">
                        <InputSwitch checked={newOnly} onChange={(e) => setOnlyNew(!!e.value)} />
                        <span>{t('panels:trivy.findings.onlyNew')}</span>
                    </label>
                )}
                <label className="trivy-switch">
                    <InputSwitch checked={showAccepted} onChange={(e) => setShowAccepted(!!e.value)} />
                    <span>{t('panels:trivy.findings.showAccepted')}</span>
                </label>
            </div>
            <TabView>
                <TabPanel header={label(misconfigs.length, t('panels:trivy.tabMisconfigs'))}>
                    <MisconfigTable rows={misconfigs} empty={empty}
                        onOpen={(r) => setDetail(misconfigToFinding(r, () => acceptMisconfig(r)))} />
                </TabPanel>
                <TabPanel header={label(vulns.length, t('panels:trivy.tabVulnerabilities'))}>
                    <VulnTable rows={vulns} empty={empty} cluster
                        onOpen={(r) => setDetail(vulnToFinding(r, r.imageRepo ? () => acceptVuln(r) : undefined))} />
                </TabPanel>
                <TabPanel header={label(secrets.length, t('panels:trivy.tabSecrets'))}>
                    <SecretTable rows={secrets} empty={empty} onOpen={(r) => setDetail(secretToFinding(r))} />
                </TabPanel>
            </TabView>
            <FindingDetailDialog finding={detail} onHide={() => setDetail(null)} />
        </div>
    );
}
