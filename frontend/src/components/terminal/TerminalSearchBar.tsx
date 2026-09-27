import { useEffect, useRef, useState } from 'react';
import { InputText } from 'primereact/inputtext';
import { Button } from 'primereact/button';
import { VscArrowDown, VscArrowUp, VscClose } from 'react-icons/vsc';
import { useT } from '../../i18n/useT';

/**
 * Find-in-terminal bar.
 *
 * Absolutely positioned over the terminal rather than added as a flex row: a
 * row would change the terminal's box, so every open and close would refit the
 * terminal and reflow the shell's output. The panel root has position:relative
 * for this; the bar is anchored inside the bounds so the container's
 * overflow:hidden never clips it.
 */
export default function TerminalSearchBar({
    onFind,
    onClose,
}: {
    /** `back` searches upwards; the eslint i18n rule is why this is not a string. */
    onFind: (query: string, back: boolean, incremental?: boolean) => void;
    onClose: () => void;
}) {
    const t = useT();
    const [query, setQuery] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => inputRef.current?.focus(), []);

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            onFind(query, e.shiftKey);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
        }
    };

    return (
        <div className="terminal-search-bar" onKeyDown={onKeyDown}>
            <InputText
                ref={inputRef}
                value={query}
                onChange={(e) => {
                    setQuery(e.target.value);
                    // Search as you type, so the first match highlights without
                    // needing Enter — matches the log viewer's behaviour.
                    onFind(e.target.value, false, true);
                }}
                placeholder={t('panels:terminal.search.placeholder')}
                aria-label={t('panels:terminal.search.placeholder')}
            />
            <Button
                icon={<VscArrowUp size={14} />}
                text
                aria-label={t('panels:terminal.search.previous')}
                tooltip={t('panels:terminal.search.previous')}
                onClick={() => onFind(query, true)}
            />
            <Button
                icon={<VscArrowDown size={14} />}
                text
                aria-label={t('panels:terminal.search.next')}
                tooltip={t('panels:terminal.search.next')}
                onClick={() => onFind(query, false)}
            />
            <Button
                icon={<VscClose size={14} />}
                text
                aria-label={t('panels:terminal.search.close')}
                tooltip={t('panels:terminal.search.close')}
                onClick={onClose}
            />
        </div>
    );
}
