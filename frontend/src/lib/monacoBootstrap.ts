import { loader } from '@monaco-editor/react';
// `monaco-editor` is aliased to `edcore.main` in vite.config.ts — see there for
// why. The YAML grammar is not part of the core entry, so it is asked for here.
import * as monacoEditor from 'monaco-editor';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
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
 * Monaco wants a Worker; the WebKitGTK webview blocks them. A no-op stub keeps
 * it on the main thread instead of crashing — which is also why
 * `k8sYamlIntellisense` does its own schema work synchronously.
 */
class NoopWorker extends EventTarget {
    postMessage() {}
    terminate() {}
    onmessage = null;
    onmessageerror = null;
    onerror = null;
    dispatchEvent(event: Event) { return super.dispatchEvent(event); }
}

(window as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
    getWorker: () => new NoopWorker() as unknown as Worker,
};
