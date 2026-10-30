# --match: the in-cluster toolbox ships on its own toolbox-v* tags, which a bare
# `git describe --tags` would also pick up.
VERSION := $(shell git describe --tags --abbrev=0 --match 'v[0-9]*' | sed 's/^v//')
LDFLAGS := -X 'kube-ins/internal/business.appVersion=$(VERSION)' -s -w

# The Trivy library (security scanner) depends on encoding/json/v2, which is
# gated behind the jsonv2 GOEXPERIMENT on Go 1.26; 1.27, which go.mod now
# requires, enables it by default. Still exported, harmlessly, so every
# wails/go invocation in this Makefile (build, dev, packaging) compiles it on
# either.
export GOEXPERIMENT := jsonv2
export GOFLAGS := -trimpath -buildvcs=false
NFPM    := nfpm
DIST    := ./dist

# Public base URL the release artifacts are served from. The in-app updater
# resolves its per-platform download from docs/version.json, which is generated
# against this (see the docs-downloads target).
DIST_BASE_URL := https://kubeinspector.com/dist
DOWNLOAD_PAGE_URL := https://kubeinspector.com/downloads/

# What the `stable` update channel points at: the highest tag with no prerelease
# suffix. A scan rather than $(VERSION), because tagging a -beta must leave the
# stable channel exactly where it was — otherwise a v1.1.0-alpha would offer
# itself to every user running a stable build.
#
# `sed '/-/d'` rather than `grep -v -- '-'`: a lone "-" is ambiguous to some grep
# implementations (ugrep reads it as a missing pattern). And `sort -V` runs only
# *after* the prereleases are gone — it is not SemVer-correct across them, as it
# orders v0.16.0 before v0.16.0-beta.1.
#
# This is legitimately empty until the first non-prerelease tag exists; see the
# empty branch of emit_manifest below.
STABLE_VERSION := $(shell git tag --list 'v*' | sed '/-/d' | sed 's/^v//' | sort -V | tail -1)

# Optional Wails build tags. On distros that ship webkit2gtk-4.1 instead of
# 4.0 (Ubuntu 24.04+, Fedora 40+), build with: make build-linux WAILS_TAGS=webkit2_41
TAGS    := $(if $(WAILS_TAGS),-tags "$(WAILS_TAGS)",)

# ── Wails shell: debugging only ─────────────────────────────────────────────
# The shipped GUI is the Electron shell, and so is `make dev`. These stay for
# debugging against the system webview; they produce no release artifact and
# nothing here is used by CI.
build:
	wails build $(TAGS) -ldflags "$(LDFLAGS)"

build-linux:
	wails build $(TAGS) -platform linux/amd64 -ldflags "$(LDFLAGS)"

build-windows:
	wails build -platform windows/amd64 -nsis -ldflags "$(LDFLAGS)"

build-mac:
	wails build -platform darwin/universal -ldflags "$(LDFLAGS)"

dev-wails:
	wails dev -ldflags "-X 'kube-ins/internal/business.appVersion=$(VERSION)-dev'"

# Fast TUI development: runs the webview-free CLI directly. There is no
# Vite-style hot reload (the TUI takes over the whole terminal); the loop is
# edit → quit with q → `make dev-tui` again. The Go build cache keeps every
# rebuild after the first one quick.
dev-tui:
	go run $(GOFLAGS) -tags tui -ldflags "-X 'kube-ins/internal/business.appVersion=$(VERSION)-dev'" ./cmd/tui

# ── Standalone terminal UI (kube-inspector-cli) ──────────────────
# A webview-free native CLI binary (cmd/tui). Plain `go build` — no wails, no
# frontend embed — so it carries no webkit2gtk dependency. GOEXPERIMENT=jsonv2
# is still required because internal/business transitively imports Trivy.
build-tui:
	go build $(GOFLAGS) -tags tui -ldflags "$(LDFLAGS)" -o build/bin/kube-inspector-cli ./cmd/tui

