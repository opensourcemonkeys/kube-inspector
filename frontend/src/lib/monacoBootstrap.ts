import { loader } from '@monaco-editor/react';
// `monaco-editor` is aliased to the bare editor API in vite.config.ts — see
// there for why. The editor features and the YAML grammar are not part of that
// entry, so they are asked for here.
import * as monacoEditor from 'monaco-editor';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/yaml/register';
import { monoFontReady } from './fonts';

/**
 * Wires `@monaco-editor/react` to the bundled `monaco-editor` instead of
 * letting it fetch one from a CDN (there is no network in a packaged desktop
 * app, and the CSP would refuse anyway).
 *
 * This lives in its own module — rather than in `main.tsx`, where it used to —
 * because importing `monaco-editor` is what pulls Monaco into whatever chunk
 * does the importing. From the entry point that meant every launch parsed all
 * of Monaco before painting anything, even for a session that never opens a
 * YAML tab. Every Monaco-using panel imports this module and every one of them
 * is `React.lazy`, so Monaco now arrives with the first editor that needs it.
 *
 * Import for side effects: `import '../../lib/monacoBootstrap';`. Module
 * evaluation happens once, so repeated imports are free.
 */
loader.config({ monaco: monacoEditor });

// Monaco sizes its character grid from whatever face is loaded when an editor
// opens; if Plex Mono arrived later, the cursor and selection drift off the
// glyphs. Re-measure once it is in.
void monoFontReady.then(() => monacoEditor.editor.remeasureFonts());

/**
 * Monaco wants a Worker; the WebKitGTK webview blocks them. Refusing one is
 * what makes Monaco run its editor worker on the main thread instead
 * (`editorWorkerService.js`: a throw from worker creation falls back to a
 * `SynchronousWorkerClient`).
 *
 * This used to hand back a no-op stub. That never crashed, but it never
 * answered either: every request through the worker — the diff editor's diff,
 * word-based suggestions — waited forever, and the diff editor showed two
 * panes with no changes marked.
 */
(window as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
    getWorker: () => {
        throw new Error('web workers are not used in this app');
    },
};
