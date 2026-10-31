package services_k8sclient

import (
	"context"
	"errors"
	"strings"
	"time"
)

// RegistryCredential is a username/password pair for one registry. It is never
// logged, persisted or sent to the frontend.
type RegistryCredential struct {
	Username, Password string
}

// ImageScanTimeout bounds one image scan; it is generous because the first scan
// downloads the vulnerability DB.
const ImageScanTimeout = 12 * time.Minute

const scanErrorMaxLen = 300

// ClassifyScanError maps a scan failure to a coarse reason ("auth", "notFound",
// "timeout", "cancelled", "other") and a message truncated to 300 characters.
// "pullSecretForbidden" is assigned by the caller, not derivable from the error.
func ClassifyScanError(err error) (reason, message string) {
	message = err.Error()
	if r := []rune(message); len(r) > scanErrorMaxLen {
		message = string(r[:scanErrorMaxLen])
	}
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout", message
	case errors.Is(err, context.Canceled):
		return "cancelled", message
	}
	lower := strings.ToLower(err.Error())
	for _, s := range []string{"unauthorized", "denied", "authentication required"} {
		if strings.Contains(lower, s) {
			return "auth", message
		}
	}
	for _, s := range []string{"manifest unknown", "not found", "unable to find"} {
		if strings.Contains(lower, s) {
			return "notFound", message
		}
	}
	return "other", message
}
