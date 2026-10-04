package business

import (
	"time"

	"kube-ins/internal/models"
	services "kube-ins/internal/services"
)

// detachGrace is how long a terminal, pod exec or node shell moving between
// windows may go without a panel before it is closed. Generous: a new window
// has to boot the whole frontend before its panel attaches.
const detachGrace = 30 * time.Second

// terminalKubeconfig returns the kubeconfig contents a terminal session should
// run with. An empty result is deliberate: the session file is then left empty
// and kubectl falls back to the user's own kubeconfig, which is the second
// entry in the session's KUBECONFIG list.
func terminalKubeconfig(clusterName string) string {
	if clusterName == "" {
		return ""
	}
	content, err := GetClusterContent(clusterName)
	if err != nil {
		return ""
	}
	return content
}

func CreateTerminalSession(id string, clusterName string, onOutput func(data string, end int64), onExit func()) error {
	return services.CreateTerminalSession(id, terminalKubeconfig(clusterName), onOutput, onExit)
}

// SetTerminalSessionCluster retargets a running terminal without restarting its
// shell — see services.SetTerminalSessionKubeconfig.
func SetTerminalSessionCluster(id string, clusterName string) error {
	return services.SetTerminalSessionKubeconfig(id, terminalKubeconfig(clusterName))
}

func WriteToTerminalSession(id string, data string) error {
	return services.WriteToTerminalSession(id, data)
}

func ResizeTerminalSession(id string, cols int, rows int) error {
	return services.ResizeTerminalSession(id, uint16(cols), uint16(rows))
}

func CloseTerminalSession(id string) error {
	return services.CloseTerminalSession(id)
}

// DetachTerminalSession keeps the shell running while its panel moves to
// another window — see services.DetachTerminalSession.
func DetachTerminalSession(id string) error {
	return services.DetachTerminalSession(id, detachGrace)
}

// AttachTerminalSession picks a moved session up in its new window.
func AttachTerminalSession(id string) (models.TerminalSnapshot, error) {
	data, offset, err := services.AttachTerminalSession(id)
	if err != nil {
		return models.TerminalSnapshot{}, err
	}
	return models.TerminalSnapshot{Data: data, Offset: offset}, nil
}
