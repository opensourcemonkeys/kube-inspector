import { useEffect, useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { GetAppInfo } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useT } from '../../i18n/useT';

interface Props {
    visible: boolean;
    onHide: () => void;
    /** Opens the Diagnostics panel. Omitted, the button is not rendered. */
    onDiagnostics?: () => void;
}

const DEP_LABELS: Record<string, string> = {
    'github.com/wailsapp/wails/v2': 'Wails',
    'k8s.io/client-go': 'client-go',
    'k8s.io/api': 'k8s API',
    'k8s.io/apimachinery': 'k8s Apimachinery',
    'github.com/creack/pty': 'PTY',
    'sigs.k8s.io/yaml': 'YAML',
};

/**
 * What is running, as a plain fact sheet: the same dialog frame as every other
 * dialog, the version first and in mono because it is what gets copied into a
 * bug report. No centred logo-in-a-box, no version pill.
 */
export default function AboutModal({ visible, onHide, onDiagnostics }: Props) {
    const t = useT();
    const [info, setInfo] = useState<models.AppInfo | null>(null);

    useEffect(() => {
        if (visible && !info) {
            GetAppInfo().then(setInfo);
        }
    }, [visible]);

    const footer = (
        <div className="dlg-actions">
            {onDiagnostics && (
                <Button label={t('panels:about.diagnostics')} text size="small" onClick={() => { onHide(); onDiagnostics(); }} />
            )}
            <Button label={t('panels:about.close')} severity="secondary" size="small" onClick={onHide} />
        </div>
    );

    return (
        <Dialog
            visible={visible}
            onHide={onHide}
            header={t('panels:about.title')}
            footer={footer}
            modal
            dismissableMask
            className="about-modal"
        >
            <p className="about-modal__desc">{t('panels:about.description')}</p>

            <dl className="dlg-facts">
                <dt>{t('panels:about.version')}</dt>
                <dd className="dlg-facts__mono">{info?.app_version ?? '—'}</dd>
                <dt>{t('panels:about.author')}</dt>
                {/* eslint-disable-next-line i18next/no-literal-string -- a person's name */}
                <dd>Hakan Yorulmaz</dd>
                {info && (
                    <>
                        <dt>Go</dt>
                        <dd className="dlg-facts__mono">{info.go_version}</dd>
                    </>
                )}
            </dl>

            {(info?.dependencies?.length ?? 0) > 0 && (
                <>
                    <h3 className="dlg-section">{t('panels:about.dependencies')}</h3>
                    <dl className="dlg-facts">
                        {info!.dependencies.map((dep) => (
                            <div key={dep.name} className="dlg-facts__row">
                                <dt>{DEP_LABELS[dep.name] ?? dep.name.split('/').pop()}</dt>
                                <dd className="dlg-facts__mono">{dep.version}</dd>
                            </div>
                        ))}
                    </dl>
                </>
            )}
        </Dialog>
    );
}
