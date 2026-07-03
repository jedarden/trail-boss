package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os/exec"
	"strings"
)

// ListMonitoredPanes returns pane IDs that have @trailboss-monitor set to 1
func ListMonitoredPanes() ([]string, error) {
	// Get all panes with the @trailboss-monitor option
	out, err := exec.Command("tmux", "list-panes", "-a", "-F", "#{pane_id}:#{@trailboss-monitor}").Output()
	if err != nil {
		return nil, fmt.Errorf("listing panes: %w", err)
	}

	var panes []string
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}
		parts := strings.Split(line, ":")
		if len(parts) == 2 && parts[1] == "1" {
			panes = append(panes, parts[0])
		}
	}

	return panes, nil
}

// CapturePaneContent captures the last N lines of a pane's output
// Returns the content and the last line (for prompt detection)
func CapturePaneContent(paneID string, lines int) (content string, lastLine string, err error) {
	// Capture last 100 lines by default (enough to detect changes)
	if lines <= 0 {
		lines = 100
	}
	out, err := exec.Command("tmux", "capture-pane", "-p", "-t", paneID, "-S", fmt.Sprintf("-%d", lines)).Output()
	if err != nil {
		return "", "", fmt.Errorf("capturing pane %s: %w", paneID, err)
	}

	content = strings.TrimSpace(string(out))
	linesList := strings.Split(content, "\n")
	if len(linesList) > 0 {
		// Get the last non-empty line
		for i := len(linesList) - 1; i >= 0; i-- {
			if strings.TrimSpace(linesList[i]) != "" {
				lastLine = strings.TrimSpace(linesList[i])
				break
			}
		}
	}

	return content, lastLine, nil
}

// ContentHash computes a stable hash of pane content for change detection
func ContentHash(content string) string {
	// Trim leading/trailing whitespace for stability
	content = strings.TrimSpace(content)
	if content == "" {
		return ""
	}
	h := sha256.Sum256([]byte(content))
	return hex.EncodeToString(h[:])
}

// LooksLikePrompt returns true if the line looks like a shell prompt
// This is heuristic and will need tuning based on real-world usage
func LooksLikePrompt(line string) bool {
	line = strings.TrimSpace(line)
	if line == "" {
		return false
	}

	// Common prompt endings
	promptSuffixes := []string{"$", ">", "#", "%", "?", "→", "❯", "➜", "⚡"}
	for _, suffix := range promptSuffixes {
		if strings.HasSuffix(line, suffix) {
			return true
		}
	}

	// User@host patterns (e.g., "user@hostname:path")
	if strings.Contains(line, "@") && strings.Contains(line, ":") {
		return true
	}

	// Bracketed prompts like [user@host ~]
	if strings.HasPrefix(line, "[") && strings.Contains(line, "@") && strings.HasSuffix(line, "]") {
		return true
	}

	return false
}

// GetPaneCWD attempts to get the current working directory of a pane
// Returns empty string if unable to determine (not critical for tmux-only sessions)
func GetPaneCWD(paneID string) string {
	// Try to get pane's current path via tmux
	// Note: this requires shell integration; many shells don't expose this
	// We'll use empty string as fallback, which is acceptable for tmux-only sessions
	out, err := exec.Command("tmux", "display", "-p", "-t", paneID, "#{pane_current_path}").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
