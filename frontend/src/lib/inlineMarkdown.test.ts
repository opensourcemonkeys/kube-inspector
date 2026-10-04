import { describe, it, expect } from 'vitest';
import { parseInline } from './inlineMarkdown';

describe('parseInline', () => {
    it('leaves plain text alone', () => {
        expect(parseInline('no markup here')).toEqual(['no markup here']);
    });

    it('parses bold, code and italic in order', () => {
        expect(parseInline('**A shell.** Uses `nsenter` and is *fast*.')).toEqual([
            { kind: 'strong', children: ['A shell.'] },
            ' Uses ',
            { kind: 'code', text: 'nsenter' },
            ' and is ',
            { kind: 'em', children: ['fast'] },
            '.',
        ]);
    });

    it('keeps markup inside code literal', () => {
        expect(parseInline('`**not bold**`')).toEqual([{ kind: 'code', text: '**not bold**' }]);
    });

    it('parses nested markup inside bold and links', () => {
        expect(parseInline('**`Ctrl+C` copies**')).toEqual([
            { kind: 'strong', children: [{ kind: 'code', text: 'Ctrl+C' }, ' copies'] },
        ]);
        expect(parseInline('see [the repo](https://github.com/x/y)')).toEqual([
            'see ',
            { kind: 'link', href: 'https://github.com/x/y', children: ['the repo'] },
        ]);
    });

    // CHANGELOG prose is full of characters that only look like markup.
    it('treats unclosed or stray markers as text', () => {
        expect(parseInline('an unclosed **bold')).toEqual(['an unclosed **bold']);
        expect(parseInline('a [bracket] with no link')).toEqual(['a [bracket] with no link']);
        expect(parseInline('2 * 3 = 6')).toEqual(['2 * 3 = 6']);
    });
});
