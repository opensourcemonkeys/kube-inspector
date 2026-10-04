package business

import (
	services "kube-ins/internal/services"
)

// SaveTextFile writes text content (e.g. an HTML report) to the chosen path.
func SaveTextFile(path, content string) (string, error) {
	return services.SaveTextFile(path, content)
}
