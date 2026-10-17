import { describe, expect, it } from 'vitest';
import { createLogBuffer } from './logBuffer';

describe('createLogBuffer', () => {
    it('joins a line split across chunks', () => {
        const b = createLogBuffer(100);
        b.push('a', 'hel');
        b.push('a', 'lo\nwor');
        expect(b.text()).toBe('hello\nwor');
        b.push('a', 'ld\n');
        expect(b.text()).toBe('hello\nworld');
    });

    it('keeps partial lines of different sources apart', () => {
        const b = createLogBuffer(100);
        b.push('pod-1', 'first ha', '[pod-1] ');
        b.push('pod-2', 'other\n', '[pod-2] ');
        b.push('pod-1', 'lf\n', '[pod-1] ');
        expect(b.text()).toBe('[pod-2] other\n[pod-1] first half');
    });

    it('prefixes every line of a multi-line chunk', () => {
        const b = createLogBuffer(100);
        b.push('s', 'a\nb\nc\n', '[x] ');
        expect(b.text()).toBe('[x] a\n[x] b\n[x] c');
    });

    it('turns a partial line into a complete one when its source ends', () => {
        const b = createLogBuffer(100);
        b.push('s', 'no newline');
        b.end('s');
        b.push('s', 'next\n');
        expect(b.text()).toBe('no newline\nnext');
    });

    it('keeps only the newest lines and reports truncation', () => {
        const b = createLogBuffer(3);
        b.push('s', '1\n2\n3\n');
        expect(b.truncated).toBe(false);
        b.push('s', '4\n5\n');
        expect(b.text()).toBe('3\n4\n5');
        expect(b.truncated).toBe(true);
    });

    it('clear resets lines, partial lines and the truncation flag', () => {
        const b = createLogBuffer(1);
        b.push('s', '1\n2\npartial');
        b.text();
        b.clear();
        expect(b.text()).toBe('');
        expect(b.truncated).toBe(false);
    });

    it('notes are complete lines of their own', () => {
        const b = createLogBuffer(10);
        b.push('s', 'half');
        b.note('[stream ended]');
        expect(b.text()).toBe('[stream ended]\nhalf');
    });
});
