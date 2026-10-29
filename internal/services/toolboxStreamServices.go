package services_k8sclient

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"kube-ins/internal/models"
)

// toolboxStreamMaxLine bounds one SSE line: a change carries its patch, which
// can be large for a big object.
const toolboxStreamMaxLine = 8 << 20

// StreamToolboxChanges follows toolbox's /api/v1/changes/stream through the
// API server's service proxy (which flushes as data arrives) and calls
// onChange for each change, until ctx ends or the stream does. It returns nil
// only when ctx was cancelled; any other end is an error, so the caller knows
// to fall back to polling. A toolbox older than the stream answers 404, which
// comes back as a ToolboxError with Code 404.
//
// t.Client must be built from a config without a request timeout: the
// ordinary 20s one would cut every stream at 20s.
func StreamToolboxChanges(ctx context.Context, t Toolbox, f models.ToolboxChangeFilter, onChange func(models.ToolboxChange)) error {
	ep, err := t.endpoint(ctx, false)
	if err != nil {
		return err
	}
	f.Cursor, f.Limit, f.Since, f.Until = "", 0, "", ""
	req := t.Client.CoreV1().RESTClient().Get().
		Namespace(ep.namespace).Resource("services").Name(ep.service+":"+toolboxPortName).
		SubResource("proxy").Suffix("api/v1/changes/stream").
		SetHeader(toolboxTokenHeader, ep.token).SetHeader("Accept", "text/event-stream")
	for k, vs := range changeParams(f) {
		for _, v := range vs {
			req = req.Param(k, v)
		}
	}
	body, err := req.Stream(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		code := statusCode(err)
		if code == 401 || code == 404 || code == 503 {
			t.forget() // a reinstall, or an older toolbox; the next start rediscovers
		}
		return &ToolboxError{State: ToolboxUnreachable, Code: code, Err: fmt.Errorf("toolbox change stream: %w", err)}
	}
	defer body.Close()

	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 64<<10), toolboxStreamMaxLine)
	event := ""
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			event = ""
		case strings.HasPrefix(line, ":"):
			// keepalive comment
		case strings.HasPrefix(line, "event: "):
			event = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			data := strings.TrimPrefix(line, "data: ")
			switch event {
			case "change":
				var c models.ToolboxChange
				if err := json.Unmarshal([]byte(data), &c); err != nil {
					return fmt.Errorf("decode streamed change: %w", err)
				}
				onChange(c)
			case "error":
				return fmt.Errorf("toolbox ended the change stream: %s", toolboxMessage([]byte(data), errors.New(data)))
			}
		}
	}
	if ctx.Err() != nil {
		return nil
	}
	if err := sc.Err(); err != nil {
		return fmt.Errorf("toolbox change stream: %w", err)
	}
	return errors.New("toolbox change stream closed")
}
