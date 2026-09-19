---
description: Where to report a Kube Inspector bug, what to attach, how to request a feature, fix a translation, or report a security vulnerability privately.
---

# Support

Kube Inspector is an open-source project. There is no support desk — the issue
tracker is where everything happens, and a good report is what turns a problem
into a fix.

## Before you file

1. Check [Known limitations](known-limitations.md). Some behaviour that looks
   broken is deliberate and documented there.
2. Skim [Troubleshooting](troubleshooting.md) — the cluster-connection, empty-list
   and port-forward sections cover most reports.
3. Search [existing
   issues](https://github.com/opensourcemonkeys/kube-inspector/issues?q=is%3Aissue).

## Reporting a bug

**[Open a bug report →](https://github.com/opensourcemonkeys/kube-inspector/issues/new?template=bug_report.yml)**

The template asks for a **diagnostics blob**, and it is required. It carries the
version, platform, shell, health checks and — when you copy it from an error
banner — the exact failure you were looking at. Without it, almost every report
begins with a round-trip asking for it.

**To get one:**

- **From the error banner** you are looking at → **Copy diagnostics**. Best
  option: it includes the failing call and the panel it came from.
- Or **Help ▸ Diagnostics ▸ Export ▸ Copy report**.

Everything in it is redacted before it reaches your clipboard — home paths,
cluster names, secrets, base64 blobs and API server addresses. Two client-side
additions do not pass through that redactor (the error message you are looking
at, and any UI crash stack), so give the blob a quick read before posting it.

**Also useful, when the problem is not a one-liner:**

- Steps to reproduce, and what you expected instead.
- The Kubernetes distribution and version (`kubectl version --short`).
- Log lines from around the failure. **Help ▸ Diagnostics ▸ Logs** has a search
  box and a level control — set the level to `debug`, reproduce, then copy the
  relevant lines. **Export ▸ Save zip** bundles the report and the log files
  into one attachable file.
- A screenshot, for anything visual.

!!! tip "Attach the zip, do not paste the whole log"
    A day's log file can be large. `Save zip` produces a file you can attach;
    pasting thousands of lines into an issue body makes it harder to read, not
    easier.

## Requesting a feature

**[Open a feature request
→](https://github.com/opensourcemonkeys/kube-inspector/issues/new?template=feature_request.yml)**

Say what you are trying to do, not only what UI you want — the underlying task
often has a better answer than the one that comes to mind first. If `kubectl`
already does it, mentioning the command makes the request concrete.

## Fixing a translation

German, Russian, Chinese and Japanese were machine-translated and have not been
read by a fluent speaker. If a string is wrong, awkward, or unidiomatic, that is
expected and worth reporting.

**[Report a translation problem
→](https://github.com/opensourcemonkeys/kube-inspector/issues/new?template=translation_fix.yml)**

Even "this word is wrong, it should be X" is enough. Sending a pull request is
easier still — see [Translations](contributing/translations.md).

## Reporting a security vulnerability

**Do not open a public issue.** Use GitHub's [private vulnerability
reporting](https://github.com/opensourcemonkeys/kube-inspector/security/advisories/new)
on the repository, which reaches the maintainers without disclosing anything.

The full policy — supported versions, what is in scope, and the threat model
behind the loopback servers and tokens — is in
[SECURITY.md](https://github.com/opensourcemonkeys/kube-inspector/blob/main/.github/SECURITY.md).

## Contributing a fix

Pull requests are welcome. The
[contributing guide](https://github.com/opensourcemonkeys/kube-inspector/blob/main/.github/CONTRIBUTING.md)
covers the build prerequisites (including the mandatory `GOEXPERIMENT=jsonv2`),
the `make check` gate, and the conventions the codebase follows.

## Beta expectations

This is a beta release. It talks to real clusters and can delete, scale and
restart real workloads. Bugs are expected, reports are wanted, and nothing here
is a guarantee of a response time.
