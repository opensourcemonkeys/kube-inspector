package tui

import (
	"fmt"
	"time"

	"github.com/gdamore/tcell/v2"
	"github.com/rivo/tview"

	"kube-ins/internal/business"
	"kube-ins/internal/models"
)

// showLogs streams a pod container's logs into a TextView. It picks the
// container first (prompting if there is more than one).
func (a *App) showLogs(row rowData, view string) {
	containers, err := business.GetPodContainers(a.cluster, row.name, row.namespace)
	if err != nil {
		a.flash("Error", err.Error(), colDanger)
		return
	}
	switch len(containers) {
	case 0:
		a.flash("Logs", "pod has no containers", colWarn)
	case 1:
		a.startLogs(row, containers[0])
	default:
		a.pickContainer(containers, func(c string) { a.startLogs(row, c) })
	}
}

// pickContainer shows a small list modal to choose a container.
func (a *App) pickContainer(containers []string, onPick func(string)) {
	list := tview.NewList().ShowSecondaryText(false)
	list.SetBackgroundColor(colPanel)
	list.SetMainTextColor(colInk)
	list.SetSelectedBackgroundColor(colTealDim)
	list.SetBorder(true).SetBorderColor(colTeal).SetTitle(" Select container ")
	for _, c := range containers {
		name := c
		list.AddItem(name, "", 0, func() {
			a.closeModal("container")
			onPick(name)
		})
	}
	list.SetInputCapture(func(ev *tcell.EventKey) *tcell.EventKey {
		if ev.Key() == tcell.KeyEsc {
			a.closeModal("container")
			return nil
		}
		return ev
	})
	a.modal("container", list, 50, len(containers)+2)
}

func (a *App) startLogs(row rowData, container string) {
	tv := tview.NewTextView().
		SetDynamicColors(false).
		SetScrollable(true).
		SetMaxLines(5000)
	tv.SetBackgroundColor(colBg)
	tv.SetTextColor(colInk)
	tv.SetBorder(true).SetBorderColor(colBorder).
		SetTitle(fmt.Sprintf(" logs: %s/%s [%s] ", row.namespace, row.name, container))

	sessionID := fmt.Sprintf("tui-log-%d", time.Now().UnixNano())
	follow := true

	stop := func() {
		business.StopLogStream(sessionID)
		a.backToResource()
	}

	tv.SetInputCapture(func(ev *tcell.EventKey) *tcell.EventKey {
		switch {
		case ev.Key() == tcell.KeyEsc, ev.Key() == tcell.KeyRune && ev.Rune() == 'q':
			stop()
			return nil
		case ev.Key() == tcell.KeyRune && ev.Rune() == 'f':
			follow = !follow
			if follow {
				tv.ScrollToEnd()
			}
			return nil
		case ev.Key() == tcell.KeyRune && ev.Rune() == 'g':
			tv.ScrollToBeginning()
			return nil
		case ev.Key() == tcell.KeyRune && ev.Rune() == 'G':
			tv.ScrollToEnd()
			return nil
		}
		return ev
	})

	a.setStatus("pods ▸ logs", hintLogs)
	a.pages.AddPage("detail", tv, true, true)
	a.app.SetFocus(tv)

	onData := func(s string) {
		a.app.QueueUpdateDraw(func() {
			fmt.Fprint(tv, s)
			if follow {
				tv.ScrollToEnd()
			}
		})
	}
	if err := business.StartLogStream(a.cluster, sessionID, row.name, row.namespace, container, models.LogStreamOptions{TailLines: 1000}, onData, nil); err != nil {
		a.flash("Error", err.Error(), colDanger)
		stop()
	}
}
