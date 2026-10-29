package tui

import (
	"fmt"
	"strings"
	"time"

	"github.com/gdamore/tcell/v2"
	"github.com/rivo/tview"
)

// buildResource builds the generic table body for a resource def and wires its
// key handling. It returns the body primitive (mounted into the workspace's
// right pane by mountResource), the table to focus, and the status-bar hints.
// The caller (mountResource) is responsible for mounting it and setting focus.
// The def may be a dynamically constructed child (drill-down) that is not in
// the registry.
func (a *App) buildResource(def *resourceDef) (tview.Primitive, *tview.Table, string) {
	table := tview.NewTable().
		SetBorders(false).
		SetSelectable(true, false).
		SetFixed(1, 0)
	table.SetBackgroundColor(colBg)
	table.SetBorder(true).SetBorderColor(colBorder).SetTitle(" " + def.title + " ")
	focusBorder(table.Box)

	filter := tview.NewInputField().SetLabel(" / ")
	filter.SetLabelColor(colTeal)
	filter.SetFieldBackgroundColor(colBg)
	filter.SetFieldTextColor(colInk)

	body := tview.NewFlex().SetDirection(tview.FlexRow).
		AddItem(table, 0, 1, true)

	var allRows []rowData
	var shown []rowData
	// Text of the last failed list, or "" when the last fetch succeeded. Drawn by
	// render so a failing cluster is visible without a modal — the auto-refresh
	// runs every few seconds and cannot pop one up per tick. Only ever touched on
	// the UI thread (render/reload, and the ticker's QueueUpdateDraw callback).
	var listErr string
	statusCol := statusColumnIndex(def.headers)

	render := func(query string) {
		// Preserve the selected row across re-renders so the live auto-refresh
		// (and filtering) doesn't yank the cursor back to the top every tick.
		prevRow, _ := table.GetSelection()
		table.Clear()
		for c, h := range def.headers {
			table.SetCell(0, c, headerCell(h))
		}
		shown = shown[:0]
		q := strings.ToLower(query)
		for _, r := range allRows {
			if q != "" && !strings.Contains(strings.ToLower(r.name+" "+r.namespace), q) {
				continue
			}
			shown = append(shown, r)
			row := len(shown)
			for c, val := range r.cells {
				color := colInk
				if c == statusCol {
					color = statusColor(strings.SplitN(val, ",", 2)[0])
				}
				table.SetCell(row, c, tview.NewTableCell(" "+val+" ").SetTextColor(color).SetExpansion(1))
			}
		}
		if len(shown) == 0 {
			// "the cluster says there is nothing here" and "we could not ask the
			// cluster" used to draw the identical empty table; show the wrapped
			// error instead so RBAC-403 and a dead API server are legible.
			msg, color := " (no items) ", colMuted
			if listErr != "" {
				msg, color = " "+listErr+" ", colDanger
			}
			table.SetCell(1, 0, tview.NewTableCell(msg).SetTextColor(color).SetSelectable(false))
		} else {
			if prevRow < 1 {
				prevRow = 1
			}
			if prevRow > len(shown) {
				prevRow = len(shown)
			}
			table.Select(prevRow, 0)
		}
		title := fmt.Sprintf(" %s (%d) ", def.title, len(shown))
		if listErr != "" && len(shown) > 0 {
			// Rows survived a failed refresh: say so, rather than letting the user
			// read stale data as live.
			title = fmt.Sprintf(" %s (%d) · stale ", def.title, len(shown))
		}
		table.SetTitle(title)
	}

	// reload runs on the UI thread: initial load and the manual 'r' key. The modal
	// is fine here because the user asked for the refresh; the ticker below must
	// not use one.
	reload := func() {
		start := time.Now()
		rows, err := def.list(a.cluster)
		a.updateRate(time.Since(start), err == nil)
		if err != nil {
			listErr = err.Error()
			a.flash("Error", listErr, colDanger)
		} else {
			// Keep the last good rows on a failed refresh — a transient error
			// should not blank a table the user is reading; the title says stale.
			listErr = ""
			allRows = rows
		}
		render(filter.GetText())
	}
	reload()

	// Auto-refresh: poll the list on an interval in the background so the table
	// stays live without the user pressing 'r'. The fetch runs off the UI thread;
	// only the re-render and rate readout are marshalled back onto it via
	// QueueUpdateDraw (which is where allRows/shown are mutated, same as the
	// manual reload — so there is no concurrent access). The goroutine exits when
	// loadResource/showClusters closes the stop channel.
	stop := make(chan struct{})
	a.refreshStop = stop
	go func() {
		ticker := time.NewTicker(a.refreshRate)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				start := time.Now()
				rows, err := def.list(a.cluster)
				elapsed := time.Since(start)
				select {
				case <-stop: // view was swapped while the fetch was in flight
					return
				default:
				}
				a.app.QueueUpdateDraw(func() {
					a.updateRate(elapsed, err == nil)
					if err != nil {
						// Surface it in the table rather than swallowing it: a
						// persistently failing list would otherwise freeze on stale
						// rows with only the rate readout hinting at trouble. No
						// modal here — this fires every few seconds and would steal
						// focus from whatever the user is doing.
						listErr = err.Error()
					} else {
						listErr = ""
						allRows = rows
					}
					render(filter.GetText())
				})
			}
		}
	}()

	selected := func() (rowData, bool) {
		r, _ := table.GetSelection()
		idx := r - 1
		if idx < 0 || idx >= len(shown) {
			return rowData{}, false
		}
		return shown[idx], true
	}

	// While the describe pane is open, moving the selection retargets it to the
	// newly highlighted row and triggers an immediate refresh.
	table.SetSelectionChangedFunc(func(r, _ int) {
		if !a.describeOpen {
			return
		}
		idx := r - 1
		if idx < 0 || idx >= len(shown) {
			return
		}
		a.setDescribeTarget(def, shown[idx], def.view)
		a.kickDescribe()
	})

	openFilter := func() {
		body.AddItem(filter, 1, 0, false)
		a.app.SetFocus(filter)
	}
	closeFilter := func() {
		body.RemoveItem(filter)
		a.app.SetFocus(table)
	}
	filter.SetChangedFunc(func(text string) { render(text) })
	filter.SetInputCapture(func(ev *tcell.EventKey) *tcell.EventKey {
		switch ev.Key() {
		case tcell.KeyEnter, tcell.KeyEsc:
			if ev.Key() == tcell.KeyEsc {
				filter.SetText("")
				render("")
			}
			closeFilter()
			return nil
		}
		return ev
	})

	// On the split workspace the menu is always visible to the left, so "back"
	// just returns focus to it rather than swapping screens. On a drilled-into
	// child list it returns to the parent list instead.
	back := func() {
		if def.parent != "" {
			a.loadResource(def.parent)
			return
		}
		a.app.SetFocus(a.tree)
	}

	hints := hintList
	if def.isPods {
		hints = hintListPod
	}
	if def.drill != nil {
		hints = hintListDrill
	}
	if def.hints != "" {
		hints = def.hints
	}

	table.SetInputCapture(func(ev *tcell.EventKey) *tcell.EventKey {
		switch ev.Key() {
		case tcell.KeyLeft:
			// Left arrow: move focus back to the menu pane.
			a.app.SetFocus(a.tree)
			return nil
		case tcell.KeyRight:
			// Right arrow: move focus into the describe pane to scroll it.
			if a.describeOpen && a.describeText != nil {
				a.app.SetFocus(a.describeText)
			}
			return nil
		case tcell.KeyEnter:
			if r, ok := selected(); ok && !def.noDescribe {
				if def.drill != nil {
					if child := def.drill(a.cluster, r); child != nil {
						a.mountResource(child)
					}
					return nil
				}
				a.showDescribe(def, r, def.view)
			}
			return nil
		case tcell.KeyEsc:
			if a.describeOpen {
				a.closeDescribe()
				a.app.SetFocus(table)
				return nil
			}
			back()
			return nil
		case tcell.KeyRune:
			switch ev.Rune() {
			case 'q':
				if a.describeOpen {
					a.closeDescribe()
					a.app.SetFocus(table)
					return nil
				}
				back()
				return nil
			case 'c':
				a.showClusters()
				return nil
			case '/':
				openFilter()
				return nil
			case 'r':
				reload()
				return nil
			case 'y':
				if r, ok := selected(); ok && def.getYAML != nil {
					a.showYaml(def, r, def.view)
				}
				return nil
			case 'e':
				if r, ok := selected(); ok {
					if def.updateYAML == nil {
						a.flash("Not editable", def.title+" cannot be edited from the TUI", colWarn)
						return nil
					}
					a.editYaml(def, r, def.view)
				}
				return nil
			case 'd':
				if r, ok := selected(); ok {
					if def.del == nil {
						a.flash("Not deletable", def.title+" cannot be deleted from the TUI", colWarn)
						return nil
					}
					target := r.name
					if def.namespaced {
						target = r.namespace + "/" + r.name
					}
					a.confirm(fmt.Sprintf("Delete %s %q?", def.title, target), func() {
						if err := def.del(a.cluster, r.name, r.namespace); err != nil {
							a.flash("Error", err.Error(), colDanger)
							return
						}
						reload()
					})
				}
				return nil
			case 'l':
				if def.isPods {
					if r, ok := selected(); ok {
						a.showLogs(r, def.view)
					}
				}
				return nil
			case 's':
				if def.isPods {
					if r, ok := selected(); ok {
						a.execPod(r, def.view)
					}
				}
				return nil
			case 'g':
				if len(shown) > 0 {
					table.Select(1, 0)
				}
				return nil
			case 'G':
				if len(shown) > 0 {
					table.Select(len(shown), 0)
				}
				return nil
			}
			// extra per-resource actions (e.g. cordon/drain on nodes)
			for _, act := range def.actions {
				if ev.Rune() == act.key && act.custom != nil {
					var row *rowData
					if r, ok := selected(); ok {
						row = &r
					}
					act.custom(a, row, reload)
					return nil
				}
				if ev.Rune() == act.key {
					if r, ok := selected(); ok {
						finish := func(err error) {
							if err != nil {
								a.flash("Error", err.Error(), colDanger)
								return
							}
							a.flash(act.label, fmt.Sprintf("%s: %s", act.label, r.name), colOk)
							reload()
						}
						switch {
						case act.promptLabel != "":
							a.prompt(act.label, act.promptLabel, "", func(arg string) {
								if arg == "" {
									return
								}
								finish(act.runArg(a.cluster, r.name, r.namespace, arg))
							})
						case act.confirm:
							a.confirm(fmt.Sprintf("%s %q?", act.label, r.name), func() {
								finish(act.run(a.cluster, r.name, r.namespace))
							})
						default:
							finish(act.run(a.cluster, r.name, r.namespace))
						}
					}
					return nil
				}
			}
		}
		return ev
	})

	if len(def.actions) > 0 {
		var extra []string
		for _, act := range def.actions {
			extra = append(extra, fmt.Sprintf("[teal]%c[-] %s", act.key, act.label))
		}
		hints = strings.Join(extra, "  ") + "  " + hints
	}

	return body, table, hints
}

// statusColumnIndex finds the STATUS column so it can be colorized; -1 if none.
func statusColumnIndex(headers []string) int {
	for i, h := range headers {
		if h == "STATUS" {
			return i
		}
	}
	return -1
}
