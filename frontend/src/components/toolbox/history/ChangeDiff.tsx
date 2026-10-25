import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
// Side-effect import: configures @monaco-editor/react to use the bundled
// Monaco, and lets its diff run on the main thread (see there).
import '../../../lib/monacoBootstrap';
import type { editor } from 'monaco-editor';
import { Button } from 'primereact/button';
import { VscClose, VscHistory } from 'react-icons/vsc';
import { GetToolboxChangeDetail, GetToolboxLiveObject, RollbackToolboxChange } from '../../../../wailsjs/go/controller_app/App';
import { models } from '../../../../wailsjs/go/models';
import { MONACO_BASE_OPTIONS, MONACO_THEME, defineMonacoTheme, useMonacoTheme } from '../../../lib/monacoTheme';
import { errText } from '../../../lib/errText';
import { useT } from '../../../i18n/useT';
import Segmented from '../../shared/Segmented';
import RowAction from '../../shared/RowAction';
import PanelLoading from '../../shared/PanelLoading';
import ErrorBanner from '../../shared/ErrorBanner';
import ConfirmActionDialog from '../../shared/ConfirmActionDialog';
import { formatTime, verbLamp } from './format';

type Mode = 'change' | 'live';
type Side = 'before' | 'after';
type Layout = 'side' | 'inline';

const DIFF_OPTIONS: editor.IDiffEditorConstructionOptions = {
    ...MONACO_BASE_OPTIONS,
    readOnly: true,
    originalEditable: false,
    // A narrow detail pane would squeeze two columns into unreadable slivers;
    // Monaco switches to inline by itself below the breakpoint.
    useInlineViewWhenSpaceIsLimited: true,
    renderSideBySideInlineBreakpoint: 560,
    // Long objects collapse to the changed hunks; the folds open on click.
    hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4, revealLineCount: 20 },
    ignoreTrimWhitespace: false,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderValidationDecorations: 'off',
    folding: false,
};

// @monaco-editor/react disposes a diff editor's models before the editor
// itself, which Monaco 0.5x rejects ("TextModel got disposed before
// DiffEditorWidget model got reset"). It is told to keep them, and they go
// once the editor has.
const disposeModelsAfterEditor: DiffOnMount = (editor) => {
    const models = editor.getModel();
    editor.onDidDispose(() => {
        models?.original.dispose();
        models?.modified.dispose();
    });
};

/**
 * One recorded change: who made it, and its YAML in a Monaco diff.
 *
 * Two comparisons:
 *  - "The change": the object before vs after this write, exactly as toolbox
 *    stored it (status and server fields included — they are part of what
 *    happened).
 *  - "Against live": a recorded version (after or before this change) vs the
 *    object as it is now. Both sides are the backend's restorable form, so the
 *    diff is precisely what a rollback would write.
 *
 * Rollback always restores the left-hand side: "before" for the change view,
 * the chosen version for the live view. The backend re-reads that version from
 * toolbox; nothing shown here is sent back.
 */
