import { describe, it, expect, beforeEach } from 'vitest';
import { takeAfterCrashAction, AFTER_CRASH_PARAM } from './afterCrash';

const at = (path: string) => window.history.replaceState(null, '', path);

describe('takeAfterCrashAction', () => {
    beforeEach(() => at('/'));

    it('is null on an ordinary load and leaves the URL alone', () => {
        at('/?x=1');
        expect(takeAfterCrashAction()).toBeNull();
        expect(window.location.search).toBe('?x=1');
    });

    it('returns the action once and strips only its own parameter', () => {
        at(`/?x=1&${AFTER_CRASH_PARAM}=diagnostics`);
        expect(takeAfterCrashAction()).toBe('diagnostics');
        expect(window.location.search).toBe('?x=1');
        // A later reload of this page must not open Diagnostics again.
        expect(takeAfterCrashAction()).toBeNull();
    });
});
