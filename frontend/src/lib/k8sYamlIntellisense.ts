import * as monaco from 'monaco-editor';
import { GetK8sSchema } from '../../wailsjs/go/controller_app/App';
import {
    buildSchemaIndex,
    collectSchemaMarkers,
    collectSiblingKeys,
    currentDocSegment,
    docKindOf,
    resolveDefAtCursor,
} from './k8sYamlSchema';
import type { SchemaDef, SchemaIndex, SchemaProp } from './k8sYamlSchema';

// K8s YAML intellisense: schema-driven completion, hover and validation
// backed by the embedded OpenAPI schema (business/assets/k8s-schema.json via
// GetK8sSchema). Runs entirely on the main thread — the Wails webview has no
// working web workers (see the NoopWorker stub in main.tsx).
// Registered once globally — call ensureK8sYamlIntellisense() from any editor
// mount; repeated calls are no-ops.

let registration: Promise<void> | null = null;

export function ensureK8sYamlIntellisense(): Promise<void> {
    if (!registration) {
        registration = register().catch(err => {
            // Allow a retry on the next editor mount if the schema fetch failed.
            registration = null;
            console.error('k8s yaml intellisense setup failed:', err);
        });
    }
    return registration;
}

async function register(): Promise<void> {
    const raw = await GetK8sSchema();
    const parsed = JSON.parse(raw) as { definitions?: Record<string, SchemaDef> };
    if (!parsed.definitions) return;
    const index = buildSchemaIndex(parsed.definitions);
    registerCompletion(index);
    registerHover(index);
    registerValidation(index);
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

// What a key's value looks like, so insertText can pre-indent the next line.
// Resolves $refs: refs to scalar-ish defs (Time, Quantity, IntOrString) are
// scalars, not objects.
function childShape(index: SchemaIndex, prop: SchemaProp): 'object' | 'array' | 'scalar' {
    if (prop.type === 'array') return 'array';
    if (prop.$ref) return index.resolveRef(prop.$ref)?.properties ? 'object' : 'scalar';
    if (prop.type === 'object' || prop.additionalProperties) return 'object';
    return 'scalar';
}

// Fallback root keys offered before the document has a resolvable kind.
const SCAFFOLD_KEYS: Array<{ key: string; shape: 'object' | 'scalar'; desc: string }> = [
    { key: 'apiVersion', shape: 'scalar', desc: 'API group/version of this object, e.g. apps/v1.' },
    { key: 'kind', shape: 'scalar', desc: 'Kind of this object, e.g. Deployment.' },
    { key: 'metadata', shape: 'object', desc: 'Standard object metadata (name, namespace, labels, ...).' },
    { key: 'spec', shape: 'object', desc: 'Desired state of the object.' },
];

function registerCompletion(index: SchemaIndex) {
    const RETRIGGER = { id: 'editor.action.triggerSuggest', title: 'Suggest' };
    // Our insertText carries the finished, absolute indentation for the line
    // it opens. Monaco otherwise inserts completions through the snippet
    // session with `adjustWhitespace: !(insertTextRules & KeepWhitespace)`,
    // which prefixes every line after the first with the leading whitespace
    // of the line the item was accepted on — doubling the indent, and
    // compounding with each accept because of RETRIGGER. KeepWhitespace also
    // keeps monaco's normalizeIndentation from turning those spaces into
    // tabs, which YAML does not allow.
    const KEEP_INDENT = monaco.languages.CompletionItemInsertTextRule.KeepWhitespace;

    monaco.languages.registerCompletionItemProvider('yaml', {
        triggerCharacters: ['\n', ' ', '-'],
        provideCompletionItems(model, position) {
            const lines = model.getLinesContent();
            const lineIndex = position.lineNumber - 1;
            const before = lines[lineIndex].slice(0, position.column - 1);
            const { segLines, segIndex } = currentDocSegment(lines, lineIndex);
            const word = model.getWordUntilPosition(position);
            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
            };

            // --- value position: `key: <cursor>` -------------------------
            const valMatch = before.match(/^(\s*)(-\s+)?([\w.-]+):(\s+.*)?$/);
            if (valMatch) {
                // Right after the colon with no space yet: nothing to offer.
                if (valMatch[4] === undefined) return { suggestions: [] };
                const key = valMatch[3];
                const keyIndent = valMatch[1].length + (valMatch[2] ? 2 : 0);

                let values: Array<{ label: string; doc?: string }> = [];
                if (key === 'kind' && keyIndent === 0) {
                    values = [...index.kindToDefKey.keys()].sort().map(k => ({
                        label: k,
                        doc: index.defs[index.kindToDefKey.get(k)!]?.description,
                    }));
                } else if (key === 'apiVersion' && keyIndent === 0) {
                    const gvs = index.kindToApiVersions.get(docKindOf(segLines))
                        ?? [...new Set([...index.kindToApiVersions.values()].flat())].sort();
                    values = gvs.map(gv => ({ label: gv }));
                } else {
                    const def = resolveDefAtCursor(index, segLines, segIndex, keyIndent);
                    const prop = def?.properties?.[key];
                    if (prop?.enum) values = prop.enum.map(v => ({ label: String(v), doc: prop.description }));
                    else if (prop?.type === 'boolean') values = [{ label: 'true' }, { label: 'false' }];
                }

                return {
                    suggestions: values.map(v => ({
                        label: v.label,
                        kind: monaco.languages.CompletionItemKind.Value,
                        documentation: v.doc ?? '',
                        insertText: v.label,
                        range,
                    })),
                };
            }

            // --- key position --------------------------------------------
            const dashPrefix = before.match(/^(\s*)-\s+([\w.-]*)$/);
            const cursorIndent = dashPrefix
                ? dashPrefix[1].length + 2
                : before.match(/^(\s*)/)![1].length;
            const indentStr = ' '.repeat(cursorIndent);
            const used = collectSiblingKeys(segLines, segIndex, cursorIndent);

            const def = resolveDefAtCursor(index, segLines, segIndex, cursorIndent);
            if (!def?.properties) {
                // No resolvable kind yet: offer the standard scaffold at the
                // top level so an empty Apply YAML document can be started.
                if (cursorIndent === 0 && !index.kindToDefKey.has(docKindOf(segLines))) {
                    return {
                        suggestions: SCAFFOLD_KEYS.filter(s => !used.has(s.key)).map((s, i) => ({
                            label: s.key,
                            kind: monaco.languages.CompletionItemKind.Field,
                            documentation: s.desc,
                            sortText: String(i),
                            insertText: s.shape === 'object' ? `${s.key}:\n  ` : `${s.key}: `,
                            insertTextRules: KEEP_INDENT,
                            range,
                            command: RETRIGGER,
                        })),
                    };
                }
                return { suggestions: [] };
            }

            const required = new Set(def.required ?? []);
            const suggestions = Object.entries(def.properties)
                .filter(([key]) => !used.has(key))
                .map(([key, prop]) => {
                    const shape = childShape(index, prop);
                    const insertText =
                        shape === 'object' ? `${key}:\n${indentStr}  `
                        : shape === 'array' ? `${key}:\n${indentStr}- `
                        : `${key}: `;
                    return {
                        label: key,
                        kind: monaco.languages.CompletionItemKind.Field,
                        detail: prop.type ?? prop.$ref?.split('.').pop(),
                        documentation: prop.description ?? '',
                        sortText: (required.has(key) ? '0' : '1') + key,
                        insertText,
                        insertTextRules: KEEP_INDENT,
                        range,
                        command: RETRIGGER,
                    };
                });
            return { suggestions };
        },
    });
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

function registerHover(index: SchemaIndex) {
    monaco.languages.registerHoverProvider('yaml', {
        provideHover(model, position) {
            const word = model.getWordAtPosition(position);
            if (!word) return null;
            const lines = model.getLinesContent();
            const { segLines, segIndex } = currentDocSegment(lines, position.lineNumber - 1);
            const line = segLines[segIndex];
            const dm = line.match(/^(\s*)-\s+/);
            const indent = dm ? dm[1].length + 2 : line.match(/^(\s*)/)![1].length;
            const def = resolveDefAtCursor(index, segLines, segIndex, indent);
            const prop = def?.properties?.[word.word];
            if (!prop?.description) return null;
            return {
                contents: [
                    { value: `**${word.word}**` },
                    { value: prop.description },
                ],
            };
        },
    });
}

// ---------------------------------------------------------------------------
// Validation (VS Code-style squiggles)
// ---------------------------------------------------------------------------

function registerValidation(index: SchemaIndex) {
    const OWNER = 'k8s-schema';
    const timers = new Map<monaco.editor.ITextModel, ReturnType<typeof setTimeout>>();

    const validate = (model: monaco.editor.ITextModel) => {
        if (model.isDisposed()) return;
        const markers = collectSchemaMarkers(model.getValue(), index).map(m => {
            const s = model.getPositionAt(m.start);
            const e = model.getPositionAt(m.end);
            return {
                severity: m.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
                message: m.message,
                startLineNumber: s.lineNumber,
                startColumn: s.column,
                endLineNumber: e.lineNumber,
                endColumn: e.column,
            };
        });
        monaco.editor.setModelMarkers(model, OWNER, markers);
    };

    const hook = (model: monaco.editor.ITextModel) => {
        if (model.getLanguageId() !== 'yaml') return;
        validate(model);
        model.onDidChangeContent(() => {
            clearTimeout(timers.get(model));
            timers.set(model, setTimeout(() => validate(model), 400));
        });
        model.onWillDispose(() => {
            clearTimeout(timers.get(model));
            timers.delete(model);
        });
    };

    monaco.editor.onDidCreateModel(hook);
    monaco.editor.getModels().forEach(hook);
}

// ---------------------------------------------------------------------------
// Editor options
// ---------------------------------------------------------------------------

// Options that make suggestions and squiggles actually appear in YAML:
// - monaco's yaml tokenizer marks bare words as strings until the `:` is
//   typed, and quickSuggestions defaults to strings:false — so typing a key
//   never triggered the popup. strings:true fixes that.
// - wordBasedSuggestions would offer every word of the document alongside
//   the schema's keys, burying them. (It once also hung the suggest widget,
//   back when the editor worker was a stub that never answered — see
//   monacoBootstrap.ts.)
// - renderValidationDecorations defaults to 'editable', which hides marker
//   squiggles in read-only viewers (pod YAML etc.).
export const k8sYamlSuggestOptions = {
    quickSuggestions: { other: true, comments: false, strings: true },
    wordBasedSuggestions: 'off',
    renderValidationDecorations: 'on',
} as const;
