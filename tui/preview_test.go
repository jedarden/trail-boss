package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestPreviewFollowsSelectionAndQueueRefresh(t *testing.T) {
	target := filepath.Join(t.TempDir(), "target")
	t.Setenv("TRAILBOSS_PREVIEW_TARGET_FILE", target)
	m := NewModel()
	update := func(msg tea.Msg) {
		t.Helper()
		next, _ := m.Update(msg)
		m = next.(Model)
	}
	assertTarget := func(want string) {
		t.Helper()
		got, err := os.ReadFile(target)
		if err != nil || string(got) != want {
			t.Fatalf("preview target = %q, err = %v; want %q", got, err, want)
		}
	}
	key := func(s string) tea.KeyMsg { return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)} }

	update(queueMsg{{ID: 1, PaneID: "%11"}, {ID: 2, PaneID: "%22"}})
	assertTarget("%11")
	update(key("j"))
	assertTarget("%22")
	update(queueMsg{{ID: 2, PaneID: "%22"}, {ID: 1, PaneID: "%11"}})
	assertTarget("%22") // A reorder preserves the selected queue item.
	update(key("j"))
	assertTarget("%11")
	update(queueMsg{{ID: 3, PaneID: "%33"}})
	assertTarget("%33") // The old selection disappeared.
	update(queueMsg{})
	assertTarget("")
	update(tea.KeyMsg{Type: tea.KeyCtrlD})
	assertTarget("") // Empty queue navigation must not select a negative index.
}

func TestPreviewHandlesTmuxFailures(t *testing.T) {
	path := t.TempDir()
	stub := `#!/bin/sh
case "$1" in
  display-message)
    case "$*" in
      *pane_height*)
        if [ "$TMUX_FAILURE" = height ]; then exit 1; fi
        echo 4;;
      *)
        if [ "$TMUX_FAILURE" = display ]; then exit 1; fi
        if [ "$TMUX_FAILURE" = exited ]; then echo '1 alpha:dev'; else echo '0 alpha:dev'; fi;;
    esac;;
  capture-pane)
    if [ "$TMUX_FAILURE" = capture ]; then exit 1; fi
    printf 'one\ntwo\nthree\nfour\n';;
  *) exit 1;;
esac
`
	if err := os.WriteFile(filepath.Join(path, "tmux"), []byte(stub), 0755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(path, "target")
	for _, tc := range []struct {
		name, pane, failure, want string
	}{
		{"absent target file", "", "", "no session selected"},
		{"missing target", "", "", "no session selected"},
		{"invalid target", "not-a-pane", "", "preview target unavailable"},
		{"live capture", "%17", "", "alpha:dev"},
		{"height command failure", "%17", "height", "four"},
		{"pane exited", "%17", "exited", "pane %17 exited"},
		{"display command failure", "%17", "display", "pane %17 unavailable"},
		{"capture command failure", "%17", "capture", "pane %17 unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "absent target file" {
				if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
					t.Fatal(err)
				}
			} else {
				if err := os.WriteFile(target, []byte(tc.pane), 0600); err != nil {
					t.Fatal(err)
				}
			}
			cmd := exec.Command("bash", "../bin/trailboss-preview", "--once")
			cmd.Env = append(os.Environ(), "PATH="+path+":"+os.Getenv("PATH"),
				"TRAILBOSS_PREVIEW_TARGET_FILE="+target, "TMUX_FAILURE="+tc.failure)
			out, err := cmd.CombinedOutput()
			if err != nil || !strings.Contains(string(out), tc.want) {
				t.Fatalf("preview output = %q, err = %v; want %q", out, err, tc.want)
			}
			if tc.failure == "capture" && strings.Contains(string(out), "alpha:dev") {
				t.Fatalf("stale pane header on failed capture: %q", out)
			}
			if tc.name == "live capture" && (strings.Contains(string(out), "one") || !strings.Contains(string(out), "two\nthree\nfour")) {
				t.Fatalf("preview did not fit the pane height: %q", out)
			}
		})
	}
}
