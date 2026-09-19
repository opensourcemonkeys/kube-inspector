import { useEffect, useRef, useState } from 'react';
import { IDockviewPanelProps } from 'dockview';






import { VscEye, VscEyeClosed, VscClose, VscAdd, VscDiscard, VscCheck, VscLock } from 'react-icons/vsc';
import { Button } from 'primereact/button';
import { Column, ColumnEditorOptions, ColumnEvent } from 'primereact/column';
import { DataTable } from 'primereact/datatable';
import { InputText } from 'primereact/inputtext';
import { InputTextarea } from 'primereact/inputtextarea';
import { Toast } from 'primereact/toast';
import { GetSecretData, UpdateSecretData } from '../../../wailsjs/go/controller_app/App';
import { useT } from '../../i18n/useT';
import { ACTION_COLUMN_PROPS } from '../shared/actionColumn';

interface SecretEditorPanelParams {
    clusterName: string;
    name: string;
    namespace: string;
}

interface KeyValueRow {
    id: number;
    key: string;
    value: string;
}

let rowCounter = 0;
const nextId = () => ++rowCounter;

const dataToRows = (data: Record<string, string>): KeyValueRow[] =>
    Object.entries(data)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => ({ id: nextId(), key, value }));

const rowsEqual = (a: KeyValueRow[], b: KeyValueRow[]) => {
    if (a.length !== b.length) return false;
    return a.every((row, i) => row.key === b[i].key && row.value === b[i].value);
};

function PasswordTextarea({ value, onChange }: { value: string; onChange: (val: string) => void }) {
    const [visible, setVisible] = useState(false);

    return (
        <div style={{ position: 'relative', width: '100%' }}>
            <InputTextarea
                value={value}
                onChange={(e) => onChange(e.target.value)}
                autoResize
                rows={3}
                style={{
                    fontFamily: 'monospace',
                    fontSize: '0.85rem',
                    width: '100%',
                    minHeight: '72px',
                    paddingRight: '2.25rem',
                    ...(!visible ? { WebkitTextSecurity: 'disc' } as React.CSSProperties : {}),
                }}
            />
            <Button
                icon={visible ? <VscEyeClosed size={16} /> : <VscEye size={16} />}
                text
                size="small"
                severity="secondary"
                onClick={() => setVisible(v => !v)}
                style={{ position: 'absolute', top: '0.3rem', right: '0.25rem', padding: '0.25rem' }}
            />
        </div>
    );
}

