//go:build windows

package services_k8sclient

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"

	"kube-ins/internal/safego"
)

// conPty is a process attached to a Windows pseudo console (ConPTY, Windows 10
// 1809+). Written against x/sys/windows rather than a wrapper library because
// the teardown order is the whole difficulty: ConPTY keeps its output pipe open
// after the client process exits, so the reader only sees EOF once the console
// itself is closed — and an HPCON is a heap pointer inside kernel32, so it must
// never be resized after it was closed.
type conPty struct {
	in, out *os.File
	process windows.Handle
	exited  chan struct{}

	// mu guards both handles below against use after close. A closed process
	// handle can be reused by an unrelated process, and a closed HPCON is freed
	// memory.
	mu            sync.Mutex
	console       windows.Handle
	consoleClosed bool
	processClosed bool

	closeOnce sync.Once
}

var (
	kernel32                      = windows.NewLazySystemDLL("kernel32.dll")
	procCreatePseudoConsole       = kernel32.NewProc("CreatePseudoConsole")
	procUpdateProcThreadAttribute = kernel32.NewProc("UpdateProcThreadAttribute")
)

func startPty(path string, args []string, env []string, dir string) (ptyProcess, error) {
	// x/sys/windows resolves the procedure lazily and panics when it is missing.
	if procCreatePseudoConsole.Find() != nil {
		return nil, errors.New("the terminal needs Windows 10 version 1809 or later (ConPTY)")
	}

	var ptyIn, inWrite, outRead, ptyOut windows.Handle
	if err := windows.CreatePipe(&ptyIn, &inWrite, nil, 0); err != nil {
		return nil, fmt.Errorf("CreatePipe: %w", err)
	}
	if err := windows.CreatePipe(&outRead, &ptyOut, nil, 0); err != nil {
		closeHandles(ptyIn, inWrite)
		return nil, fmt.Errorf("CreatePipe: %w", err)
	}

	var console windows.Handle
	err := windows.CreatePseudoConsole(windows.Coord{X: 80, Y: 24}, ptyIn, ptyOut, 0, &console)
	// The console holds its own duplicates of these ends. Ours must go, or the
	// output pipe can never report EOF.
	closeHandles(ptyIn, ptyOut)
	if err != nil {
		closeHandles(inWrite, outRead)
		return nil, fmt.Errorf("CreatePseudoConsole: %w", err)
	}

	pi, err := createConsoleProcess(console, path, args, env, dir)
	if err != nil {
		windows.ClosePseudoConsole(console)
		closeHandles(inWrite, outRead)
		return nil, err
	}
	_ = windows.CloseHandle(pi.Thread)

	p := &conPty{
		in:      os.NewFile(uintptr(inWrite), "conpty-in"),
		out:     os.NewFile(uintptr(outRead), "conpty-out"),
		process: pi.Process,
		exited:  make(chan struct{}),
		console: console,
	}

	safego.Go("services.conpty.wait", func() {
		_, _ = windows.WaitForSingleObject(p.process, windows.INFINITE)
		close(p.exited)
		// A shell that exits on its own leaves the output pipe open; closing
		// the console is what lets the reader goroutine finish.
		p.closeConsole()
	})

	return p, nil
}

