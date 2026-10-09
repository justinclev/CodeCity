// Package server serves the embedded viewer and a city.json.
package server

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"os"

	"github.com/justinclev/codecity/internal/city"
	"github.com/justinclev/codecity/internal/web"
)

// Handler serves /city.json and the viewer (from webDir if set, else embedded).
func Handler(c *city.City, webDir string) http.Handler {
	mux := http.NewServeMux()
	body, _ := json.Marshal(c)
	mux.HandleFunc("/city.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(body)
	})
	var static fs.FS = web.FS()
	if webDir != "" {
		static = os.DirFS(webDir)
	}
	mux.Handle("/", http.FileServerFS(static))
	return mux
}

// HasViewer reports whether the embedded viewer has been built.
func HasViewer(webDir string) bool {
	var static fs.FS = web.FS()
	if webDir != "" {
		static = os.DirFS(webDir)
	}
	_, err := fs.Stat(static, "index.html")
	return err == nil
}
