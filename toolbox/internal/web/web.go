// Package web embeds the change-history UI.
package web

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed static
var static embed.FS

// Handler serves the UI's static files.
func Handler() http.Handler {
	sub, _ := fs.Sub(static, "static")
	return http.FileServer(http.FS(sub))
}
