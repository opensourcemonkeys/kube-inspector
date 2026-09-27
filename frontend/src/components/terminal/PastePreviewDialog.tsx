import { useEffect, useRef, useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { InputTextarea } from 'primereact/inputtextarea';
import { VscClose, VscClippy } from 'react-icons/vsc';
import { pasteLineCount } from '../../lib/terminalActions';
import { useT } from '../../i18n/useT';

/**
 * Multi-line paste guard.
 *
 * A terminal paste runs whatever it receives, so a clipboard carrying several
 * lines runs several commands the user has not read. Rather than blocking that,
 * this shows the text first and lets them edit it — the common case is a
 * snippet copied out of a wiki with one line that needs a namespace changed.
 *
 * It doubles as the clipboard fallback: when `text` is "" the clipboard could
 * not be read programmatically, and a native Ctrl+V into this textarea needs no
 * permission at all.
 *
 * Follows ConfirmActionDialog's shape (plain <Dialog> + footer) rather than
 * PrimeReact's ConfirmDialog service, like every other dialog in the app.
 */
export default function PastePreviewDialog({
    text,
    onCancel,
    onPaste,
}: {
    /** null hides the dialog. "" means the clipboard was unreadable. */
    text: string | null;
    onCancel: () => void;
    onPaste: (text: string) => void;
}) {
    const t = useT();
    const [value, setValue] = useState('');
    const areaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (text !== null) setValue(text);
    }, [text]);

    // autoFocus on InputTextarea does not survive the dialog's mount animation.
    useEffect(() => {
        if (text === null) return;
        const id = setTimeout(() => areaRef.current?.focus(), 60);
        return () => clearTimeout(id);
    }, [text]);

    const submit = () => {
        if (!value) return;
        onPaste(value);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            // Shift+Enter is the only way to add a line here, so Enter is free
            // to mean "send" — which is what the Paste button does too.
            e.preventDefault();
            submit();
            return;
        }
        if (e.key === 'Escape') {
            // stopPropagation as well: the dockview overlay and the panel both
            // listen for Escape and would act on the same keystroke.
            e.preventDefault();
            e.stopPropagation();
            onCancel();
        }
    };

    const lines = pasteLineCount(value);

    return (
        <Dialog
            header={t('panels:terminal.paste.header')}
            visible={text !== null}
            style={{ width: '38rem' }}
            modal
            onHide={onCancel}
            footer={
                <div className="flex justify-content-end gap-2">
                    <Button
                        label={t('action.cancel')}
                        icon={<VscClose size={16} />}
                        text
                        onClick={onCancel}
                    />
                    <Button
                        label={t('panels:terminal.paste.confirm')}
                        icon={<VscClippy size={16} />}
                        onClick={submit}
                        disabled={!value}
                    />
                </div>
            }
        >
            <div className="flex flex-column gap-2">
                <span style={{ color: 'var(--amber)', fontSize: '0.85rem' }}>
                    {text === ''
                        ? t('panels:terminal.paste.empty')
                        : t('panels:terminal.paste.warning', { count: lines })}
                </span>
                <InputTextarea
                    ref={areaRef}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={onKeyDown}
                    rows={Math.min(14, Math.max(4, lines))}
                    spellCheck={false}
                    aria-label={t('panels:terminal.paste.aria')}
                    style={{
                        width: '100%',
                        fontFamily: 'var(--font-family-mono)',
                        fontSize: 12,
                        resize: 'vertical',
                    }}
                />
                <span style={{ color: 'var(--ink3)', fontSize: '0.75rem' }}>
                    {t('panels:terminal.paste.hint')}
                </span>
            </div>
        </Dialog>
    );
}
