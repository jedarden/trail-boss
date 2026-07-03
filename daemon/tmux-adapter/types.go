package main

import "time"

// StuckEvent is a normalized stuck event for POST to /event/normalized
type StuckEvent struct {
	Type          string `json:"type"`          // "stuck"
	SessionID     string `json:"sessionId"`
	PaneID        string `json:"paneId"`
	CWD           string `json:"cwd"`
	TranscriptPath string `json:"transcriptPath"`
	Reason        string `json:"reason"`        // "stopped" for tmux-detected stalls
	Message       string `json:"message"`       // descriptive message
	Timestamp     int64  `json:"timestamp"`     // unix ms
}

// UnstuckEvent is a normalized unstuck event for POST to /event/normalized
type UnstuckEvent struct {
	Type      string `json:"type"` // "unstuck"
	SessionID string `json:"sessionId"`
	Timestamp int64  `json:"timestamp"` // unix ms
}

// SessionRegistered is for future use if we want to track panes from the start
type SessionRegistered struct {
	Type          string `json:"type"` // "registered"
	SessionID     string `json:"sessionId"`
	PaneID        string `json:"paneId"`
	CWD           string `json:"cwd"`
	TranscriptPath string `json:"transcriptPath"` // empty for tmux-only sessions
	Timestamp     int64  `json:"timestamp"`     // unix ms
}

// PaneState tracks detection state for a single pane
type PaneState struct {
	PaneID       string
	LastHash     string    // content hash from last poll
	LastSeen     time.Time // last poll time
	StuckSince   time.Time // when we first detected stuck state, zero if not stuck
	IsStuck      bool
}

const (
	// Poll interval - check panes every 2s
	pollInterval = 2 * time.Second
	// Stuck threshold - pane must be quiet for this long before being considered stuck
	stuckThreshold = 10 * time.Second
)
