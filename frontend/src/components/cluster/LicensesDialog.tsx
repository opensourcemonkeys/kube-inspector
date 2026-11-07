import { useEffect, useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { GetThirdPartyNotices } from '../../../wailsjs/go/controller_app/App';
import Spinner from '../shared/Spinner';
import { useT } from '../../i18n/useT';

interface Props {
    visible: boolean;
    onHide: () => void;
}

/**
 * The third-party notices the binary embeds (internal/business/notices.go):
 * every licence text and NOTICE file the MIT, BSD and Apache dependencies
 * require to travel with it. About 1 MB, so it is fetched on first open and
 * kept, and shown as one preformatted block — the texts are plain text and
 * their line breaks are part of them.
 */
export default function LicensesDialog({ visible, onHide }: Props) {
    const t = useT();
    // undefined = not fetched yet, "" = a build without notices.
    const [text, setText] = useState<string | undefined>(undefined);

    useEffect(() => {
        if (visible && text === undefined) {
            GetThirdPartyNotices().then(setText).catch(() => setText(''));
        }
    }, [visible, text]);

    const footer = (
        <div className="dlg-actions">
            <Button label={t('panels:about.close')} severity="secondary" size="small" onClick={onHide} />
        </div>
    );

    return (
        <Dialog
            visible={visible}
            onHide={onHide}
            header={t('panels:about.licensesTitle')}
            footer={footer}
            modal
            dismissableMask
            className="licenses-dialog"
        >
            <p className="about-modal__desc">{t('panels:about.licensesIntro')}</p>
            {text === undefined && <Spinner label={t('common:status.loading')} />}
            {text === '' && <p className="dlg-note">{t('panels:about.licensesMissing')}</p>}
            {text && <pre className="licenses-dialog__text" tabIndex={0}>{text}</pre>}
        </Dialog>
    );
}
