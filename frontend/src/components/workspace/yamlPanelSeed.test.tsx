import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ComponentProps } from 'react';
import { render, waitFor } from '@testing-library/react';

// The bug this file exists to prevent: these panels seeded React state with the
// placeholder string 'Loading...' and handed it to Monaco as `value`, so the
// editor's model was *created* holding the placeholder. @monaco-editor/react
// applies every later `value` change to a writable editor as
// `executeEdits(...)` + `pushUndoStop()` (dist/index.js, the `[value]` update
// effect) — an undoable edit. The placeholder→YAML transition therefore sat on
// Monaco's undo stack, and a Ctrl+Z on a freshly opened, untouched editor wiped
// the object and put 'Loading...' back on screen.
//
// The contract: the editor is never mounted with content that is not the real
// document, so nothing it must not undo is ever on its undo stack.

const rec = vi.hoisted(() => ({ values: [] as Array<string | undefined> }));

vi.mock('@monaco-editor/react', async () => {
    const React = await import('react');
    return {
        default: (props: { value?: string }) => {
            rec.values.push(props.value);
            return React.createElement('div', { 'data-testid': 'monaco' });
        },
        // useMonacoTheme re-skins through the loader; never resolving keeps
        // the theme out of a test about what the editor is seeded with.
        loader: { init: () => new Promise(() => {}) },
    };
});

// Both pull real Monaco in for its side effects; neither is what is under test.
vi.mock('../../lib/monacoBootstrap', () => ({}));
vi.mock('../../lib/k8sYamlIntellisense', () => ({
    ensureK8sYamlIntellisense: () => Promise.resolve(),
    k8sYamlSuggestOptions: {},
}));

const DEPLOYMENT_YAML = 'apiVersion: apps/v1\nkind: Deployment\n';
const OBJECT_YAML = 'apiVersion: example.com/v1\nkind: Widget\n';

vi.mock('../../../wailsjs/go/controller_app/App', async (importOriginal) => ({
    // Keep every other binding: both panels import a long list of them.
    ...await importOriginal<Record<string, unknown>>(),
    GetDeploymentYaml: () => Promise.resolve(DEPLOYMENT_YAML),
    GetObjectYaml: () => Promise.resolve(OBJECT_YAML),
}));

import YamlEditorPanel from './YamlEditorPanel';
import ObjectYamlPanel from './ObjectYamlPanel';

beforeEach(() => { rec.values = []; });

describe('YAML panels never seed Monaco with a placeholder', () => {
    it('YamlEditorPanel mounts the editor with the fetched document', async () => {
        // The panels read `params` and nothing else off dockview's panel
        // props, so the cast is what keeps this test from faking a dockview.
        const props = {
            params: { clusterName: 'c', resourceKind: 'deployment', name: 'api', namespace: 'default' },
        } as unknown as ComponentProps<typeof YamlEditorPanel>;
        const { queryByTestId } = render(<YamlEditorPanel {...props} />);

        // Nothing is handed to Monaco while the fetch is still in flight.
        expect(queryByTestId('monaco')).toBeNull();

        await waitFor(() => expect(rec.values.length).toBeGreaterThan(0));
        expect(rec.values[0]).toBe(DEPLOYMENT_YAML);
        expect(rec.values).not.toContain('Loading...');
    });

    it('ObjectYamlPanel mounts the editor with the fetched document', async () => {
        const props = {
            params: {
                clusterName: 'c', kind: 'Widget', group: 'example.com',
                resource: 'widgets', name: 'w1', namespace: 'default',
            },
        } as unknown as ComponentProps<typeof ObjectYamlPanel>;
        const { queryByTestId } = render(<ObjectYamlPanel {...props} />);

        expect(queryByTestId('monaco')).toBeNull();

        await waitFor(() => expect(rec.values.length).toBeGreaterThan(0));
        expect(rec.values[0]).toBe(OBJECT_YAML);
        expect(rec.values).not.toContain('Loading...');
    });
});
