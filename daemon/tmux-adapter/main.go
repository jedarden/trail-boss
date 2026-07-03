package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	log.Printf("[tmux-detector] starting (poll=%v, threshold=%v)", pollInterval, stuckThreshold)
	log.Printf("[tmux-detector] daemon URL: %s", daemonURL)

	// Create and start the detector
	detector := NewDetector()
	go detector.Run()

	// Wait for interrupt signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	<-sigCh

	log.Println("[tmux-detector] shutting down...")
	detector.Stop()
}
