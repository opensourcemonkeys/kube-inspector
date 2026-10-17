package services_k8sclient

import "io"

// ptyProcess is a child process attached to a pseudo-terminal. creack/pty has
// no Windows backend, so the terminal goes through this instead: pty_unix.go
// wraps creack/pty, pty_windows.go drives ConPTY directly.
//
// The contract the terminal session relies on, on every platform:
//   - Read returns an error once the child has exited and its output is drained.
//   - Wait reaps the child. It is called exactly once, by the reader goroutine.
//   - Close is idempotent and safe to call concurrently with a blocked Read.
type ptyProcess interface {
	io.ReadWriter
	Resize(cols, rows uint16) error
	Kill() error
	Wait() error
	Close() error
}
