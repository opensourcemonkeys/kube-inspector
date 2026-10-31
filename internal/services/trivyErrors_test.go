package services_k8sclient

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestClassifyScanError(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{errors.New("GET https://r/v2/x/manifests/1: UNAUTHORIZED: authentication required"), "auth"},
		{errors.New("DENIED: requested access to the resource is denied"), "auth"},
		{errors.New("MANIFEST_UNKNOWN: manifest unknown"), "notFound"},
		{errors.New("unable to find the specified image \"x\""), "notFound"},
		{context.DeadlineExceeded, "timeout"},
		{fmt.Errorf("scan: %w", context.Canceled), "cancelled"},
		{errors.New("boom"), "other"},
	}
	for _, c := range cases {
		reason, msg := ClassifyScanError(c.err)
		if reason != c.want {
			t.Errorf("%v: reason = %q, want %q", c.err, reason, c.want)
		}
		if msg != c.err.Error() {
			t.Errorf("%v: message = %q", c.err, msg)
		}
	}
	long := errors.New(strings.Repeat("x", 500))
	if _, msg := ClassifyScanError(long); len([]rune(msg)) != 300 {
		t.Errorf("message not truncated: %d", len([]rune(msg)))
	}
}
