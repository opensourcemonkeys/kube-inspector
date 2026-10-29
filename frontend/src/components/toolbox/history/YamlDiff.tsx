import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
// Side-effect import: configures @monaco-editor/react to use the bundled
// Monaco, and lets its diff run on the main thread (see there).
import '../../../lib/monacoBootstrap';
import type { editor } from 'monaco-editor';
import { MONACO_BASE_OPTIONS, MONACO_THEME, defineMonacoTheme, useMonacoTheme } from '../../../lib/monacoTheme';

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

/** A read-only YAML diff in the app's Monaco theme, original on the left. */
export default function YamlDiff({ original, modified, sideBySide }: { original: string; modified: string; sideBySide: boolean }) {
    useMonacoTheme();
    return (
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
            options={{ ...DIFF_OPTIONS, renderSideBySide: sideBySide }}
        />
    );
}
