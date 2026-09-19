# Contributing to Kube Inspector

Thanks for being here. Bug reports, translation fixes and pull requests are all
welcome.

- **Found a bug?** [Open a bug report](https://github.com/opensourcemonkeys/kube-inspector/issues/new?template=bug_report.yml) — the diagnostics blob it asks for is required and saves a round-trip.
- **A string reads wrong in your language?** That is expected for German, Russian, Chinese and Japanese, and [fixing it](https://kubeinspector.com/contributing/translations/) is the smallest useful contribution here.
- **Found a security problem?** Do not open an issue — see [SECURITY.md](SECURITY.md).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Go | 1.26+ | |
| Node.js | 20+ | |
| Wails CLI | latest | generates the TypeScript bindings |
| golangci-lint | latest | optional locally, mandatory in CI |
| nfpm | latest | only for `make pkg-deb` / `pkg-rpm` |
| Python + MkDocs Material | | only for the docs site |

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@latest
```

### `GOEXPERIMENT=jsonv2` is mandatory

The bundled Trivy scanner pulls in `encoding/json/v2`, which is gated behind the
`jsonv2` GOEXPERIMENT. **The `Makefile` exports it for every target and CI sets
it in the workflow environment** — but a bare `go build`, `go test`, `go vet` or
`wails` invocation must set it itself:

```bash
GOEXPERIMENT=jsonv2 go test ./...
```

Without it the build fails with
`build constraints exclude all Go files in .../encoding/json/v2`.

## Running it

```bash
make dev
```

One command: it starts the Go backend, Vite and Electron, and shuts all three
down together on Ctrl-C. Individual pieces (`make electron-dev-go`,
`-vite`, `electron-dev`) exist for debugging one of them alone, and
`make dev-wails` drives the old Wails/system-webview loop.

**Electron is the shipped GUI. Wails is development-only and is not packaged.**

```bash
make dev-tui      # the terminal UI alone
```

### Bindings

`frontend/wailsjs` is generated and git-ignored. `make bindings` creates it when
missing, but it does **not** refresh a stale one. After changing an exported
`App` method or a struct in `internal/models`:

```bash
rm -rf frontend/wailsjs && make bindings
```

Never edit anything under `frontend/wailsjs` by hand.

## Before you open a pull request

```bash
make check
```

That runs, in order: `go test`, `go vet`, `golangci-lint`, then `tsc --noEmit`,
ESLint, the i18n catalog parity checker and the frontend tests. CI runs the same
gates plus a `mkdocs --strict` docs build, so a green `make check` is a good
predictor.

Two invariants CI enforces that are easy to break locally:

```bash
# The CLI must stay Wails-free — it is what makes the terminal build
# dependency-free.
grep -rn "wailsapp/wails" internal/tui cmd/tui        # must be empty

# Every goroutine goes through internal/safego, which recovers and logs panics.
grep -rn "go func()" internal/services internal/controller internal/ipc   # must be empty
```

## Conventions

Read [`CLAUDE.md`](../CLAUDE.md) in the repository root before a first
non-trivial change — it is the architecture document, and it explains *why*
several non-obvious things are the way they are.

### Adding a resource type

Each Kubernetes resource is a parallel triple plus a thin frontend config:

```
internal/models/<kind>Info.go        struct returned to the frontend
internal/services/<kind>Services.go  the client-go call, takes a *kubernetes.Clientset
internal/business/<kind>.go          takes clusterName, builds the client, calls the service
internal/controller/functionBuilder.go   one exported method, bound by Wails
frontend/src/components/<kind>/main.tsx  a config over ResourceListView
```

Two rules that are not optional:

- **Every resource-fetching business function takes `clusterName` first** and
  builds its client with `repository.NewK8sClientForCluster(clusterName)`. That
  is what pins each panel to the cluster it was opened with, regardless of the
  globally selected one.
- **Build list views on `components/shared/ResourceListView.tsx`.** Do not
  hand-roll the DataTable, the poll loop, the delete flow or the error banner —
  `lib/useResourceList.ts` owns all of it. Only genuinely different layouts
  (Nodes, Resource Quotas, Events, Monitoring) are hand-written.

Also register the component in `DockviewContainer.tsx`, add the sidebar entry in
`menu/menuItems.tsx`, and add the resource to `internal/tui/registry.go` if it
belongs in the terminal UI too.

### Every user-facing string goes through `t()`

`i18next/no-literal-string` runs as an **error** over `src/components/**` and
`src/pages/**`, so a hardcoded string fails `npm run lint`.

- Add the English value to the right namespace under
  `frontend/src/locales/en/`, then add the same key to the other five locales.
- `npm run i18n:check` must pass — it fails on a missing key, an extra key, a
  dropped `{{placeholder}}`, wrong plural forms and renumbered `<Trans>` markup.
- **What never gets translated:** anything the cluster said, and every
  Kubernetes proper noun. See `frontend/src/locales/GLOSSARY.md`.
- A genuine exception carries `eslint-disable-next-line` **with a reason**.

Full reference: [`frontend/src/locales/README.md`](../frontend/src/locales/README.md).

### Logging

- Use `internal/logging`; call `logging.With("pkg.name")` **at the log site**,
  never in a package-level variable (that binds before `Init` and captures the
  discard handler).
- **Never write to `os.Stdout`.** Stdout is the protocol pipe carrying the RPC
  URL and shell token to the Electron shell; one stray byte hangs startup.
- Never call `slog.SetDefault`.

### Goroutines

`safego.Go("pkg.thing", func(){ … })`, never a bare `go func()`. Neither shell
recovers a panic from a goroutine it did not start, so a bare one takes the
process down.

### Documentation

Docs live in `docs/` (MkDocs Material). Adding a page means:

1. a unique `description:` in the front matter — it feeds the meta description,
   the social card and the `llms.txt` entry;
2. an entry in `mkdocs.yml`'s `nav`.

`sitemap.xml`, `llms.txt` and `llms-full.txt` regenerate from the nav; there is
nothing to hand-edit.

```bash
make docs-serve    # live preview
make docs-build    # --strict, catches broken links and missing nav entries
```

## Commits and pull requests

- One logical change per pull request; a green `make check` before you open it.
- Explain **why** in the description, not only what — the codebase's comments
  are written the same way and it is the convention here.
- Note any user-visible change so it can reach `CHANGELOG.md`.
- Cross-platform behaviour (Linux/macOS/Windows differences in packaging,
  updating or the shell) is worth calling out explicitly; the CI matrix does not
  test everything.

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
