import { useEffect, useMemo, useRef, useState } from 'react';
import { VscClose, VscPass } from 'react-icons/vsc';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { Calendar } from 'primereact/calendar';
import { InputTextarea } from 'primereact/inputtextarea';
import { TrivyAddException } from '../../../../wailsjs/go/controller_app/App';
import { models } from '../../../../wailsjs/go/models';
import { errText } from '../../../lib/errText';
import { useT } from '../../../i18n/useT';
import { defaultExpiryDate, endOfDayRFC3339 } from './trivyModel';

/** What the dialog accepts: lines naming the scope, and how to turn reason + expiry into exceptions. */
export interface AcceptRequest {
    subject: string[];
    build: (reason: string, expiresAt: string) => models.TrivyException[];
}

const MAX_SUBJECT_LINES = 12;
const DATE_FORMAT = 'yy-mm-dd';

/**
 * Accepting a risk: a reason (required) and an expiry (required, today + 90
 * days by default, never in the past). Saving stores one exception per scope
 * the request builds, then the caller reloads the view.
 */
export default function AcceptRiskDialog({ clusterName, request, onHide, onSaved }: {
    clusterName: string;
    request: AcceptRequest | null;
    onHide: () => void;
    onSaved: (count: number) => void;
}) {
    const t = useT();
    const [reason, setReason] = useState('');
    const [expires, setExpires] = useState<Date | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Exceptions of this request already stored: a retry after a partial
    // failure continues from there instead of storing duplicates.
    const stored = useRef(0);

    useEffect(() => {
        if (!request) return;
        stored.current = 0;
        setReason('');
        setExpires(defaultExpiryDate());
        setError(null);
    }, [request]);

    const today = new Date();
    const minDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    // How many exceptions saving would create; zero when everything is already accepted.
    const count = useMemo(() => (request ? request.build('-', endOfDayRFC3339(new Date())).length : 0), [request]);
    const valid = reason.trim() !== '' && expires != null && count > 0;

    const close = () => { if (!busy) onHide(); };

    const save = async () => {
        if (!request || !expires || !valid) return;
        setBusy(true);
        setError(null);
        const list = request.build(reason, endOfDayRFC3339(expires));
        let saved = 0;
        try {
            for (const e of list.slice(stored.current)) {
                await TrivyAddException(clusterName, e);
                stored.current++;
                saved++;
            }
            onSaved(saved);
            onHide();
        } catch (e) {
            setError(errText(e));
            if (saved > 0) onSaved(saved);
        } finally {
            setBusy(false);
        }
    };

    const subject = request?.subject ?? [];
    return (
        <Dialog
            header={t('panels:trivy.accept.title')}
            visible={!!request}
            className="trivy-accept-dialog"
            modal
            onHide={close}
            footer={
                <div className="dlg-actions">
                    <Button label={t('action.cancel')} icon={<VscClose size={16} />} text onClick={close} disabled={busy} />
                    <Button label={t('panels:trivy.accept.save')} icon={<VscPass size={16} />} onClick={save} loading={busy} disabled={!valid} />
                </div>
            }
        >
            <div className="dlg-form">
                <div className="dlg-field">
                    <span className="dlg-label">{t('panels:trivy.accept.scope')}</span>
                    <ul className="trivy-accept__scope">
                        {subject.slice(0, MAX_SUBJECT_LINES).map((s) => <li key={s}>{s}</li>)}
                        {subject.length > MAX_SUBJECT_LINES && (
                            <li className="trivy-muted">{t('panels:trivy.fix.more', { count: subject.length - MAX_SUBJECT_LINES })}</li>
                        )}
                    </ul>
                    {count === 0
                        ? <p className="dlg-note">{t('panels:trivy.accept.nothing')}</p>
                        : <p className="dlg-note">{t('panels:trivy.accept.count', { count })}</p>}
                </div>
                <div className="dlg-field">
                    <label htmlFor="trivy-accept-reason" className="dlg-label">{t('panels:trivy.accept.reason')}</label>
                    <InputTextarea id="trivy-accept-reason" value={reason} rows={3} autoResize autoFocus
                        placeholder={t('panels:trivy.accept.reasonPlaceholder')}
                        onChange={(e) => setReason(e.target.value)} />
                </div>
                <div className="dlg-field">
                    <label htmlFor="trivy-accept-expires" className="dlg-label">{t('panels:trivy.accept.expires')}</label>
                    <Calendar inputId="trivy-accept-expires" value={expires} minDate={minDate} dateFormat={DATE_FORMAT} readOnlyInput showIcon
                        onChange={(e) => setExpires((e.value as Date | null) ?? null)} />
                </div>
                <p className="dlg-note">{t('panels:trivy.accept.note')}</p>
                {error && <p className="dlg-error" role="alert">{error}</p>}
            </div>
        </Dialog>
    );
}