build-tui-linux:
	GOOS=linux GOARCH=amd64 go build $(GOFLAGS) -tags tui -ldflags "$(LDFLAGS)" -o build/bin/kube-inspector-cli ./cmd/tui

build-tui-windows:
	GOOS=windows GOARCH=amd64 go build $(GOFLAGS) -tags tui -ldflags "$(LDFLAGS)" -o build/bin/kube-inspector-cli.exe ./cmd/tui

# Universal macOS CLI binary (Apple Silicon + Intel). Uses lipo, so this target
# only runs on macOS (same constraint as build-mac).
build-tui-mac:
	GOOS=darwin GOARCH=amd64 go build $(GOFLAGS) -tags tui -ldflags "$(LDFLAGS)" -o build/bin/kube-inspector-cli-amd64 ./cmd/tui
	GOOS=darwin GOARCH=arm64 go build $(GOFLAGS) -tags tui -ldflags "$(LDFLAGS)" -o build/bin/kube-inspector-cli-arm64 ./cmd/tui
	lipo -create -output build/bin/kube-inspector-cli build/bin/kube-inspector-cli-amd64 build/bin/kube-inspector-cli-arm64
	rm -f build/bin/kube-inspector-cli-amd64 build/bin/kube-inspector-cli-arm64

# ── Shipped GUI: the Electron shell ─────────────────────────────────────────
# Electron embeds its own Chromium, so the packages carry no libwebkit2gtk
# dependency and one build works on every distro. The Wails shell is
# development-only (see `dev` / `build` above) and is no longer packaged.
#
# Division of labour: electron-builder *builds* into build/electron, nfpm
# *packages* into dist/. dist/ holds shippable artifacts only — CI syncs the
# whole directory to the public bucket. See build/nfpm.yaml for why deb/rpm are
# not left to electron-builder.

# Sidecar: plain `go build`, no wails, no webview linkage. The Go binary is the
# application; Electron only supplies the window.
build-sidecar:
	go build -ldflags "$(LDFLAGS)" -o build/bin/kube-inspector ./

# `npm ci` rather than `npm install`: it installs exactly what the lockfiles
# pin, so a release build can never silently pick up a newer transitive version.
# Everything that builds the frontend depends on this — without it a fresh CI
# checkout has no node_modules and `npm run build` falls through to whatever
# stray global `tsc` the runner happens to have (or none at all).
deps:
	cd frontend && npm ci
	cd electron && npm ci

# frontend/wailsjs is gitignored and generated by the Wails toolchain, and
# `npm run build` runs tsc against it — so packaging still needs the wails CLI
# present. The alternative is committing generated bindings, which this project
# deliberately avoids.
#
# The mkdir/touch is not cosmetic: `wails generate module` parses main.go, whose
# //go:embed all:frontend/dist needs at least one file to exist — but that
# directory is only created by the npm build below, which in turn needs the
# bindings. Vite empties the directory, so the placeholder is restored after.
electron-frontend: deps
	mkdir -p frontend/dist && touch frontend/dist/.gitkeep
	wails generate module
	cd frontend && npm run build
	touch frontend/dist/.gitkeep

electron-app: electron-frontend build-sidecar
	cd electron && npx electron-builder --linux --publish never -c.extraMetadata.version=$(VERSION)

pkg-deb: electron-app
	mkdir -p $(DIST)
	VERSION=$(VERSION) $(NFPM) pkg --packager deb --config ./build/nfpm.yaml --target $(DIST)/

pkg-rpm: electron-app
	mkdir -p $(DIST)
	VERSION=$(VERSION) $(NFPM) pkg --packager rpm --config ./build/nfpm.yaml --target $(DIST)/

pkg-linux: pkg-deb pkg-rpm

