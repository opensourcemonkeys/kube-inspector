package tui

import "testing"

// The TUI counterpart of the GUI's CronJob "Run now" (⋮ menu). custom, not
// run/confirm: the generic report only says "<label>: <row>", and the useful
// answer is the name of the Job that was created.
func TestCronJobsCanBeRunNow(t *testing.T) {
	_, defs := buildRegistry()
	def, ok := defs["cronjobs"]
	if !ok {
		t.Fatal("no cronjobs view in the registry")
	}
	for _, act := range def.actions {
		if act.key == 'T' {
			if act.label != "run now" || act.custom == nil {
				t.Fatalf("T on cronjobs: label %q, custom set %v", act.label, act.custom != nil)
			}
			return
		}
	}
	t.Fatal("cronjobs has no T (run now) action")
}

// The list screen takes the first action whose key matches, so a second one on
// the same key would be silently unreachable.
func TestNoTwoActionsShareAKey(t *testing.T) {
	_, defs := buildRegistry()
	for view, def := range defs {
		seen := map[rune]string{}
		for _, act := range def.actions {
			if prev, dup := seen[act.key]; dup {
				t.Errorf("%s: %q and %q both use %q", view, prev, act.label, act.key)
			}
			seen[act.key] = act.label
		}
	}
}
