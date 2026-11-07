import { parseAllDocuments } from 'yaml';
import type { models } from '../../../../wailsjs/go/models';

/**
 * The key/value editor's model, shared by the ConfigMap and Secret editors.
 * Pure functions only, so the rules (what changed, what the API server will
 * refuse, how a conflict is rebased) are tested without a cluster.
 */

export type DataKind = 'ConfigMap' | 'Secret';

/**
 * One key as the editor holds it. A text value is the text itself and a
 * binary one stays base64 end to end, so bytes the editor never touched go
 * back exactly as they came.
 */
export interface Entry {
    id: number;
    key: string;
    value: string;
    binary: boolean;
    /** The key at load time; undefined for a key added in the editor. */
    origKey?: string;
    /** Marked for removal; kept in the list so it can be restored. */
    deleted?: boolean;
}

export type EntryStatus = 'new' | 'modified' | 'deleted' | 'unchanged';

let idCounter = 0;
export const nextEntryId = () => ++idCounter;

const encoder = new TextEncoder();

export function bytesToBase64(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

export const textToBase64 = (text: string) => bytesToBase64(encoder.encode(text));

/** The bytes as text, or null when they are not UTF-8 (or hold a NUL). */
export function bytesToText(bytes: Uint8Array): string | null {
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return text.includes('\0') ? null : text;
    } catch {
        return null;
    }
}

/** Builds the editor's entries from what GetDataObject returned. */
export function entriesFromObject(entries: models.DataEntry[]): Entry[] {
    return entries.map((e) => {
        const text = e.binary ? null : bytesToText(base64ToBytes(e.value));
        return text === null
            ? { id: nextEntryId(), key: e.key, value: e.value, binary: true, origKey: e.key }
            : { id: nextEntryId(), key: e.key, value: text, binary: false, origKey: e.key };
    });
}

/** What SaveDataObject takes: every live entry, values base64. */
export function entriesForSave(draft: Entry[]): models.DataEntry[] {
    return draft
        .filter((e) => !e.deleted)
        .map((e) => ({ key: e.key, value: e.binary ? e.value : textToBase64(e.value), binary: e.binary }));
}

export function byteSize(e: Pick<Entry, 'value' | 'binary'>): number {
    if (!e.binary) return encoder.encode(e.value).length;
    const pad = e.value.endsWith('==') ? 2 : e.value.endsWith('=') ? 1 : 0;
    return Math.floor((e.value.length * 3) / 4) - pad;
}

export function entryStatus(e: Entry, original: Map<string, Entry>): EntryStatus {
    if (e.origKey === undefined) return 'new';
    if (e.deleted) return 'deleted';
    const o = original.get(e.origKey);
    if (!o || o.key !== e.key || o.value !== e.value || o.binary !== e.binary) return 'modified';
    return 'unchanged';
}

export const originalByKey = (original: Entry[]) => new Map(original.map((e) => [e.key, e]));

export type KeyProblem = 'empty' | 'chars' | 'length' | 'dots' | 'duplicate';

const KEY_CHARS = /^[-._a-zA-Z0-9]+$/;

/**
 * Mirrors the API server's IsConfigMapKey plus the duplicate check, so a bad
 * key is marked while it is typed instead of failing the save.
 */
export function keyProblem(key: string, draft: Entry[], id: number): KeyProblem | null {
    if (key === '') return 'empty';
    if (key.length > 253) return 'length';
    if (!KEY_CHARS.test(key)) return 'chars';
    if (key === '.' || key === '..' || key.startsWith('..')) return 'dots';
    if (draft.some((e) => e.id !== id && !e.deleted && e.key === key)) return 'duplicate';
    return null;
}

export const hasKeyProblems = (draft: Entry[]) =>
    draft.some((e) => !e.deleted && keyProblem(e.key, draft, e.id) !== null);

/** Monaco language for a key, from its extension. Unknown is plain text. */
export function languageFor(key: string): string {
    const ext = key.toLowerCase().split('.').pop() ?? '';
    switch (ext) {
        case 'yaml': case 'yml': return 'yaml';
        case 'ini': case 'properties': case 'conf': case 'cfg': case 'toml': case 'env': return 'ini';
        case 'sh': case 'bash': return 'shell';
        case 'xml': case 'html': case 'svg': return 'xml';
        default: return 'plaintext';
    }
}

export interface ParseProblem { line: number; column: number; message: string }

