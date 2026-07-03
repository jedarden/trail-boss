package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const daemonURL = "http://127.0.0.1:4000/event/normalized"

var httpClient = &http.Client{Timeout: 2 * time.Second}

// PostStuck posts a StuckEvent to the daemon's normalized event endpoint
func PostStuck(event StuckEvent) error {
	return postEvent(event)
}

// PostUnstuck posts an UnstuckEvent to the daemon's normalized event endpoint
func PostUnstuck(event UnstuckEvent) error {
	return postEvent(event)
}

// PostRegistered posts a SessionRegistered event (for future use)
func PostRegistered(event SessionRegistered) error {
	return postEvent(event)
}

func postEvent(event any) error {
	body, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshaling event: %w", err)
	}

	resp, err := httpClient.Post(daemonURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("posting to daemon: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("daemon returned %d: %s", resp.StatusCode, string(respBody))
	}

	return nil
}
