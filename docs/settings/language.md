---
description: Switch Kube Inspector's interface language between English, Turkish, German, Russian, Chinese and Japanese — and what "machine-translated" means for four of them.
---

# Language

Kube Inspector's interface is available in six languages. The choice is
per-machine and persists across restarts.

## Changing it

**Open ▸ Language**, then pick one:

| | | Status |
|---|---|---|
| English | `en` | Source of truth |
| Türkçe | `tr` | Reviewed by a native speaker |
| Deutsch | `de` | Machine-translated |
| Русский | `ru` | Machine-translated |
| 中文 | `zh` | Machine-translated |
| 日本語 | `ja` | Machine-translated |

Each language is listed in its own name, so someone who landed in a language
they cannot read can still find the way back.

The change applies immediately — no restart. The catalog is fetched on demand,
so for a moment after switching you may see a few strings still in English while
it loads.

## What "machine-translated" means

German, Russian, Chinese and Japanese were translated from English **by
machine** and have **not been read by anyone who speaks the language**.

What was checked, mechanically:

- every English key exists in every catalog, and nothing extra;
- every interpolated value (`{{count}}`, `{{name}}`) survived translation — a
  dropped placeholder is the most common machine-translation defect;
- plural forms match the language's own CLDR categories, not English's two
  (Russian owes four; Chinese and Japanese owe one);
- inline markup was not renumbered or dropped.

What was **not** checked: whether the wording is right. Expect stiff phrasing,
the occasional wrong term, and translations of things that should have stayed in
English.

The language submenu says so, with a link to the correction guide, because the
person best placed to notice is the one reading it.

## What is never translated

Anything the cluster said, and Kubernetes' own vocabulary. Resource kinds
(`Pod`, `DaemonSet`, `ConfigMap`), field names, statuses coming from the API,
error text from the API server, YAML content and log output all stay exactly as
Kubernetes produced them — translating them would break the connection between
what you read here and what `kubectl` prints.

## Reporting or fixing a translation

Corrections are the easiest contribution this project takes, and they are
wanted.

- **Report it** — [translation issue
  template](https://github.com/opensourcemonkeys/kube-inspector/issues/new?template=translation_fix.yml).
  "This word is wrong, it should be X" is a complete report.
- **Fix it** — see [Translations](../contributing/translations.md). It is a JSON
  value change plus one command.

Moving a language from *machine-translated* to *reviewed* means someone fluent
read all six catalog files — not that the obvious mistakes were fixed.

## Related

- [Translations](../contributing/translations.md)
- [Known limitations](../known-limitations.md#languages)