/** A syntax error in a .json/.yaml value, located for an editor marker. */
export function parseProblem(key: string, text: string): ParseProblem | null {
    const ext = key.toLowerCase().split('.').pop() ?? '';
    if (ext === 'json') {
        try {
            JSON.parse(text);
            return null;
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            const pos = /position (\d+)/.exec(message);
            if (pos) {
                const before = text.slice(0, Number(pos[1])).split('\n');
                return { line: before.length, column: before[before.length - 1].length + 1, message };
            }
            return { line: 1, column: 1, message };
        }
    }
    if (ext === 'yaml' || ext === 'yml') {
        for (const doc of parseAllDocuments(text)) {
            const err = doc.errors[0];
            if (err) {
                const [line, column] = err.linePos?.[0] ? [err.linePos[0].line, err.linePos[0].col] : [1, 1];
                return { line, column, message: err.message.split('\n')[0] };
            }
        }
    }
    return null;
}

export type Change =
    | { kind: 'added'; key: string; entry: Entry }
    | { kind: 'removed'; key: string; before: Entry }
    | { kind: 'modified'; key: string; before: Entry; entry: Entry; renamedFrom?: string };

/** Every change the draft makes to the original, in key order. */
export function diffEntries(original: Entry[], draft: Entry[]): Change[] {
    const orig = originalByKey(original);
    const out: Change[] = [];
    for (const e of draft) {
        if (e.origKey === undefined) {
            if (!e.deleted) out.push({ kind: 'added', key: e.key, entry: e });
            continue;
        }
        const before = orig.get(e.origKey);
        if (!before) continue;
        if (e.deleted) {
            out.push({ kind: 'removed', key: before.key, before });
        } else if (entryStatus(e, orig) === 'modified') {
            out.push({ kind: 'modified', key: e.key, before, entry: e, renamedFrom: e.key !== before.key ? before.key : undefined });
        }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Re-applies the draft's changes onto the object as it is now, for "apply
 * mine" after a conflict: keys the user did not touch take the newer value,
 * keys they did take theirs. The result is a fresh draft over `latest`.
 */
export function rebaseDraft(original: Entry[], draft: Entry[], latest: Entry[]): Entry[] {
    const next = latest.map((e) => ({ ...e, id: nextEntryId() }));
    const find = (key: string) => next.find((e) => e.key === key && !e.deleted);
    for (const c of diffEntries(original, draft)) {
        if (c.kind === 'removed') {
            const hit = find(c.key);
            if (hit) hit.deleted = true;
            continue;
        }
        if (c.kind === 'modified' && c.renamedFrom) {
            const old = find(c.renamedFrom);
            if (old) old.deleted = true;
        }
        const hit = find(c.key);
        if (hit) {
            hit.value = c.entry.value;
            hit.binary = c.entry.binary;
        } else {
            next.push({ id: nextEntryId(), key: c.key, value: c.entry.value, binary: c.entry.binary });
        }
    }
    return next.sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// kubernetes.io/dockerconfigjson

export interface Registry { id: number; server: string; username: string; password: string; email: string }

/**
 * The registries in a .dockerconfigjson, or null when the text is not one
 * the form can show without losing anything (the raw editor takes over).
 */
export function parseDockerConfig(text: string): Registry[] | null {
    if (text.trim() === '') return [];
    let doc: unknown;
    try {
        doc = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof doc !== 'object' || doc === null) return null;
    const keys = Object.keys(doc);
    if (keys.some((k) => k !== 'auths')) return null;
    const auths = (doc as { auths?: unknown }).auths ?? {};
    if (typeof auths !== 'object' || auths === null) return null;
    const out: Registry[] = [];
    for (const [server, raw] of Object.entries(auths as Record<string, unknown>)) {
        if (typeof raw !== 'object' || raw === null) return null;
        const a = raw as Record<string, unknown>;
        if (Object.keys(a).some((k) => !['username', 'password', 'email', 'auth'].includes(k))) return null;
        let username = typeof a.username === 'string' ? a.username : '';
        let password = typeof a.password === 'string' ? a.password : '';
        if (!username && typeof a.auth === 'string') {
            const pair = bytesToText(base64ToBytes(a.auth)) ?? '';
            const i = pair.indexOf(':');
            if (i >= 0) [username, password] = [pair.slice(0, i), pair.slice(i + 1)];
        }
        out.push({ id: nextEntryId(), server, username, password, email: typeof a.email === 'string' ? a.email : '' });
    }
    return out;
}

export function buildDockerConfig(registries: Registry[]): string {
    const auths: Record<string, Record<string, string>> = {};
    for (const r of registries) {
        if (!r.server) continue;
        const a: Record<string, string> = {
            username: r.username,
            password: r.password,
            auth: textToBase64(`${r.username}:${r.password}`),
        };
        if (r.email) a.email = r.email;
        auths[r.server] = a;
    }
    return JSON.stringify({ auths }, null, 2);
}
