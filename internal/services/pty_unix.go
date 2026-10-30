//go:build !windows

package services_k8sclient

import (
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
)

type unixPty struct {
	ptmx      *os.File
	cmd       *exec.Cmd
	closeOnce sync.Once
}

func startPty(path string, args []string, env []string, dir string) (ptyProcess, error) {
	// path is never caller-supplied: terminalServices resolves it from
	// discoverShells' list by ID (resolveShell), whatever the panel sent.
	cmd := exec.Command(path, args...) //nolint:gosec // G204: see above
	cmd.Env = env
	cmd.Dir = dir

	ptmx, err := pty.Start(cmd)
	if err != nil {
		return nil, err
	}
	return &unixPty{ptmx: ptmx, cmd: cmd}, nil
}

func (p *unixPty) Read(b []byte) (int, error)  { return p.ptmx.Read(b) }
func (p *unixPty) Write(b []byte) (int, error) { return p.ptmx.Write(b) }

func (p *unixPty) Resize(cols, rows uint16) error {
	return pty.Setsize(p.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
}

func (p *unixPty) Kill() error { return p.cmd.Process.Kill() }
func (p *unixPty) Wait() error { return p.cmd.Wait() }

func (p *unixPty) Close() error {
	var err error
	p.closeOnce.Do(func() { err = p.ptmx.Close() })
	return err
}