func createConsoleProcess(console windows.Handle, path string, args []string, env []string, dir string) (*windows.ProcessInformation, error) {
	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return nil, fmt.Errorf("NewProcThreadAttributeList: %w", err)
	}
	defer attrs.Delete()

	// The attribute value is the HPCON itself, not a pointer to it, so this
	// bypasses ProcThreadAttributeListContainer.Update, which would keep a
	// non-Go "pointer" in a Go-visible slot.
	r, _, callErr := procUpdateProcThreadAttribute.Call(
		uintptr(unsafe.Pointer(attrs.List())),
		0,
		windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
		uintptr(console),
		unsafe.Sizeof(console),
		0,
		0,
	)
	if r == 0 {
		return nil, fmt.Errorf("UpdateProcThreadAttribute: %w", callErr)
	}

	si := &windows.StartupInfoEx{ProcThreadAttributeList: attrs.List()}
	si.Cb = uint32(unsafe.Sizeof(*si))
	// Null std handles with STARTF_USESTDHANDLES make the child use the pseudo
	// console. Without it the child inherits *this* process' std handles — and
	// under Electron our stdout is the sidecar protocol pipe.
	si.Flags |= windows.STARTF_USESTDHANDLES

	appName, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	cmdLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(append([]string{path}, args...)))
	if err != nil {
		return nil, err
	}
	var cwd *uint16
	if dir != "" {
		if cwd, err = windows.UTF16PtrFromString(dir); err != nil {
			return nil, err
		}
	}

	var pi windows.ProcessInformation
	err = windows.CreateProcess(
		appName,
		cmdLine,
		nil,
		nil,
		false,
		windows.EXTENDED_STARTUPINFO_PRESENT|windows.CREATE_UNICODE_ENVIRONMENT,
		envBlock(env),
		cwd,
		&si.StartupInfo,
		&pi,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to start %s: %w", path, err)
	}
	return &pi, nil
}

// envBlock builds a CreateProcess environment block. os/exec de-duplicates the
// environment for us, CreateProcess does not, so do it here the way os/exec
// does on Windows: case-insensitive keys, the last occurrence wins.
func envBlock(env []string) *uint16 {
	index := make(map[string]int, len(env))
	kept := make([]string, 0, len(env))
	for _, kv := range env {
		if kv == "" || strings.IndexByte(kv, 0) >= 0 {
			continue
		}
		key := strings.ToUpper(envKey(kv))
		if i, ok := index[key]; ok {
			kept[i] = kv
			continue
		}
		index[key] = len(kept)
		kept = append(kept, kv)
	}

	var block []uint16
	for _, kv := range kept {
		block = append(block, utf16.Encode([]rune(kv))...)
		block = append(block, 0)
	}
	if len(kept) == 0 {
		block = append(block, 0)
	}
	block = append(block, 0)
	return &block[0]
}

// envKey returns the name part of "NAME=value". Windows keeps per-drive working
// directories as "=C:=C:\dir", whose name starts with '='.
func envKey(kv string) string {
	if i := strings.IndexByte(kv[1:], '='); i >= 0 {
		return kv[:i+1]
	}
	return kv
}

func closeHandles(handles ...windows.Handle) {
	for _, h := range handles {
		if h != 0 && h != windows.InvalidHandle {
			_ = windows.CloseHandle(h)
		}
	}
}

func (p *conPty) Read(b []byte) (int, error)  { return p.out.Read(b) }
func (p *conPty) Write(b []byte) (int, error) { return p.in.Write(b) }

func (p *conPty) Resize(cols, rows uint16) error {
	if cols == 0 || rows == 0 {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.consoleClosed {
		return errors.New("pseudo console is closed")
	}
	return windows.ResizePseudoConsole(p.console, windows.Coord{X: int16(cols), Y: int16(rows)})
}

func (p *conPty) Kill() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.processClosed {
		return nil
	}
	return windows.TerminateProcess(p.process, 1)
}

func (p *conPty) Wait() error {
	<-p.exited
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.processClosed {
		p.processClosed = true
		return windows.CloseHandle(p.process)
	}
	return nil
}

// closeConsole runs ClosePseudoConsole once. It is called outside mu: on older
// Windows 10 builds it blocks until the output pipe is drained, which needs the
// reader goroutine — and nothing the reader does takes mu.
func (p *conPty) closeConsole() {
	p.mu.Lock()
	if p.consoleClosed {
		p.mu.Unlock()
		return
	}
	p.consoleClosed = true
	p.mu.Unlock()
	windows.ClosePseudoConsole(p.console)
}

func (p *conPty) Close() error {
	p.closeOnce.Do(func() {
		p.closeConsole()
		_ = p.in.Close()
		_ = p.out.Close()
	})
	return nil
}
