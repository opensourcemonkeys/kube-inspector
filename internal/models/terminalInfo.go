package models

// TerminalSnapshot is what a terminal panel replays when it picks up a session
// that was moved to it from another window: the session's recent output, and
// the stream offset that output ends at. Streamed `terminal:output` chunks
// carry their own end offset, so the panel skips those the snapshot covers.
type TerminalSnapshot struct {
	Data   string `json:"data"`
	Offset int64  `json:"offset"`
}

// ShellInfo is one shell the terminal panel can start. The panel sends ID back
// to pick a shell; the backend resolves it against its own discovered list and
// never runs a path the frontend supplied.
type ShellInfo struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Path    string `json:"path"`
	Default bool   `json:"default"`
}
