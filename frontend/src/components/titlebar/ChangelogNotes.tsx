import { useEffect, useState } from 'react';
import { ProgressSpinner } from 'primereact/progressspinner';
import { GetChangelog } from '../../../wailsjs/go/controller_app/App';
import { BrowserOpenURL } from '../../../wailsjs/runtime/runtime';
import { models } from '../../../wailsjs/go/models';
import { InlineMarkdown } from '../../lib/inlineMarkdown';
import { useT } from '../../i18n/useT';

const CHANGELOG_PAGE = 'https://kubeinspector.com/changelog/';

// Keep a Changelog's headings, translated; anything else is shown as written.
const KNOWN_SECTIONS = new Set(['breaking', 'added', 'changed', 'fixed', 'removed', 'deprecated', 'security']);

/**
 * "What's new" in the update dialog: the release notes of every version the
 * update brings, newest first and open, older ones folded. Fetched from the
 * site's changelog.json when the dialog opens; if that fails (offline, or a
 * site deployed before the file existed) it falls back to a link to the page.
 */
export default function ChangelogNotes({ from, to }: { from: string; to: string }) {
    const t = useT();
    const [entries, setEntries] = useState<models.ChangelogEntry[] | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setEntries(null);
        setFailed(false);
        GetChangelog(from, to)
            .then((rows) => { if (!cancelled) setEntries((rows ?? []).map((r) => models.ChangelogEntry.createFrom(r))); })
            .catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; };
    }, [from, to]);

    const openPage = () => BrowserOpenURL(CHANGELOG_PAGE);
    const sectionName = (name: string) => {
        const key = name.trim().toLowerCase();
        return KNOWN_SECTIONS.has(key) ? t(`panels:update.section.${key}` as never) : name;
    };

    let content: React.ReactNode;
    if (failed || (entries && entries.length === 0)) {
        content = (
            <p className="update-notes__fallback">
                {t('panels:update.notesUnavailable')}{' '}
                <button type="button" className="update-notes__link" onClick={openPage}>{t('panels:update.notesOnSite')}</button>
            </p>
        );
    } else if (!entries) {
        content = (
            <div className="update-notes__loading">
                <ProgressSpinner style={{ width: 16, height: 16 }} strokeWidth="6" /> {t('panels:update.notesLoading')}
            </div>
        );
    } else {
        content = entries.map((e, i) => (
            // The newest release is what the user is about to get; older ones
            // the update also brings stay one click away.
            <details key={e.version} className="update-notes__release" open={i === 0}>
                <summary className="update-notes__head">
                    <span className="update-notes__ver">{e.version}</span>
                    {e.date && <span className="update-notes__date">{e.date}</span>}
                </summary>
                {e.summary && e.summary.split('\n\n').map((p, j) => (
                    <p key={j} className="update-notes__summary"><InlineMarkdown text={p} onLink={BrowserOpenURL} /></p>
                ))}
                {(e.sections ?? []).map((s) => (
                    <div key={s.name} className="update-notes__section">
                        <div className="update-notes__section-name">{sectionName(s.name)}</div>
                        <ul className="update-notes__items">
                            {(s.items ?? []).map((item, j) => (
                                <li key={j}><InlineMarkdown text={item} onLink={BrowserOpenURL} /></li>
                            ))}
                        </ul>
                    </div>
                ))}
            </details>
        ));
    }

    return (
        <div className="update-notes">
            <div className="update-notes__title">
                <span>{t('panels:update.whatsNew')}</span>
                {entries && entries.length > 0 && (
                    <button type="button" className="update-notes__link" onClick={openPage}>{t('panels:update.notesOnSite')}</button>
                )}
            </div>
            <div className="update-notes__scroll">{content}</div>
        </div>
    );
}
