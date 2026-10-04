package services_k8sclient

import (
	"os"
)

// SaveTextFile writes text content (e.g. an HTML report) to path and returns it.
func SaveTextFile(path, content string) (string, error) {
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return "", err
	}
	return path, nil
}