pkg-windows: electron-frontend
	GOOS=windows GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o build/bin/kube-inspector.exe ./
	cd electron && npx electron-builder --win --publish never -c.extraMetadata.version=$(VERSION)
	mkdir -p $(DIST)
	cp build/electron/*.exe $(DIST)/

pkg-mac: electron-frontend
	GOOS=darwin GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o build/bin/kube-inspector ./
	cd electron && npx electron-builder --mac --publish never -c.extraMetadata.version=$(VERSION)
	mkdir -p $(DIST)
	cp build/electron/*.dmg $(DIST)/

# ── Standalone terminal UI (separate product) ───────────────────────────────

pkg-tui-deb: build-tui-linux
	mkdir -p $(DIST)
	VERSION=$(VERSION) $(NFPM) pkg --packager deb --config ./build/nfpm-cli.yaml --target $(DIST)/

pkg-tui-rpm: build-tui-linux
	mkdir -p $(DIST)
	VERSION=$(VERSION) $(NFPM) pkg --packager rpm --config ./build/nfpm-cli.yaml --target $(DIST)/

pkg-all: pkg-linux pkg-windows pkg-mac pkg-tui-deb pkg-tui-rpm

# ── Electron dev loop ───────────────────────────────────────────────────────
# `make dev` is the one you want: electron/dev.cjs starts the Go backend, Vite
# and Electron together and tears all three down on Ctrl-C. Development runs on
# the same shell that ships, so what you see is what users get.
#
# Only the dev path passes the kubeinsdev tag, which relaxes the token check and
# pins the port — it appears in no build-* or pkg-* target, so it cannot reach a
# release binary.
dev: bindings
	VERSION=$(VERSION) node electron/dev.cjs

# frontend/wailsjs is generated and gitignored, and the frontend imports from
# it. `wails dev` regenerates it on every run; the Electron loop does not, so
# create it once when missing. The mkdir/touch is the same dance as
# electron-frontend: `wails generate module` parses main.go, whose
# //go:embed all:frontend/dist needs at least one file to exist.
bindings:
	@test -d frontend/wailsjs || ( \
		mkdir -p frontend/dist && touch frontend/dist/.gitkeep && \
		wails generate module )

# The three pieces on their own, for debugging one of them in isolation.
electron-dev-go:
	go run -tags kubeinsdev -ldflags "-X 'kube-ins/internal/business.appVersion=$(VERSION)-dev'" . --serve --shell-channel
electron-dev-vite:
	cd frontend && npm run dev
# env -u ELECTRON_RUN_AS_NODE: VS Code's integrated terminal exports it, which
# makes Electron boot as plain Node and every electron API come back undefined.
electron-dev:
	cd electron && env -u ELECTRON_RUN_AS_NODE KUBE_INS_DEV_URL=http://localhost:5173 npm start

clean:
	rm -rf ./build/bin ./build/electron ./dist

# ── Verification ────────────────────────────────────────────────────────────
# `make check` is the single command that proves a change is sound: it compiles,
# vets, lints and tests both halves of the app. CI runs exactly these targets
# (.github/workflows/ci.yml), so a green local check means a green PR.
#
# Note the frontend half needs frontend/wailsjs, which is generated and
# gitignored — `bindings` creates it when missing.
check: test-go lint-go check-frontend

test-go:
	go test ./...

vet:
	go vet ./...

# golangci-lint is not vendored; skip with a warning rather than failing the
# whole check when it is absent locally. CI installs it, so the gate still holds.
# The absence check is a separate statement from the run on purpose: chaining
# them with && ... || would report "not on PATH" for an ordinary lint failure.
lint-go: vet
	@if command -v golangci-lint >/dev/null 2>&1; then \
		golangci-lint run ./...; \
	else \
		echo "⚠  golangci-lint not on PATH — skipping (CI runs it)."; \
		echo "   Install: https://golangci-lint.run/welcome/install/"; \
	fi

# tsc --noEmit rather than `npm run build`: type errors are what we are gating
# on, and a full vite build here would double every check's runtime.
#
# i18n:check is the third anti-rot barrier for the locale catalogs: tsc catches
# a typo'd key and ESLint catches a hardcoded string, but only this sees the
# five translated catalogs drifting away from `en`.
check-frontend: bindings
	cd frontend && npm run typecheck && npm run lint && npm run i18n:check && npm run test

# Single source of truth for the release version. CI derives every artifact name
# and both update manifests from this rather than from GITHUB_REF_NAME, and
# asserts the two agree - so they can never disagree silently.
#
# The empty check is not cosmetic: `git describe` on a tagless or shallow
# checkout yields "", which used to flow silently into LDFLAGS, the nfpm version
# and the manifest URLs, producing a package called kube-inspector--amd64.deb
# and asset links that 404.
print-version:
	@test -n "$(VERSION)" || { \
		echo "make: VERSION is empty - 'git describe --tags' found no v* tag." >&2; \
		echo "      Use a full clone with tags (actions/checkout fetch-depth: 0)." >&2; \
		exit 1; }
	@echo $(VERSION)

test-e2e:
	@echo "⚠  Make sure 'make dev-wails' is running in another terminal (http://localhost:34115)."
	cd e2e_tests && pip install -q -r requirements.txt && \
		pytest -v --html=../report.html --self-contained-html

# ── Documentation (MkDocs Material) ──────────────────────────────
# Requires mkdocs-material on PATH: pip install mkdocs-material

# docs/downloads.md.in is the tracked template (carrying a __VERSION__
# placeholder); docs/downloads.md is generated from it and gitignored. Generating
# a copy rather than sed -i'ing the tracked file is what keeps `make docs-serve`
# from dirtying the working tree — an in-place substitution cannot be ignored,
# because gitignore never applies to a file git already tracks.
# One update manifest per channel. $(1) = output path, $(2) = version.
#
# An empty version is the honest shape for "this channel has no release yet":
# the client reads version:"" , isNewer() rejects it and no update is offered.
# Emitting asset URLs built from an empty version would produce guaranteed 404s
# that surface to users only as a failed in-app update.
define emit_manifest
	@if [ -z "$(2)" ]; then \
		printf '{"version":"","downloadUrl":"%s","assets":{}}\n' "$(DOWNLOAD_PAGE_URL)" > $(1); \
		echo "  $(1) — no release published on this channel yet"; \
	else \
		printf '{"version":"%s","downloadUrl":"%s","assets":{"linux-deb":"%s/kube-inspector-%s-linux-amd64.deb","linux-rpm":"%s/kube-inspector-%s-linux-x86_64.rpm","windows-amd64":"%s/kube-inspector-%s-windows-amd64.exe","darwin-arm64":"%s/kube-inspector-%s-macos-arm64.dmg"}}\n' \
			"$(2)" "$(DOWNLOAD_PAGE_URL)" \
			"$(DIST_BASE_URL)" "$(2)" \
			"$(DIST_BASE_URL)" "$(2)" \
			"$(DIST_BASE_URL)" "$(2)" \
			"$(DIST_BASE_URL)" "$(2)" > $(1); \
		echo "  $(1) — v$(2)"; \
	fi
endef

docs-downloads:
	@echo "Generating docs/downloads.md for v$(VERSION)"
	@sed 's/__VERSION__/$(VERSION)/g' docs/downloads.md.in > docs/downloads.md
	@echo "Writing the update manifests (in-app update check)"
	$(call emit_manifest,docs/version.json,$(STABLE_VERSION))
	$(call emit_manifest,docs/version-beta.json,$(VERSION))

docs-serve: docs-downloads
	mkdocs serve

docs-build: docs-downloads
	mkdocs build --clean --strict

.PHONY: build build-linux build-windows build-mac dev dev-wails bindings dev-tui build-tui build-tui-linux build-tui-windows build-tui-mac deps build-sidecar electron-frontend electron-app electron-dev-go electron-dev-vite electron-dev pkg-deb pkg-rpm pkg-linux pkg-windows pkg-mac pkg-tui-deb pkg-tui-rpm pkg-all clean check test-go vet lint-go check-frontend print-version test-e2e docs-downloads docs-serve docs-build