export default function SecretEditorPanel({ params }: IDockviewPanelProps<SecretEditorPanelParams>) {
    const t = useT();
    const { clusterName, name, namespace } = params;
    const cn = clusterName ?? '';
    const [rows, setRows] = useState<KeyValueRow[]>([]);
    const [originalRows, setOriginalRows] = useState<KeyValueRow[]>([]);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const toast = useRef<Toast | null>(null);

    useEffect(() => {
        const load = async () => {
            try {
                const data = await GetSecretData(cn, name, namespace);
                const loaded = dataToRows(data ?? {});
                setRows(loaded);
                setOriginalRows(loaded.map(r => ({ ...r })));
            } catch {
                toast.current?.show({ severity: 'error', summary: 'Load failed', detail: `${namespace}/${name} could not be loaded`, life: 3500 });
            }
        };
        load();
    }, [name, namespace]);

    const onCellEditComplete = (e: ColumnEvent) => {
        const { rowIndex, field, newValue } = e;
        setRows(prev => {
            const next = prev.map((r, i) => i === rowIndex ? { ...r, [field]: newValue ?? '' } : r);
            setDirty(!rowsEqual(next, originalRows));
            return next;
        });
    };

    const addRow = () => {
        setRows(prev => {
            const next = [...prev, { id: nextId(), key: '', value: '' }];
            setDirty(!rowsEqual(next, originalRows));
            return next;
        });
    };

    const removeRow = (id: number) => {
        setRows(prev => {
            const next = prev.filter(r => r.id !== id);
            setDirty(!rowsEqual(next, originalRows));
            return next;
        });
    };

    const handleSave = async () => {
        const data: Record<string, string> = {};
        for (const row of rows) {
            if (row.key.trim()) data[row.key.trim()] = row.value;
        }
        setSaving(true);
        try {
            await UpdateSecretData(cn, name, namespace, data);
            const saved = dataToRows(data);
            setOriginalRows(saved.map(r => ({ ...r })));
            setDirty(false);
            toast.current?.show({ severity: 'success', summary: 'Updated', detail: `${namespace}/${name} updated`, life: 2500 });
        } catch {
            toast.current?.show({ severity: 'error', summary: 'Update failed', detail: `${namespace}/${name} could not be updated`, life: 3500 });
        } finally {
            setSaving(false);
        }
    };

    const handleRevert = () => {
        setRows(originalRows.map(r => ({ ...r })));
        setDirty(false);
    };

    const keyEditor = (options: ColumnEditorOptions) => (
        <InputText
            value={options.value}
            onChange={(e) => options.editorCallback!(e.target.value)}
            style={{ fontFamily: 'monospace', fontSize: '0.85rem', width: '100%' }}
            autoFocus
        />
    );

    const valueEditor = (options: ColumnEditorOptions) => (
        <PasswordTextarea
            value={options.value}
            onChange={(val) => options.editorCallback!(val)}
        />
    );

    const valueBody = (rowData: KeyValueRow) => (
        <span style={{
            fontFamily: 'monospace',
            fontSize: '0.85rem',
            letterSpacing: '0.15em',
            color: 'var(--text-color-secondary)',
        }}>
            {rowData.value ? '••••••••' : ''}
        </span>
    );

    const actionsBody = (rowData: KeyValueRow) => (
        <Button
            icon={<VscClose size={16} />}
            text
            severity="danger"
            size="small"
            onClick={() => removeRow(rowData.id)}
            disabled={saving}
            style={{ padding: '0.2rem' }}
        />
    );

    const tableHeader = (
        <div className="flex justify-content-between align-items-center gap-2">
            <span className="yaml-editor-toolbar__label flex align-items-center gap-1" style={{ fontSize: '0.85rem' }}>
                <VscLock size={14} />
                {namespace}/{name}
            </span>
            <div className="flex align-items-center gap-1">
                <Button label={t('panels:secretEditor.addKey')} icon={<VscAdd size={16} />} text size="small" onClick={addRow} disabled={saving} />
                <Button label={t('panels:yaml.revert')} icon={<VscDiscard size={16} />} text size="small" disabled={!dirty || saving} onClick={handleRevert} />
                <Button label={t('panels:yaml.save')} icon={<VscCheck size={16} />} size="small" loading={saving} disabled={!dirty} onClick={handleSave} />
            </div>
        </div>
    );

    return (
        <div className="card" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <Toast ref={toast} position="bottom-right" />

            <DataTable
                value={rows}
                dataKey="id"
                editMode="cell"
                header={tableHeader}
                scrollable
                scrollHeight="flex"
                showGridlines
                stripedRows
                emptyMessage={t('panels:secretEditor.empty')}
                style={{ flex: 1 }}
            >
                <Column
                    field="key"
                    header={t('resources:column.key')}
                    editor={keyEditor}
                    onCellEditComplete={onCellEditComplete}
                    style={{ width: '30%', minWidth: '10rem', fontFamily: 'monospace', fontSize: '0.85rem' }}
                />
                <Column
                    field="value"
                    header={t('resources:column.value')}
                    editor={valueEditor}
                    onCellEditComplete={onCellEditComplete}
                    body={valueBody}
                    style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
                />
                <Column
                    header=""
                    {...ACTION_COLUMN_PROPS}
                    body={actionsBody}
                    style={{ width: '3.5rem', textAlign: 'center' }}
                />
            </DataTable>
        </div>
    );
}
