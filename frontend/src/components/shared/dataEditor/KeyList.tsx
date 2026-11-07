import { forwardRef, useMemo, useState } from 'react';
import { InputText } from 'primereact/inputtext';
import { useT } from '../../../i18n/useT';
import { entryStatus, keyProblem, originalByKey, type Entry, type EntryStatus } from './dataEditorModel';

// A mark per state, so the list reads without colour: ● changed, + new,
// − removed, ⚠ a key the API server would refuse.
const INVALID = 'invalid';
const MARK: Record<EntryStatus | typeof INVALID, string> = { new: '+', modified: '●', deleted: '−', unchanged: '', invalid: '⚠' };

/** The left pane: a filterable list of keys, each marked with what the draft does to it. */
const KeyList = forwardRef<HTMLInputElement, {
    original: Entry[];
    draft: Entry[];
    selectedId: number | null;
    onSelect: (id: number) => void;
}>(function KeyList({ original, draft, selectedId, onSelect }, searchRef) {
    const t = useT();
    const [filter, setFilter] = useState('');
    const orig = useMemo(() => originalByKey(original), [original]);
    const shown = useMemo(() => {
        const q = filter.trim().toLowerCase();
        return draft
            .filter((e) => !q || e.key.toLowerCase().includes(q))
            .sort((a, b) => a.key.localeCompare(b.key));
    }, [draft, filter]);

    return (
        <div className="de-keys">
            <div className="de-keys__search">
                <InputText
                    ref={searchRef}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={t('panels:dataEditor.searchKeys')}
                    aria-label={t('panels:dataEditor.searchKeys')}
                />
            </div>
            <ul className="de-keys__list" role="listbox" aria-label={t('panels:dataEditor.keys')}>
                {shown.map((e) => {
                    const problem = e.deleted ? null : keyProblem(e.key, draft, e.id);
                    const status = entryStatus(e, orig);
                    const mark = problem ? INVALID : status;
                    const label = problem ? t(`panels:dataEditor.problem.${problem}`) : status === 'unchanged' ? '' : t(`panels:dataEditor.status.${status}`);
                    return (
                        <li
                            key={e.id}
                            role="option"
                            aria-selected={e.id === selectedId}
                            className={`de-key de-key--${mark}${e.id === selectedId ? ' is-selected' : ''}`}
                            onClick={() => onSelect(e.id)}
                            title={label || e.key}
                        >
                            <span className="de-key__mark" aria-hidden>{MARK[mark]}</span>
                            <span className="de-key__name">{e.key || t('panels:dataEditor.unnamed')}</span>
                            {label && <span className="sr-only">{label}</span>}
                            {e.binary && <span className="de-key__tag">{t('panels:dataEditor.binary')}</span>}
                        </li>
                    );
                })}
                {shown.length === 0 && (
                    <li className="de-keys__empty">{filter ? t('panels:dataEditor.noMatch') : t('panels:dataEditor.noKeys')}</li>
                )}
            </ul>
        </div>
    );
});

export default KeyList;
