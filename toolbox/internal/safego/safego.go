// Package safego runs background work in goroutines that cannot take the
// process down with them.
//
// A panic in any goroutine of this process — an informer handler, a writer
// flush, a correlator pass — would otherwise kill every other part of it,
// including the admission webhook. failurePolicy: Ignore keeps the cluster
// working while we are down, but every change made in that window goes
// unrecorded, so trading one dead goroutine for a dead collector is never
// worth it.
package safego

import (
	"fmt"
	"log/slog"
	"runtime/debug"
)

// maxStack caps the stack in a panic record so a runaway dump cannot bury the
// top frames — the ones that name the bug.
const maxStack = 8 << 10

// Go runs fn in a goroutine, recovering and logging any panic along with the
// stack that produced it. name identifies the goroutine in that log line.
func Go(name string, fn func()) {
	go func() {
		defer Recover(name)
		fn()
	}()
}

// Recover is the deferred half of Go, for goroutines that cannot be started
// through it. Use it as `defer safego.Recover("name")`.
func Recover(name string) {
	if r := recover(); r != nil {
		slog.Error("goroutine panic",
			"goroutine", name,
			"panic", fmt.Sprint(r),
			"stack", stack(maxStack))
	}
}

func stack(limit int) string {
	s := debug.Stack()
	if len(s) <= limit {
		return string(s)
	}
	s = s[:limit]
	for i := len(s) - 1; i > 0; i-- {
		if s[i] == '\n' {
			s = s[:i]
			break
		}
	}
	return string(s) + "\n[stack truncated]"
}
