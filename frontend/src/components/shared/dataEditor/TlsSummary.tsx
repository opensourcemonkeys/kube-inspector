import { useEffect, useState } from 'react';
import { InspectTlsPair } from '../../../../wailsjs/go/controller_app/App';
import type { models } from '../../../../wailsjs/go/models';
import { useT } from '../../../i18n/useT';
import StatusLamp from '../StatusLamp';
import { textToBase64 } from './dataEditorModel';

const DAY = 86_400_000;
const SOON_DAYS = 30;

/**
 * What a kubernetes.io/tls Secret's certificate says and whether its key
 * belongs to it, read from the draft as it is typed or loaded from a file.
 */
export default function TlsSummary({ cert, keyPem }: { cert: string; keyPem: string }) {
    const t = useT();
    const [info, setInfo] = useState<models.TlsInfo | null>(null);

    useEffect(() => {
        let stale = false;
        const timer = window.setTimeout(() => {
            InspectTlsPair(textToBase64(cert), keyPem ? textToBase64(keyPem) : '')
                .then((i) => { if (!stale) setInfo(i); })
                .catch(() => { if (!stale) setInfo(null); });
        }, 400);
        return () => { stale = true; window.clearTimeout(timer); };
    }, [cert, keyPem]);

    if (!info) return null;
    if (info.error) {
        return (
            <div className="de-tls">
                <StatusLamp tone="err" label={t('panels:dataEditor.tls.unreadable')} />
                <p className="dlg-error">{info.error}</p>
            </div>
        );
    }

    const daysLeft = Math.floor((Date.parse(info.notAfter) - Date.now()) / DAY);
    const validity = daysLeft < 0
        ? <StatusLamp tone="err" label={t('panels:dataEditor.tls.expired')} />
        : <StatusLamp tone={daysLeft < SOON_DAYS ? 'warn' : 'ok'} label={t('panels:dataEditor.tls.daysLeft', { count: daysLeft })} />;

    return (
        <div className="de-tls">
            <dl className="dlg-facts">
                <dt>{t('panels:dataEditor.tls.subject')}</dt><dd className="dlg-facts__mono">{info.subject}</dd>
                <dt>{t('panels:dataEditor.tls.issuer')}</dt><dd className="dlg-facts__mono">{info.issuer}</dd>
                {info.dnsNames.length > 0 && (<><dt>{t('panels:dataEditor.tls.names')}</dt><dd className="dlg-facts__mono">{info.dnsNames.join(', ')}</dd></>)}
                <dt>{t('panels:dataEditor.tls.validUntil')}</dt><dd><span className="dlg-facts__mono">{info.notAfter.slice(0, 10)}</span> {validity}</dd>
                <dt>{t('panels:dataEditor.tls.key')}</dt>
                <dd>
                    {info.keyMatches
                        ? <StatusLamp tone="ok" label={t('panels:dataEditor.tls.keyMatches')} />
                        : <StatusLamp tone="err" label={t('panels:dataEditor.tls.keyMismatch')} title={info.keyError} />}
                </dd>
            </dl>
        </div>
    );
}
