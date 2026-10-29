import { useState } from 'react';
import { VscCheck, VscCopy, VscLinkExternal } from 'react-icons/vsc';
import { Button } from 'primereact/button';
import { BrowserOpenURL } from '../../../wailsjs/runtime/runtime';
import { useT } from '../../i18n/useT';
import RowAction from '../shared/RowAction';

/** Where CI publishes the chart (.github/workflows/toolbox.yml). */
const CHART = 'oci://ghcr.io/opensourcemonkeys/charts/toolbox';
/** The documentation's install page (docs/toolbox/index.md). */
const GUIDE = 'https://kubeinspector.com/toolbox/';

/** Single-quotes a value for a POSIX shell. */
const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * How to install toolbox, shown in place of the history tool's state when it
 * is not on the cluster. The cluster name is filled in: it is the name toolbox
 * tags its rows with, and one ClickHouse may hold several clusters.
 */
export default function InstallGuide({ clusterName }: { clusterName: string }) {
    const t = useT();
    const [copied, setCopied] = useState(false);
    const command = [
        `helm install toolbox ${CHART} \\`,
        '  --namespace toolbox --create-namespace \\',
        `  --set-string clusterName=${shellQuote(clusterName)}`,
    ].join('\n');

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
        } catch {
            /* clipboard unavailable — the command is selectable either way */
        }
    };

    return (
        <div className="tool-install">
            <p className="tool-install__step">{t('panels:toolbox.install.intro')}</p>
            <div className="tool-install__cmd">
                <pre className="dark-display">{command}</pre>
                <RowAction icon={copied ? <VscCheck size={14} /> : <VscCopy size={14} />}
                    label={t(copied ? 'panels:toolbox.install.copied' : 'panels:toolbox.install.copy')} onClick={() => void copy()} />
            </div>
            <p className="tool-install__step">{t('panels:toolbox.install.audit')}</p>
            <p className="tool-install__note">{t('panels:toolbox.install.managed')}</p>
            <div>
                <Button label={t('panels:toolbox.install.guide')} icon={<VscLinkExternal size={14} />} text size="small" onClick={() => BrowserOpenURL(GUIDE)} />
            </div>
        </div>
    );
}
