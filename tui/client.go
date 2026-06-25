package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

const defaultDaemonURL = "http://127.0.0.1:4000"

var httpClient = &http.Client{Timeout: 1 * time.Second}

func daemonURL() string {
	if u := os.Getenv("TRAILBOSS_URL"); u != "" {
		return u
	}
	return defaultDaemonURL
}

// QueueItem represents a single stuck pane in the queue.
// Matches the daemon's /queue response JOIN of queue + sessions.
type QueueItem struct {
	ID                int     `json:"id"`
	SessionID         string  `json:"session_id"`
	PaneID            string  `json:"pane_id"`
	CWD               string  `json:"cwd"`
	Reason            string  `json:"reason"`
	LastMessage       *string `json:"last_message"` // nullable
	StuckAt           int64   `json:"stuck_at"`     // epoch ms
	SkipCooldownUntil *int64  `json:"skip_cooldown_until"` // nullable, epoch ms
}

// QueueResponse is the /queue endpoint response.
type QueueResponse struct {
	Items []QueueItem `json:"items"`
	Count int         `json:"count"`
}

// StatusResponse is the /status endpoint response.
// Matches daemon: { "status": "ok", "stuckCount": N }
type StatusResponse struct {
	Status    string `json:"status"`
	StuckCount int   `json:"stuckCount"`
}

// NextResponse is the /next and /skip endpoint response.
// Matches daemon: { "paneId": "...", "sessionId": "...", "reason": null | "..." }
type NextResponse struct {
	PaneID    *string `json:"paneId"`    // null if queue empty
	SessionID *string `json:"sessionId"` // null if queue empty
	Reason    *string `json:"reason"`    // null on success, error string if empty
}

// FetchQueue fetches the current queue from the daemon and returns the items.
func FetchQueue() ([]QueueItem, error) {
	resp, err := httpClient.Get(daemonURL() + "/queue")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var q QueueResponse
	if err := json.NewDecoder(resp.Body).Decode(&q); err != nil {
		return nil, err
	}
	return q.Items, nil
}

// FetchStatus fetches the daemon status.
func FetchStatus() (StatusResponse, error) {
	resp, err := httpClient.Get(daemonURL() + "/status")
	if err != nil {
		return StatusResponse{}, err
	}
	defer resp.Body.Close()

	var s StatusResponse
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		return StatusResponse{}, err
	}
	return s, nil
}

// PostSkip tells the daemon to skip the current queue head.
func PostSkip() error {
	resp, err := httpClient.Post(daemonURL()+"/skip", "application/json", nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	// Drain the response body but don't use it
	_ = json.NewDecoder(resp.Body).Decode(&NextResponse{})
	return nil
}

// PostNext fetches the head pane_id from the daemon.
// Returns the pane ID string, or empty string if queue is empty (along with any error).
func PostNext() (string, error) {
	resp, err := httpClient.Get(daemonURL() + "/next")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var nr NextResponse
	if err := json.NewDecoder(resp.Body).Decode(&nr); err != nil {
		return "", err
	}

	// If paneId is null or reason indicates an error, return empty string
	if nr.PaneID == nil || nr.Reason != nil && *nr.Reason != "" {
		return "", nil
	}

	return *nr.PaneID, nil
}

// GetPaneSessionMap runs tmux list-panes and returns a map of pane_id → session_name.
func GetPaneSessionMap() map[string]string {
	out, err := exec.Command("tmux", "list-panes", "-a", "-F", "#{pane_id}:#{session_name}").Output()
	if err != nil {
		return map[string]string{}
	}
	m := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(line, ":", 2)
		if len(parts) == 2 {
			m[parts[0]] = parts[1]
		}
	}
	return m
}

// WritePreviewTarget writes paneID to /tmp/trailboss-preview-target so the
// preview pane below the TUI mirrors that session.
func WritePreviewTarget(paneID string) {
	_ = os.WriteFile("/tmp/trailboss-preview-target", []byte(paneID), 0644)
}

// JumpToPane switches the tmux client to the given pane, recording the origin.
func JumpToPane(paneID string) error {
	// Resolve session name for the pane.
	out, err := exec.Command("tmux", "display", "-p", "-t", paneID, "#{session_name}").Output()
	if err != nil {
		return fmt.Errorf("resolving session for pane %s: %w", paneID, err)
	}
	sessionName := strings.TrimSpace(string(out))
	if sessionName == "" {
		return fmt.Errorf("no session found for pane %s", paneID)
	}

	// Write origin before switching so prefix+B can return here.
	if err := os.WriteFile("/tmp/trailboss-origin", []byte(paneID), 0644); err != nil {
		// Non-fatal — log and continue.
		_ = err
	}

	// Switch client to the target pane.
	cmd := exec.Command("tmux",
		"switch-client", "-t", sessionName, ";",
		"select-window", "-t", paneID, ";",
		"select-pane", "-t", paneID,
	)
	return cmd.Run()
}
