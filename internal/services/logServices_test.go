package services_k8sclient

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"unicode/utf8"
)

// chunkReader returns its chunks one Read at a time, the way a log stream
// delivers whatever the network has handed over so far.
type chunkReader struct {
	chunks []string
	err    error // returned after the last chunk; io.EOF when nil
}

func (r *chunkReader) Read(p []byte) (int, error) {
	if len(r.chunks) == 0 {
		if r.err != nil {
			return 0, r.err
		}
		return 0, io.EOF
	}
	n := copy(p, r.chunks[0])
	if n < len(r.chunks[0]) {
		r.chunks[0] = r.chunks[0][n:]
	} else {
		r.chunks = r.chunks[1:]
	}
	return n, nil
}

func pump(t *testing.T, r io.Reader) ([]string, error) {
	t.Helper()
	var got []string
	err := pumpLogStream(context.Background(), r, func(s string) { got = append(got, s) })
	return got, err
}

func TestPumpLogStreamCutsOnLineBoundary(t *testing.T) {
	got, err := pump(t, &chunkReader{chunks: []string{"a\nb", "c\nd\n"}})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"a\n", "bc\nd\n"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestPumpLogStreamFlushesPartialLineAtEOF(t *testing.T) {
	got, err := pump(t, &chunkReader{chunks: []string{"a\n", "no newline"}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, "") != "a\nno newline" || got[len(got)-1] != "no newline" {
		t.Fatalf("got %q", got)
	}
}

// The scanner this replaced ended the stream on the first line over 64KB.
func TestPumpLogStreamSurvivesVeryLongLine(t *testing.T) {
	long := strings.Repeat("x", 200*1024)
	got, err := pump(t, &chunkReader{chunks: []string{long + "\n", "after\n"}})
	if err != nil {
		t.Fatal(err)
	}
	all := strings.Join(got, "")
	if all != long+"\nafter\n" {
		t.Fatalf("output lost or reordered: %d bytes, want %d", len(all), len(long)+7)
	}
	for _, s := range got {
		if len(s) > logMaxPending+logReadSize {
			t.Fatalf("emitted %d bytes in one piece", len(s))
		}
	}
}

func TestPumpLogStreamNeverSplitsARune(t *testing.T) {
	// 3-byte runes with no newline, so pieces are cut by size alone and the
	// cut lands inside a rune unless runeBoundary moves it.
	long := strings.Repeat("ş€", 50*1024)
	got, err := pump(t, &chunkReader{chunks: []string{long}})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) < 2 {
		t.Fatalf("expected the line in several pieces, got %d", len(got))
	}
	for i, s := range got {
		if !utf8.ValidString(s) {
			t.Fatalf("piece %d is not valid UTF-8", i)
		}
	}
	if strings.Join(got, "") != long {
		t.Fatal("pieces do not reassemble the input")
	}
}

func TestPumpLogStreamReportsReadError(t *testing.T) {
	boom := errors.New("connection reset")
	got, err := pump(t, &chunkReader{chunks: []string{"a\n", "tail"}, err: boom})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want %v", err, boom)
	}
	if strings.Join(got, "") != "a\ntail" {
		t.Fatalf("got %q", got)
	}
}

func TestPumpLogStreamStopsSilentlyWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var got []string
	err := pumpLogStream(ctx, &chunkReader{chunks: []string{"a\n"}, err: errors.New("canceled")},
		func(s string) { got = append(got, s) })
	if err != nil || len(got) != 0 {
		t.Fatalf("err = %v, got %q; want nil and no output", err, got)
	}
}

func TestReleaseLogSessionIsByIdentity(t *testing.T) {
	const id = "test-log-session"
	old := &logSession{cancel: func() {}}
	replacement := &logSession{cancel: func() {}}

	logMu.Lock()
	logSessions[id] = replacement
	logMu.Unlock()
	t.Cleanup(func() {
		logMu.Lock()
		delete(logSessions, id)
		logMu.Unlock()
	})

	if releaseLogSession(id, old) {
		t.Fatal("a replaced stream reported owning the session")
	}
	logMu.Lock()
	still := logSessions[id]
	logMu.Unlock()
	if still != replacement {
		t.Fatal("a replaced stream removed its replacement's entry")
	}
	if !releaseLogSession(id, replacement) {
		t.Fatal("the owner could not release its own entry")
	}
	if releaseLogSession(id, replacement) {
		t.Fatal("an entry was released twice")
	}
}
