import { useEffect, useMemo, useState } from 'react';
import { Button } from 'primereact/button';
import { Dropdown } from 'primereact/dropdown';
import { InputNumber } from 'primereact/inputnumber';
import { InputText } from 'primereact/inputtext';
import { MultiSelect } from 'primereact/multiselect';
import { GetNamespaces, MigrationList } from '../../../../wailsjs/go/controller_app/App';
import { models } from '../../../../wailsjs/go/models';
import { useClusterContext } from '../../../contexts/ClusterContext';
import { useT } from '../../../i18n/useT';
import { errText } from '../../../lib/errText';
import StatusLamp from '../../shared/StatusLamp';
import ClusterName from './ClusterName';
import { phaseTone, SYSTEM_NAMESPACES } from './migrationModel';

/** Chooses what moves where. Nothing is read from the target until the check. */
export default function MigrationSetup({ source, draft, onCheck, onOpen }: {
    source: string;
    draft: models.MigrationRequest | null;
    onCheck: (request: models.MigrationRequest) => void;
    onOpen: (id: string) => void;
}) {
    const t = useT();
    const { clusters } = useClusterContext();
    const targets = useMemo(() => clusters.filter((c) => c !== source), [clusters, source]);
    const [target, setTarget] = useState(draft?.target ?? '');
    const [namespaces, setNamespaces] = useState<string[]>(draft?.namespaces ?? []);
    const [bandwidth, setBandwidth] = useState<number>(draft?.bandwidthKBps ?? 0);
    const [image, setImage] = useState(draft?.moverImage ?? '');
    const [available, setAvailable] = useState<string[]>([]);
    const [past, setPast] = useState<models.MigrationMeta[]>([]);
    const [error, setError] = useState('');

    useEffect(() => {
        let stale = false;
        GetNamespaces(source)
            .then((list) => {
                if (!stale) setAvailable((list ?? []).map((n) => n.name).filter((n) => !SYSTEM_NAMESPACES.has(n)));
            })
            .catch((e) => { if (!stale) setError(errText(e)); });
        MigrationList(source).then((list) => { if (!stale) setPast(list ?? []); }).catch(() => {});
        return () => { stale = true; };
    }, [source]);

    const check = () => onCheck(models.MigrationRequest.createFrom({
        source, target, namespaces, bandwidthKBps: bandwidth, moverImage: image.trim(),
        storageClasses: draft?.storageClasses ?? {}, decisions: {},
    }));

    return (
        <div className="mig-body">
            <p className="tool-panel__intro">{t('panels:migration.setup.intro')}</p>
            <div className="dlg-form mig-form">
                <div className="dlg-field">
                    <span className="dlg-label">{t('panels:migration.setup.source')}</span>
                    <ClusterName name={source} />
                </div>
                <div className="dlg-field">
                    <label htmlFor="mig-target" className="dlg-label">{t('panels:migration.setup.target')}</label>
                    <Dropdown inputId="mig-target" value={target} options={targets} onChange={(e) => setTarget(e.value)}
                        placeholder={t('panels:migration.setup.targetPlaceholder')} />
                </div>
                <div className="dlg-field">
                    <label htmlFor="mig-ns" className="dlg-label">{t('panels:migration.setup.namespaces')}</label>
                    <MultiSelect inputId="mig-ns" value={namespaces} options={available} onChange={(e) => setNamespaces(e.value)}
                        placeholder={t('panels:migration.setup.namespacesPlaceholder')} filter display="chip" />
                </div>
                <div className="dlg-field">
                    <label htmlFor="mig-bw" className="dlg-label">{t('panels:migration.setup.bandwidth')}</label>
                    <InputNumber inputId="mig-bw" value={bandwidth} min={0} onValueChange={(e) => setBandwidth(e.value ?? 0)} />
                </div>
                <div className="dlg-field">
                    <label htmlFor="mig-image" className="dlg-label">{t('panels:migration.setup.image')}</label>
                    <InputText id="mig-image" value={image} onChange={(e) => setImage(e.target.value)} />
                    <span className="dlg-note">{t('panels:migration.setup.imageHint')}</span>
                </div>
                {error && <p className="dlg-error">{error}</p>}
                <div className="dlg-actions">
                    <Button label={t('panels:migration.setup.check')} disabled={!target || namespaces.length === 0} onClick={check} />
                </div>
            </div>
            {past.length > 0 && (
                <section className="mig-section">
                    <h3 className="mig-section__title">{t('panels:migration.setup.past')}</h3>
                    <table className="mig-table">
                        <tbody>
                            {past.map((m) => (
                                <tr key={m.id}>
                                    <td><ClusterName name={m.target} /></td>
                                    <td className="cell-mono">{m.namespaces.join(', ')}</td>
                                    <td>{new Date(m.createdAt).toLocaleString()}</td>
                                    <td><StatusLamp label={t(`panels:migration.phase.${m.phase}` as never)} tone={phaseTone(m.phase)} /></td>
                                    <td className="mig-table__end">
                                        <Button label={t('panels:migration.setup.open')} text size="small" onClick={() => onOpen(m.id)} />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}
        </div>
    );
}
