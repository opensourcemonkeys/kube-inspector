import { useState } from 'react';
import { Button } from 'primereact/button';
import { InputText } from 'primereact/inputtext';
import { VscAdd, VscClose, VscEye, VscEyeClosed } from 'react-icons/vsc';
import { useT } from '../../../i18n/useT';
import RowAction from '../RowAction';
import { buildDockerConfig, nextEntryId, type Registry } from './dataEditorModel';

// Credentials, not form history: the browser must not offer to fill these.
const NO_AUTOFILL = 'off';
const REGISTRY_EXAMPLE = 'ghcr.io';

function SecretInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    const t = useT();
    const [shown, setShown] = useState(false);
    return (
        <span className="de-secret-input">
            <InputText type={shown ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={NO_AUTOFILL} />
            <RowAction icon={shown ? <VscEyeClosed size={15} /> : <VscEye size={15} />}
                label={t(shown ? 'panels:dataEditor.hide' : 'panels:dataEditor.show')} onClick={() => setShown((v) => !v)} />
        </span>
    );
}

/**
 * A kubernetes.io/dockerconfigjson value as registry rows. Every edit writes
 * the JSON back (auth included), so the raw editor and the save always see
 * the same document. The caller only shows this when parseDockerConfig could
 * read the value without losing anything.
 */
export default function DockerConfigForm({ initial, readOnly, onChange }: {
    initial: Registry[];
    readOnly: boolean;
    onChange: (json: string) => void;
}) {
    const t = useT();
    const [rows, setRows] = useState<Registry[]>(initial);

    const commit = (next: Registry[]) => {
        setRows(next);
        onChange(buildDockerConfig(next));
    };
    const patch = (id: number, p: Partial<Registry>) => commit(rows.map((r) => (r.id === id ? { ...r, ...p } : r)));

    return (
        <div className="de-docker">
            {rows.map((r) => (
                <fieldset key={r.id} className="de-docker__row" disabled={readOnly}>
                    <label className="dlg-field">
                        <span className="dlg-label">{t('panels:dataEditor.docker.server')}</span>
                        <InputText value={r.server} onChange={(e) => patch(r.id, { server: e.target.value })} placeholder={REGISTRY_EXAMPLE} />
                    </label>
                    <label className="dlg-field">
                        <span className="dlg-label">{t('panels:dataEditor.docker.username')}</span>
                        <InputText value={r.username} onChange={(e) => patch(r.id, { username: e.target.value })} autoComplete={NO_AUTOFILL} />
                    </label>
                    <label className="dlg-field">
                        <span className="dlg-label">{t('panels:dataEditor.docker.password')}</span>
                        <SecretInput value={r.password} onChange={(password) => patch(r.id, { password })} />
                    </label>
                    <label className="dlg-field">
                        <span className="dlg-label">{t('panels:dataEditor.docker.email')}</span>
                        <InputText value={r.email} onChange={(e) => patch(r.id, { email: e.target.value })} />
                    </label>
                    <RowAction icon={<VscClose size={15} />} label={t('panels:dataEditor.docker.remove')} severity="danger"
                        disabled={readOnly} onClick={() => commit(rows.filter((x) => x.id !== r.id))} />
                </fieldset>
            ))}
            {rows.length === 0 && <p className="dlg-note">{t('panels:dataEditor.docker.empty')}</p>}
            <div>
                <Button label={t('panels:dataEditor.docker.add')} icon={<VscAdd size={14} />} outlined size="small" disabled={readOnly}
                    onClick={() => commit([...rows, { id: nextEntryId(), server: '', username: '', password: '', email: '' }])} />
            </div>
        </div>
    );
}
