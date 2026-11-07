import { beforeAll, describe, expect, it, vi } from 'vitest';

// Monaco's real `CompletionItemInsertTextRule.KeepWhitespace`.
const KEEP_WHITESPACE = 1;

type Item = {
    label: string;
    insertText: string;
    insertTextRules?: number;
    range: { startColumn: number; endColumn: number };
};

const providers: Array<{ provideCompletionItems: (m: unknown, p: unknown) => { suggestions: Item[] } }> = [];

vi.mock('monaco-editor', () => ({
    languages: {
        registerCompletionItemProvider: (_lang: string, p: never) => { providers.push(p); },
        registerHoverProvider: () => undefined,
        CompletionItemKind: { Field: 5, Value: 12 },
        CompletionItemInsertTextRule: { None: 0, KeepWhitespace: KEEP_WHITESPACE, InsertAsSnippet: 4 },
    },
    editor: {
        onDidCreateModel: () => undefined,
        getModels: () => [],
        setModelMarkers: () => undefined,
    },
    MarkerSeverity: { Error: 8, Warning: 4 },
}));

const SCHEMA = {
    definitions: {
        Deployment: {
            type: 'object',
            'x-kubernetes-group-version-kind': [{ group: 'apps', version: 'v1', kind: 'Deployment' }],
            required: ['spec'],
            properties: {
                apiVersion: { type: 'string' },
                kind: { type: 'string' },
                spec: { $ref: '#/definitions/DeploymentSpec' },
            },
        },
        DeploymentSpec: {
            type: 'object',
            properties: {
                replicas: { type: 'integer' },
                template: { $ref: '#/definitions/PodTemplateSpec' },
            },
        },
        PodTemplateSpec: { type: 'object', properties: { spec: { $ref: '#/definitions/PodSpec' } } },
        PodSpec: {
            type: 'object',
            properties: { containers: { type: 'array', items: { $ref: '#/definitions/Container' } } },
        },
        Container: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                ports: { type: 'array', items: { $ref: '#/definitions/ContainerPort' } },
            },
        },
        ContainerPort: { type: 'object', properties: { containerPort: { type: 'integer' } } },
    },
};

vi.mock('../../wailsjs/go/controller_app/App', () => ({
    GetK8sSchema: () => Promise.resolve(JSON.stringify(SCHEMA)),
}));

function fakeModel(text: string, path = '/1') {
    const lines = text.split('\n');
    return {
        uri: { path },
        getLinesContent: () => lines,
        getWordUntilPosition: (pos: { lineNumber: number; column: number }) => {
            const upto = lines[pos.lineNumber - 1].slice(0, pos.column - 1);
            const word = /[\w.-]*$/.exec(upto)![0];
            return { word, startColumn: pos.column - word.length, endColumn: pos.column };
        },
    };
}

// Mirrors monaco's SnippetSession.adjustWhitespace + the suggest controller's
// `adjustWhitespace: !(insertTextRules & KeepWhitespace)` (verified against
// monaco-editor 0.55.1 sources): every line after the first is prefixed with
// the leading whitespace of the line the completion is accepted on, unless the
// item opted out via KeepWhitespace.
function accept(text: string, lineNumber: number, column: number, item: Item): string {
    const lines = text.split('\n');
    const line = lines[lineNumber - 1];
    const parts = item.insertText.split('\n');
    if (!((item.insertTextRules ?? 0) & KEEP_WHITESPACE)) {
        const lead = /^[ \t]*/.exec(line.slice(0, column - 1))![0];
        for (let i = 1; i < parts.length; i++) parts[i] = lead + parts[i];
    }
    const head = line.slice(0, item.range.startColumn - 1);
    const tail = line.slice(item.range.endColumn - 1);
    lines.splice(lineNumber - 1, 1, ...(head + parts.join('\n') + tail).split('\n'));
    return lines.join('\n');
}

function complete(text: string, lineNumber: number, column: number, path?: string): Item[] {
    return providers[0].provideCompletionItems(fakeModel(text, path), { lineNumber, column }).suggestions;
}

describe('k8s yaml completion indentation', () => {
    beforeAll(async () => {
        const { ensureK8sYamlIntellisense } = await import('./k8sYamlIntellisense');
        await ensureK8sYamlIntellisense();
        expect(providers).toHaveLength(1);
    });

    it('indents an object key one level below the cursor', () => {
        const doc = 'apiVersion: apps/v1\nkind: Deployment\nspec:\n  ';
        const item = complete(doc, 4, 3).find(s => s.label === 'template')!;
        expect(item).toBeDefined();
        expect(accept(doc, 4, 3, item)).toBe(
            'apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    ',
        );
    });

    it('indents an array key so the dash lines up with the key', () => {
        const doc = 'apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      ';
        const item = complete(doc, 6, 7).find(s => s.label === 'containers')!;
        expect(item).toBeDefined();
        expect(accept(doc, 6, 7, item)).toBe(
            'apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n      - ',
        );
    });

    it('indents relative to the dash when completing inside a sequence item', () => {
        const doc = [
            'apiVersion: apps/v1',
            'kind: Deployment',
            'spec:',
            '  template:',
            '    spec:',
            '      containers:',
            '      - ',
        ].join('\n');
        const item = complete(doc, 7, 9).find(s => s.label === 'ports')!;
        expect(item).toBeDefined();
        expect(accept(doc, 7, 9, item)).toBe(doc + 'ports:\n        - ');
    });

    it('indents the scaffold keys offered on an empty document', () => {
        const item = complete('', 1, 1).find(s => s.label === 'metadata')!;
        expect(item).toBeDefined();
        expect(accept('', 1, 1, item)).toBe('metadata:\n  ');
    });

    it('offers nothing in a plain YAML value (a ConfigMap application.yaml)', async () => {
        const { PLAIN_YAML_PATH } = await import('./k8sYamlIntellisense');
        expect(complete('', 1, 1)).not.toHaveLength(0);
        expect(complete('', 1, 1, `${PLAIN_YAML_PATH}7-0`)).toHaveLength(0);
    });
});
