---
description: Kube Inspector's builds are not code-signed. What that means, and how to verify a download and then get past macOS Gatekeeper or Windows SmartScreen.
---

# Unsigned builds

Kube Inspector's releases are **not code-signed**. The project has no Apple
Developer ID certificate and no Windows Authenticode certificate, so the
operating system cannot tell you who built the file you downloaded. macOS and
Windows both notice, and both will get in your way the first time you open the
app.

This page explains what is actually missing, and gives the exact steps to get
past each warning — **after** you have verified the download, never instead of
it.

!!! danger "Verify first. Every time."
    A signature and a checksum answer different questions:

    | | Answers |
    |---|---|
    | Code signature | *Who* built this, and has it been altered since? |
    | SHA-256 checksum | Is this byte-for-byte the file that was published? |

    With no signature, the checksum is the **only** check you have. Every
    bypass below assumes you already ran it — see
    [Verifying your download](verifying-downloads.md). If you are about to
    click past a security warning for a file you did not verify, stop and
    verify it.

## What "unsigned" does and does not mean

**It does not mean the build is unsafe.** Builds are produced by GitHub Actions
from tagged commits in the [public
repository](https://github.com/opensourcemonkeys/kube-inspector), and the checksums
are published in two independently hosted places (the download site and the
GitHub release).

**It does mean you are trusting the distribution chain, not a certificate.** An
attacker who could replace both the artifact and both copies of its checksum
could serve you something else, and your OS would not object any louder than it
already does. This is the honest limitation of shipping unsigned software.

Code signing is on the roadmap for 1.0.

## Linux

Nothing to bypass. `dpkg` and `rpm` do not require a signature for a local file,
and there is no Gatekeeper equivalent.

```bash
sha256sum -c kube-inspector-<version>-linux-amd64.deb.sha256   # must print OK
sudo dpkg -i kube-inspector-<version>-linux-amd64.deb
```

RPM will warn about a missing GPG signature if you install from a repository;
installing the downloaded file directly with `rpm -Uvh` does not check one.

## macOS

macOS quarantines anything downloaded by a browser. Because the app is
unsigned **and** unnotarised, Gatekeeper refuses the first launch outright
rather than merely warning.

**Step 1 — verify:**

```bash
shasum -a 256 -c kube-inspector-<version>-macos-arm64.dmg.sha256   # must print OK
```

**Step 2 — install:** open the `.dmg` and drag **Kube Inspector** into
`/Applications`.

**Step 3 — open it the first time.** Pick one of the two routes below.

=== "Right-click → Open (no terminal)"
    1. Open **Finder → Applications**.
    2. **Right-click** (or Control-click) **Kube Inspector** and choose **Open**.
       Double-clicking will not work here — the Open menu item is what offers
       the override.
    3. A dialog appears saying macOS *"cannot verify the developer of 'Kube
       Inspector'. Are you sure you want to open it?"* Click **Open**.
    4. If macOS instead says the app *"is damaged and can't be opened"*, that is
       the quarantine flag, not damage. Use the terminal route below.

    On recent macOS versions the first double-click is blocked with no override
    button; the choice then appears under **System Settings → Privacy &
    Security**, near the bottom, as **"Kube Inspector was blocked to protect
    your Mac" → Open Anyway**.

=== "Remove the quarantine flag (terminal)"
    ```bash
    xattr -d com.apple.quarantine "/Applications/Kube Inspector.app"
    ```

    If that reports `No such xattr`, the flag was already cleared and the app
    should open normally. To clear every extended attribute instead:

    ```bash
    xattr -cr "/Applications/Kube Inspector.app"
    ```

    !!! warning
        This command tells macOS to stop asking about that app. Run it only on
        a file whose checksum you verified in step 1, and only on this app —
        pointing it at `/Applications` as a whole disarms the check for
        everything you have installed.

## Windows

Windows SmartScreen blocks unrecognised publishers. The installer is not
rejected, but it is hidden behind a second click.

**Step 1 — verify** (PowerShell):

```powershell
$expected = (Get-Content .\kube-inspector-<version>-windows-amd64.exe.sha256).Split(' ')[0]
$actual   = (Get-FileHash .\kube-inspector-<version>-windows-amd64.exe -Algorithm SHA256).Hash
if ($expected -eq $actual) { "OK" } else { "MISMATCH - do not install" }
```

**Step 2 — run the installer.** A blue dialog appears:

> **Windows protected your PC**
> Microsoft Defender SmartScreen prevented an unrecognised app from starting.
> Running this app might put your PC at risk.

**Step 3 — click "More info"**, then the **Run anyway** button that appears
below the file name. The dialog shows the publisher as *Unknown publisher* —
that is expected for an unsigned build, and it is why step 1 exists.

If your browser refused the download itself ("this file isn't commonly
downloaded and may be dangerous"), choose **Keep** from the download menu, then
verify the checksum before running it.

## The in-app updater

The updater does not rely on your OS's trust decision, so it has its own check:
every download is verified against the `.sha256` sidecar published beside the
artifact **before** it is handed to the installer. A mismatch aborts the update.

That check is not a substitute for signing either — it proves the file matches
what the server published, nothing more.

## Related

- [Verifying your download](verifying-downloads.md)
- [Known limitations](../known-limitations.md)
- [Privacy](../privacy.md)
