// The motion rules that CSS cannot express on its own. Durations and curves
// live in theme-monolith.css (--ease-out, --dur-in, …); this file only covers
// the two things that need script: telling the canvas-drawn editors about
// reduced motion, and marking the first render for the opening moment.

const REDUCE = '(prefers-reduced-motion: reduce)';

/**
 * True when the OS asks for reduced motion. The CSS block covers everything
 * the stylesheet draws; xterm and Monaco draw their cursors themselves, so they
 * read this to stop blinking. Guarded because jsdom has no matchMedia.
 */
export function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' && window.matchMedia?.(REDUCE).matches === true;
}

/** Longer than the screen-on animation (80ms delay + 400ms) with room to spare. */
const BOOT_WINDOW_MS = 1200;

/**
 * Sets `data-boot` on <html> for the first moments after launch, which is what
 * lets the screens light up once: the CSS keys the screen-on animation off the
 * attribute, so a panel opened or split later just appears. The window is well
 * past the animation's end, because taking the attribute away mid-animation
 * snaps a screen to full brightness.
 */
export function markBoot(): void {
    const root = document.documentElement;
    root.dataset.boot = '';
    window.setTimeout(() => { delete root.dataset.boot; }, BOOT_WINDOW_MS);
}
