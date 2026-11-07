import { describe, expect, it } from 'vitest';
import {
    base64ToBytes, buildDockerConfig, byteSize, diffEntries, entriesForSave, entriesFromObject,
    keyProblem, languageFor, parseDockerConfig, parseProblem, rebaseDraft, textToBase64, type Entry,
} from './dataEditorModel';

const load = (pairs: Record<string, string>, binary: Record<string, string> = {}) =>
    entriesFromObject([
        ...Object.entries(pairs).map(([key, v]) => ({ key, value: textToBase64(v), binary: false })),
        ...Object.entries(binary).map(([key, value]) => ({ key, value, binary: true })),
    ]);

const clone = (es: Entry[]) => es.map((e) => ({ ...e }));

describe('entries', () => {
    it('keeps text as text and non-UTF-8 as base64', () => {
        const raw = btoa(String.fromCharCode(0xff, 0xfe, 0x00));
        const es = entriesFromObject([
            { key: 'a', value: textToBase64('héllo'), binary: false },
            { key: 'b', value: raw, binary: false },
        ]);
        expect(es[0]).toMatchObject({ value: 'héllo', binary: false });
        expect(es[1]).toMatchObject({ value: raw, binary: true });
        expect(byteSize(es[0])).toBe(6);
        expect(byteSize(es[1])).toBe(3);
    });

    it('sends untouched binary values back unchanged and drops deleted keys', () => {
        const raw = btoa(String.fromCharCode(1, 2, 250));
        const draft = load({ a: 'x', gone: 'y' }, { bin: raw });
        draft.find((e) => e.key === 'gone')!.deleted = true;
        const out = entriesForSave(draft);
        expect(out.map((e) => e.key)).toEqual(['a', 'bin']);
        expect(out[1]).toEqual({ key: 'bin', value: raw, binary: true });
        expect(Array.from(base64ToBytes(out[0].value))).toEqual([120]);
    });
});

describe('keyProblem', () => {
    const draft = load({ a: '1', b: '2' });
    it('mirrors the API server rules', () => {
        expect(keyProblem('', draft, -1)).toBe('empty');
        expect(keyProblem('has space', draft, -1)).toBe('chars');
        expect(keyProblem('..x', draft, -1)).toBe('dots');
        expect(keyProblem('x'.repeat(254), draft, -1)).toBe('length');
        expect(keyProblem('a', draft, -1)).toBe('duplicate');
        expect(keyProblem('a', draft, draft[0].id)).toBeNull();
        expect(keyProblem('app.yaml', draft, -1)).toBeNull();
    });
});

describe('diffEntries', () => {
    it('reports added, removed, modified and renamed keys', () => {
        const original = load({ keep: '1', edit: '2', drop: '3', old: '4' });
        const draft = clone(original);
        draft.find((e) => e.key === 'edit')!.value = '22';
        draft.find((e) => e.key === 'drop')!.deleted = true;
        draft.find((e) => e.key === 'old')!.key = 'new-name';
        draft.push({ id: 999, key: 'added', value: 'v', binary: false });
        const changes = diffEntries(original, draft);
        expect(changes.map((c) => `${c.kind}:${c.key}`)).toEqual(['added:added', 'removed:drop', 'modified:edit', 'modified:new-name']);
        const renamed = changes.find((c) => c.key === 'new-name');
        expect(renamed && renamed.kind === 'modified' && renamed.renamedFrom).toBe('old');
    });

    it('is empty for an untouched draft', () => {
        const original = load({ a: '1' });
        expect(diffEntries(original, clone(original))).toEqual([]);
    });
});

describe('rebaseDraft', () => {
    it('keeps the newer value of keys the user did not touch', () => {
        const original = load({ a: '1', b: '2', c: '3' });
        const draft = clone(original);
        draft.find((e) => e.key === 'a')!.value = 'mine';
        draft.find((e) => e.key === 'c')!.deleted = true;
        const latest = load({ a: '1', b: 'theirs', c: '3', d: 'new-upstream' });
        const out = rebaseDraft(original, draft, latest);
        const live = Object.fromEntries(out.filter((e) => !e.deleted).map((e) => [e.key, e.value]));
        expect(live).toEqual({ a: 'mine', b: 'theirs', d: 'new-upstream' });
        expect(diffEntries(latest, out).map((c) => `${c.kind}:${c.key}`)).toEqual(['modified:a', 'removed:c']);
    });
});

describe('languageFor / parseProblem', () => {
    it('picks a grammar from the extension', () => {
        expect(languageFor('application.YAML')).toBe('yaml');
        expect(languageFor('nginx.conf')).toBe('ini');
        expect(languageFor('entry.sh')).toBe('shell');
        expect(languageFor('LOG_LEVEL')).toBe('plaintext');
    });

    it('locates JSON and YAML errors', () => {
        expect(parseProblem('a.json', '{"a": 1}')).toBeNull();
        expect(parseProblem('a.json', '{\n  "a": 1,\n}')?.line).toBe(3);
        expect(parseProblem('a.yaml', 'a: 1\nb: [')).not.toBeNull();
        expect(parseProblem('a.yaml', 'a: 1\n')).toBeNull();
        expect(parseProblem('notes.txt', '{')).toBeNull();
    });
});

describe('docker config', () => {
    it('round-trips registries, reading auth when username is absent', () => {
        const text = JSON.stringify({ auths: { 'ghcr.io': { auth: btoa('bob:s3cret') } } });
        const regs = parseDockerConfig(text)!;
        expect(regs).toHaveLength(1);
        expect(regs[0]).toMatchObject({ server: 'ghcr.io', username: 'bob', password: 's3cret' });
        const again = JSON.parse(buildDockerConfig(regs));
        expect(again.auths['ghcr.io']).toEqual({ username: 'bob', password: 's3cret', auth: btoa('bob:s3cret') });
    });

    it('declines content the form would lose', () => {
        expect(parseDockerConfig('{"auths":{},"credsStore":"x"}')).toBeNull();
        expect(parseDockerConfig('not json')).toBeNull();
        expect(parseDockerConfig('')).toEqual([]);
    });
});
