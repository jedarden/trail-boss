package main

import (
	"fmt"
	"log"
	"sync"
	"time"
)

// Detector manages the polling loop and state for all monitored panes
type Detector struct {
	mu        sync.RWMutex
	panes     map[string]*PaneState // pane_id -> state
	running   bool
	stopCh    chan struct{}
	sessionID string // synthetic session ID for tmux-only detection
}

// NewDetector creates a new detector
func NewDetector() *Detector {
	return &Detector{
		panes:     make(map[string]*PaneState),
		stopCh:    make(chan struct{}),
		sessionID: "tmux-fallback-detector",
	}
}

// Run starts the polling loop
func (d *Detector) Run() {
	d.mu.Lock()
	d.running = true
	d.mu.Unlock()

	log.Println("[detector] started, polling every", pollInterval)

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-d.stopCh:
			log.Println("[detector] stopped")
			return
		case <-ticker.C:
			d.poll()
		}
	}
}

// Stop stops the detector
func (d *Detector) Stop() {
	d.mu.Lock()
	if !d.running {
		d.mu.Unlock()
		return
	}
	d.running = false
	d.mu.Unlock()
	close(d.stopCh)
}

// poll checks all monitored panes and emits events as needed
func (d *Detector) poll() {
	paneIDs, err := ListMonitoredPanes()
	if err != nil {
		log.Printf("[detector] error listing panes: %v", err)
		return
	}

	if len(paneIDs) == 0 {
		return
	}

	for _, paneID := range paneIDs {
		d.checkPane(paneID)
	}
}

// checkPane examines a single pane and emits stuck/unstuck events as needed
func (d *Detector) checkPane(paneID string) {
	content, lastLine, err := CapturePaneContent(paneID, 100)
	if err != nil {
		log.Printf("[detector] error capturing pane %s: %v", paneID, err)
		return
	}

	hash := ContentHash(content)
	now := time.Now()

	d.mu.Lock()
	state, exists := d.panes[paneID]
	if !exists {
		state = &PaneState{
			PaneID:   paneID,
			LastHash: hash,
			LastSeen: now,
			IsStuck:  false,
		}
		d.panes[paneID] = state
		d.mu.Unlock()

		// New pane: register it with the daemon (optional, for tracking)
		cwd := GetPaneCWD(paneID)
		regEvent := SessionRegistered{
			Type:          "registered",
			SessionID:     paneID, // use pane_id as session_id for tmux-only sessions
			PaneID:        paneID,
			CWD:           cwd,
			TranscriptPath: "", // no transcript for tmux-only sessions
			Timestamp:     now.UnixMilli(),
		}
		if err := PostRegistered(regEvent); err != nil {
			log.Printf("[detector] error registering pane %s: %v", paneID, err)
		}
		return
	}

	// Content changed: update hash and timer
	state.LastSeen = now
	changed := hash != state.LastHash
	d.mu.Unlock()

	// Detection logic
	if state.IsStuck {
		// Currently stuck: check if unstuck (content changed)
		if changed {
			d.markUnstuck(paneID, state, now)
			state.LastHash = hash
		}
	} else {
		// Currently not stuck: check if stuck (quiet for threshold + looks like prompt)
		if !changed && LooksLikePrompt(lastLine) {
			quietTime := now.Sub(state.LastSeen)
			if quietTime >= stuckThreshold {
				d.markStuck(paneID, state, now, lastLine)
			}
		} else if changed {
			// Content changed, update hash
			state.LastHash = hash
		}
	}
}

// markStuck emits a stuck event for the pane
func (d *Detector) markStuck(paneID string, state *PaneState, now time.Time, lastLine string) {
	state.IsStuck = true
	state.StuckSince = now

	cwd := GetPaneCWD(paneID)
	event := StuckEvent{
		Type:      "stuck",
		SessionID: paneID, // use pane_id as session_id for tmux-only sessions
		PaneID:    paneID,
		CWD:       cwd,
		TranscriptPath: "", // no transcript for tmux-only sessions
		Reason:    "stopped",
		Message:   fmt.Sprintf("Quiet at prompt: %s", lastLine),
		Timestamp: now.UnixMilli(),
	}

	if err := PostStuck(event); err != nil {
		log.Printf("[detector] error posting stuck event for pane %s: %v", paneID, err)
		return
	}

	log.Printf("[detector] pane %s stuck (quiet for %s)", paneID, stuckThreshold)
}

// markUnstuck emits an unstuck event for the pane
func (d *Detector) markUnstuck(paneID string, state *PaneState, now time.Time) {
	state.IsStuck = false
	state.StuckSince = time.Time{}

	event := UnstuckEvent{
		Type:      "unstuck",
		SessionID: paneID,
		Timestamp: now.UnixMilli(),
	}

	if err := PostUnstuck(event); err != nil {
		log.Printf("[detector] error posting unstuck event for pane %s: %v", paneID, err)
		return
	}

	log.Printf("[detector] pane %s unstuck", paneID)
}
