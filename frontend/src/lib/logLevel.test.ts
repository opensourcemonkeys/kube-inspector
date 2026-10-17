import { describe, expect, it } from 'vitest';
import { findLevel } from './logLevel';

function token(text: string) {
    const m = findLevel(text);
    return m ? { word: text.slice(m.start, m.end), level: m.level } : null;
}

describe('findLevel', () => {
    it('finds upper-case level words', () => {
        expect(token('2026-10-17 ERROR failed to bind')).toEqual({ word: 'ERROR', level: 'error' });
        expect(token('WARN disk almost full')).toEqual({ word: 'WARN', level: 'warn' });
        expect(token('[pod-1/app] INFO started')).toEqual({ word: 'INFO', level: 'info' });
        expect(token('PANIC: nil map')).toEqual({ word: 'PANIC', level: 'fatal' });
    });

    it('finds key/value levels in any case and colours only the value', () => {
        expect(token('time=now level=error msg="boom"')).toEqual({ word: 'error', level: 'error' });
        expect(token('{"level":"warn","msg":"slow"}')).toEqual({ word: 'warn', level: 'warn' });
        expect(token('lvl=dbug msg=x')).toEqual({ word: 'dbug', level: 'debug' });
    });

    it('finds bracketed lower-case levels', () => {
        expect(token('2026/10/17 [info] listening')).toEqual({ word: 'info', level: 'info' });
    });

    it('finds the klog header letter', () => {
        expect(token('E1017 12:00:00.123456       1 reflector.go:1] failed')).toEqual({ word: 'E', level: 'error' });
        expect(token('2026-10-17T12:00:00Z W1017 12:00:00.1 x')).toEqual({ word: 'W', level: 'warn' });
    });

    it('ignores level words inside prose', () => {
        expect(token('no error occurred, see info page')).toBeNull();
        expect(token('ERRORS were not counted')).toBeNull();
    });

    it('takes the first level on the line', () => {
        expect(token('INFO retrying after ERROR')).toEqual({ word: 'INFO', level: 'info' });
    });

    it('skips a key/value level it does not recognise', () => {
        expect(token('level=5 WARN odd')).toEqual({ word: 'WARN', level: 'warn' });
    });
});
