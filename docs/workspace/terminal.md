---
description: Run kubectl and exec into pods with integrated, tiled terminals inside Kube Inspector's dockable workspace.
---

# Terminal

The Terminal panel provides an integrated `kubectl` terminal directly inside Kube Inspector. It is powered by xterm.js and a server-side pseudo-terminal (pty).

![Integrated terminals](../assets/screenshots/terminal.png){ .doc-shot }

## Opening the Terminal

Click **Terminal** in the sidebar under the Workspace section. A terminal panel opens, already connected to a shell with `kubectl` available and configured against the active cluster.

## Usage

The terminal behaves like a standard terminal emulator:

- Run any `kubectl` command directly
- Use tab completion, history (`↑`/`↓`), and keyboard shortcuts
- Open multiple terminal panels by clicking the Terminal sidebar item again

```bash
# Examples
kubectl get pods -n production
kubectl describe node worker-1
kubectl exec -it my-pod -- /bin/sh
kubectl rollout status deployment/my-app
```

## Active Cluster Context

The terminal session is pre-configured with the kubeconfig of the currently active cluster. Switching clusters in the cluster manager does not automatically update already-open terminal sessions. Close and reopen the terminal after switching clusters to use the new context.

## Keyboard Shortcuts

Shell keys:

| Shortcut | Action |
|---|---|
| `Ctrl+C` | Interrupt current command (when nothing is selected — see below) |
| `Ctrl+L` | Clear the terminal screen |
| `Ctrl+V` | Sends a literal `^V` to the shell, it does **not** paste |
| `↑` / `↓` | Navigate command history |
| `Tab` | Autocomplete (if shell supports it) |

Terminal keys:

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+C` | Copy the selection |
| `Ctrl+Shift+V` | Paste from the clipboard |
| `Ctrl+Shift+A` | Select the whole buffer |
| `Ctrl+Shift+K` | Clear the screen |
| `Ctrl+Shift+F` | Find in the terminal |
| `Ctrl++` / `Ctrl+-` | Increase / decrease the font size |
| `Ctrl+0` | Reset the font size |

`Ctrl+C` does double duty: with text selected it copies and then drops the
selection, and with nothing selected it interrupts the running command as
usual. Pressing it twice therefore always interrupts.

The font size is shared by every terminal and pod-exec panel and is remembered
between restarts.

## Right-click Menu

Right-clicking inside the terminal opens a menu with Copy (enabled only when
something is selected), Paste, Select all, Clear screen, Find, Copy all output,
Save output to file, and the font-size actions. The same menu is available in a
pod's Exec panel.

## Multi-line Paste

Pasting more than one line opens a preview dialog first, because a terminal runs
each line as it arrives and a snippet copied from a wiki may not be what you
expect. The text is editable in the dialog: fix a namespace, drop a line, then
press `Enter` or the Paste button to send it. `Shift+Enter` adds a newline
inside the dialog and `Esc` cancels.

A single line pastes straight through with no dialog. If the clipboard cannot be
read programmatically the dialog opens empty — press `Ctrl+V` inside it to paste
there, which always works.

## Notes

- The terminal runs a shell process on your local machine; it is not an in-cluster exec session.
- Scrollback is kept to 3500 lines. Older lines are discarded rather than hidden, so they are also outside what "Copy all output" and "Save output to file" can reach — pipe long output to a file if you need all of it.
- Shell configuration (`.bashrc`, `.zshrc`) is sourced on startup, so aliases and functions you have defined locally are available.
