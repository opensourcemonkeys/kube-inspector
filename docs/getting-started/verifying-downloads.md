---
description: Verify the SHA-256 checksum of a Kube Inspector download on Linux, macOS, or Windows before installing it.
---

# Verifying your download

Every Kube Inspector release is published with checksums. Verifying one takes a
few seconds and tells you the file you have is byte-for-byte the file that was
built — not one truncated by a dropped connection, and not one substituted in
transit.

!!! warning "This checks integrity, not authorship"
    A checksum proves the file arrived intact. It does **not** prove who built
    it, because Kube Inspector's builds are **not code-signed** — the project
    has no signing certificates. See [Known limitations](#what-this-does-not-prove)
    at the bottom of this page.

## What is published

Each release publishes two things alongside every artifact:

| File | What it covers |
|---|---|
| `<artifact>.sha256` | One artifact. This is also what the in-app updater checks before it installs anything. |
| `SHA256SUMS-<version>` | Every artifact in that release, in one file. |

Both live next to the downloads at `https://kubeinspector.com/dist/`.
`SHA256SUMS-<version>` is **also attached to the
[GitHub release](https://github.com/opensourcemonkeys/kube-inspector/releases)** —
a second, independently hosted copy you can compare against.

## Verify one file

Download the artifact and its `.sha256` sidecar into the same directory, then:

=== "Linux"
    ```bash
    curl -fsSLO https://kubeinspector.com/dist/kube-inspector-<version>-linux-amd64.deb.sha256
    sha256sum -c kube-inspector-<version>-linux-amd64.deb.sha256
    ```
    Expected output:
    ```
    kube-inspector-<version>-linux-amd64.deb: OK
    ```

=== "macOS"
    ```bash
    curl -fsSLO https://kubeinspector.com/dist/kube-inspector-<version>-macos-arm64.dmg.sha256
    shasum -a 256 -c kube-inspector-<version>-macos-arm64.dmg.sha256
    ```
    Expected output:
    ```
    kube-inspector-<version>-macos-arm64.dmg: OK
    ```

=== "Windows (PowerShell)"
    ```powershell
    Get-FileHash .\kube-inspector-<version>-windows-amd64.exe -Algorithm SHA256
    ```
    Compare the `Hash` column against the contents of the `.sha256` file, which
    you can open in any text editor. To compare automatically:
    ```powershell
    $expected = (Get-Content .\kube-inspector-<version>-windows-amd64.exe.sha256).Split(' ')[0]
    $actual   = (Get-FileHash .\kube-inspector-<version>-windows-amd64.exe -Algorithm SHA256).Hash
    if ($expected -eq $actual) { "OK" } else { "MISMATCH - do not install" }
    ```

=== "Windows (cmd)"
    ```bat
    CertUtil -hashfile kube-inspector-<version>-windows-amd64.exe SHA256
    ```
    Compare the printed hash against the contents of the `.sha256` file.

## Verify against the whole-release file

`SHA256SUMS-<version>` lists every artifact in the release, so one file covers
whichever platform you downloaded:

```bash
curl -fsSLO https://kubeinspector.com/dist/SHA256SUMS-<version>
sha256sum --ignore-missing -c SHA256SUMS-<version>
```

`--ignore-missing` is what lets you check a single download against a list that
names all of them. On macOS, use `shasum -a 256 --ignore-missing -c` instead.

For an independent cross-check, download the same file from the GitHub release
page and confirm the two copies are identical:

```bash
diff <(curl -fsSL https://kubeinspector.com/dist/SHA256SUMS-<version>) \
     ./SHA256SUMS-<version>   # the copy downloaded from GitHub
```

If those two disagree, **stop and report it** as a security issue on the
[issue tracker](https://github.com/opensourcemonkeys/kube-inspector/issues).

## If verification fails

A mismatch is almost always an interrupted or partial download. Delete the file,
download it again, and verify again. If it fails a second time, do not install
it; open an issue with the version, the platform and the hash you got.

## What this does not prove

Checksums served from the same site as the download only protect against
corruption in transit. They cannot prove the build is authentic, because:

- The builds are **unsigned**. There is no Apple Developer ID certificate and no
  Windows Authenticode certificate, so macOS Gatekeeper and Windows SmartScreen
  will both warn you the first time you open the app.
- A checksum published beside its artifact is only as trustworthy as the host
  serving both. The GitHub-hosted copy of `SHA256SUMS-<version>` exists so you
  do not have to take a single host's word for it.

Code signing is on the roadmap for 1.0.
