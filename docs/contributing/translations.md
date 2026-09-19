---
description: Fix or improve a Kube Inspector translation — where the catalogs live, the rules the parity checker enforces, and how to add a new language.
---

# Translations

Four of Kube Inspector's six interface languages were translated by machine and
have never been read by a fluent speaker. If you found a string that is wrong,
you found something worth fixing — and this is the smallest useful contribution
the project takes.

**You do not have to open a pull request.** A sentence on the
[translation issue
template](https://github.com/opensourcemonkeys/kube-inspector/issues/new?template=translation_fix.yml)
naming the wrong string and what it should say is enough.

## Where the strings live

```
frontend/src/locales/
├── en/          ← source of truth, hand-written
├── tr/          ← reviewed by a native speaker
├── de/  ru/  zh/  ja/     ← machine-translated
├── GLOSSARY.md  ← the do-not-translate list
└── README.md    ← the full contributor reference
```

Each locale is six JSON files:

| File | Holds |
|---|---|
| `common.json` | Verbs and filter chrome reused everywhere (`action.delete`, `filter.all`) |
| `nav.json` | Sidebar groups and items, the title-bar menus, window controls |
| `resources.json` | Table column headers, list titles, empty states, the delete flow |
| `panels.json` | Panel titles, the About and Update modals, the onboarding tour |
| `errors.json` | The error banner and the crash boundary |
| `settings.json` | The theme and language pickers |

## Fixing a string

1. Find the key. Search the English value in `en/` to get the key, then edit the
   same key in your language's file.
2. **Change the value, never the key.** Keys are shared across all six locales.
3. Keep every `{{placeholder}}` exactly as it appears in English. They are
   substituted at runtime; a dropped one leaves a gap in the sentence.
4. Keep inline markup indices (`<1>…</1>`) — you may reorder them if your
   language needs a different clause order, but do not renumber or drop them.
5. Run the checker:

```bash
cd frontend
npm run i18n:check
```

That is the whole workflow. No build, no app run required for a wording change.

## What the checker enforces

`npm run i18n:check` (also part of `make check` and CI) **fails** when:

1. a namespace file exists in `en` and not in a locale, or the reverse;
2. a catalog directory exists for a language that is not registered in the app;
3. a key in `en` is missing from a locale — that string would silently fall back
   to English;
4. a locale has a key `en` does not — dead weight nobody would notice;
5. a plural family does not match that language's CLDR categories;
6. a locale's interpolation placeholders differ from `en`'s;
7. an inline markup index was dropped or renumbered.

It **warns** when more than 20% of a file's values are still byte-identical to
English, which is the signature of a copied-but-untranslated file.

### Plurals

i18next suffixes, and each language owes exactly its own forms — do not copy
English's:

| Language | Forms |
|---|---|
| `en`, `tr`, `de` | `_one`, `_other` |
| `ru` | `_one`, `_few`, `_many`, `_other` |
| `zh`, `ja` | `_other` only |

## What must stay in English

See `GLOSSARY.md` in the locales directory. In short: **anything the cluster
said, and every Kubernetes proper noun.**

Resource kinds (`Pod`, `DaemonSet`, `ConfigMap`, `PersistentVolumeClaim`), field
names, API statuses, YAML, log output and error text from the API server are
left exactly as Kubernetes produces them. A user reading a translated UI still
has to be able to match what they see against `kubectl` output and the
Kubernetes documentation.

Column headers are shared across views on purpose — `Name` appears in 25 lists
and has one key. Translating it once keeps the same word from drifting between
views.

## Adding a language

1. Copy `en/` to `<lang>/` and translate the values, keeping `en`'s key order so
   the diff stays readable.
2. Register it in `LOCALES` in `frontend/src/stores/localeStore.ts`.
3. `npm run i18n:check` must pass. Do all six files in one go — a half-copied
   directory fails on purpose.

A language registered without a catalog is not an error: the picker offers it
and every string falls back to English. That is the documented state a language
sits in before anyone has translated it.

## Getting a language marked "reviewed"

Turkish is the only non-English catalog marked reviewed, because a native
speaker read it end to end. To move another one:

- read all six files in that language, not just the strings you noticed;
- open a pull request with the corrections;
- say in the PR that you are a fluent speaker and that you reviewed the whole
  catalog.

The status table in `frontend/src/locales/README.md` and on the
[Language](../settings/language.md) page is then updated in the same PR.

## Related

- [Language](../settings/language.md) — the user-facing side
- [Support](../support.md)
- [Contributing
  guide](https://github.com/opensourcemonkeys/kube-inspector/blob/main/.github/CONTRIBUTING.md)