export default function ChangeDiff({ clusterName, eventId, onClose, onRolledBack }: {
    clusterName: string;
    eventId: string;
    onClose: () => void;
    onRolledBack: (message: string) => void;
}) {
    useMonacoTheme();
    const t = useT();
    const [detail, setDetail] = useState<models.ToolboxChangeDetail | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [mode, setMode] = useState<Mode>('change');
    const [version, setVersion] = useState<Side>('after');
    const [layout, setLayout] = useState<Layout>('side');
    const [live, setLive] = useState<models.ToolboxLiveObject | null>(null);
    const [liveError, setLiveError] = useState<string | null>(null);
    const [liveTick, setLiveTick] = useState(0);
    const [confirming, setConfirming] = useState(false);

    const loadDetail = useCallback(async () => {
        setError(null);
        try {
            const d = await GetToolboxChangeDetail(clusterName, eventId);
            setDetail(d);
            setVersion(d.afterRestorable ? 'after' : 'before');
        } catch (e) {
            setError(errText(e));
        }
    }, [clusterName, eventId]);

    useEffect(() => { void loadDetail(); }, [loadDetail]);

    const ch = detail?.change;
    useEffect(() => {
        if (mode !== 'live' || !ch) return;
        let stale = false;
        setLive(null);
        setLiveError(null);
        GetToolboxLiveObject(clusterName, ch.group, ch.apiVersion, ch.resource, ch.namespace, ch.name)
            .then((o) => { if (!stale) setLive(o); })
            .catch((e) => { if (!stale) setLiveError(errText(e)); });
        return () => { stale = true; };
    }, [mode, ch, clusterName, liveTick]);

    if (error) {
        return (
            <div className="history-detail">
                <DetailHeader title={t('panels:clusterHistory.detail.loadFailed')} onClose={onClose} closeLabel={t('panels:clusterHistory.detail.close')} />
                <ErrorBanner block message={error} onRetry={() => void loadDetail()} cluster={clusterName} context={t('panels:clusterHistory.label')} />
            </div>
        );
    }
    if (!detail || !ch) {
        return <div className="history-detail"><PanelLoading /></div>;
    }

    const versionLabel = (s: Side) => t(s === 'after' ? 'panels:clusterHistory.compare.after' : 'panels:clusterHistory.compare.before');
    const restorable = (s: Side) => (s === 'after' ? detail.afterRestorable : detail.beforeRestorable);

    let original: string, modified: string, leftLabel: string, rightLabel: string, note: string | null = null;
    const side: Side = mode === 'change' ? 'before' : version;
    if (mode === 'change') {
        original = detail.beforeYaml;
        modified = detail.afterYaml;
        leftLabel = t('panels:clusterHistory.pane.before');
        rightLabel = t('panels:clusterHistory.pane.after');
        if (!detail.beforeYaml) note = t('panels:clusterHistory.note.noBefore');
        else if (!detail.afterYaml) note = t('panels:clusterHistory.note.noAfter');
    } else {
        original = restorable(version);
        modified = live?.exists ? live.yaml : '';
        leftLabel = versionLabel(version);
        rightLabel = t('panels:clusterHistory.pane.live');
        note = live && !live.exists ? t('panels:clusterHistory.note.deleted') : t('panels:clusterHistory.note.live');
    }
    const identical = original !== '' && original === modified;
    if (identical) note = t('panels:clusterHistory.note.identical');

    const blocked = detail.rollbackBlocked === 'secretRedacted'
        ? t('panels:clusterHistory.rollback.blocked.secretRedacted')
        : !restorable(side) ? t('panels:clusterHistory.rollback.blocked.noVersion') : null;
    const willRecreate = mode === 'live' && live !== null && !live.exists;

    const a = ch.actor;
    const facts: [string, ReactNode][] = [
        [t('panels:clusterHistory.detail.time'), formatTime(ch.time)],
        [t('panels:clusterHistory.col.verb'), verbLamp(ch.verb)],
        [t('panels:clusterHistory.detail.object'), `${ch.group ? ch.group + '/' : ''}${ch.apiVersion} ${ch.kind}`],
        [t('panels:clusterHistory.detail.user'), a?.username || '—'],
    ];
    if (a?.impersonatedBy) facts.push([t('panels:clusterHistory.detail.impersonatedBy'), a.impersonatedBy]);
    if (a?.groups?.length) facts.push([t('panels:clusterHistory.detail.groups'), a.groups.join(', ')]);
    if (a?.sourceIPs?.length) facts.push([t('panels:clusterHistory.detail.sourceIps'), a.sourceIPs.join(', ')]);
    if (a?.userAgent) facts.push([t('panels:clusterHistory.detail.userAgent'), a.userAgent]);
    if (ch.fieldManager) facts.push([t('panels:clusterHistory.detail.fieldManager'), ch.fieldManager]);
    facts.push([t('panels:clusterHistory.detail.attribution'), ch.attribution]);
    if (ch.resourceVersion) facts.push([t('panels:clusterHistory.detail.resourceVersion'), ch.resourceVersion]);
    if (a?.auditId) facts.push([t('panels:clusterHistory.detail.auditId'), a.auditId]);

    const objectName = `${ch.namespace ? ch.namespace + '/' : ''}${ch.name}`;

    const modeOptions: { value: Mode; label: string }[] = [
        { value: 'change', label: t('panels:clusterHistory.compare.change') },
        { value: 'live', label: t('panels:clusterHistory.compare.live') },
    ];
    const versionOptions: { value: Side; label: string }[] = [
        { value: 'after', label: versionLabel('after') },
        { value: 'before', label: versionLabel('before') },
    ];
    const layoutOptions: { value: Layout; label: string }[] = [
        { value: 'side', label: t('panels:clusterHistory.compare.sideBySide') },
        { value: 'inline', label: t('panels:clusterHistory.compare.inline') },
    ];

    const rollback = async () => {
        const out = await RollbackToolboxChange(clusterName, eventId, side);
        // Show the result: the live object should now match the version
        // that was restored.
        setVersion(side);
        setMode('live');
        setLiveTick((n) => n + 1);
        onRolledBack(out);
    };

    return (
        <div className="history-detail">
            <DetailHeader title={`${ch.kind} · ${objectName}`} onClose={onClose} closeLabel={t('panels:clusterHistory.detail.close')} />

            <dl className="dlg-facts history-detail__facts">
                {facts.map(([k, v]) => (
                    <div className="dlg-facts__row" key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                    </div>
                ))}
            </dl>

            <div className="history-detail__controls">
                <Segmented<Mode> value={mode} onChange={setMode} ariaLabel={t('panels:clusterHistory.compare.aria')} options={modeOptions} />
                {mode === 'live' && (
                    <Segmented<Side> value={version} onChange={setVersion} ariaLabel={t('panels:clusterHistory.compare.versionAria')} options={versionOptions} />
                )}
                <span className="history-detail__spacer" />
                <Segmented<Layout> value={layout} onChange={setLayout} ariaLabel={t('panels:clusterHistory.compare.layoutAria')} options={layoutOptions} />
                {/* A disabled button swallows hover, so its reason goes on a wrapper. */}
                <span title={blocked ?? undefined}>
                    <Button
                        label={t('panels:clusterHistory.rollback.button')}
                        icon={<VscHistory size={14} />}
                        size="small"
                        severity="danger"
                        disabled={!!blocked || identical || (mode === 'live' && live === null)}
                        onClick={() => setConfirming(true)}
                    />
                </span>
            </div>

            {note && <div className="history-detail__note">{note}</div>}

            {layout === 'side' && (
                <div className="history-diff__labels" aria-hidden>
                    <span>{leftLabel}</span>
                    <span>{rightLabel}</span>
                </div>
            )}
            <div className="history-diff dark-display">
                {mode === 'live' && liveError ? (
                    <ErrorBanner block message={liveError} onRetry={() => setLiveTick((n) => n + 1)} cluster={clusterName} context={rightLabel} />
                ) : mode === 'live' && live === null ? (
                    <PanelLoading />
                ) : (
                    <DiffEditor
                        height="100%"
                        language="yaml"
                        original={original}
                        modified={modified}
                        theme={MONACO_THEME}
                        beforeMount={defineMonacoTheme}
                        onMount={disposeModelsAfterEditor}
                        keepCurrentOriginalModel
                        keepCurrentModifiedModel
                        options={{ ...DIFF_OPTIONS, renderSideBySide: layout === 'side' }}
                    />
                )}
            </div>

            <ConfirmActionDialog
                visible={confirming}
                header={t('panels:clusterHistory.rollback.header', { name: ch.name })}
                message={t(willRecreate ? 'panels:clusterHistory.rollback.recreate' : 'panels:clusterHistory.rollback.message', {
                    kind: ch.kind, name: objectName, version: versionLabel(side),
                })}
                warning={t('panels:clusterHistory.rollback.warning')}
                confirmLabel={t('panels:clusterHistory.rollback.confirm')}
                severity="danger"
                onHide={() => setConfirming(false)}
                onConfirm={rollback}
            />
        </div>
    );
}

function DetailHeader({ title, onClose, closeLabel }: { title: string; onClose: () => void; closeLabel: string }) {
    return (
        <div className="panel-toolbar">
            <span className="panel-toolbar__label history-detail__title" title={title}>{title}</span>
            <div className="panel-toolbar__actions">
                <RowAction icon={<VscClose size={14} />} label={closeLabel} onClick={onClose} />
            </div>
        </div>
    );
}
