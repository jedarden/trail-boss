package main

import (
	"os"

	"github.com/charmbracelet/lipgloss"
)

// Theme defines all visual styles for the Trail Boss TUI using the Dracula color palette.
type Theme struct {
	// Badge styles
	StoppedBadge    lipgloss.Style
	PermissionBadge lipgloss.Style

	// Row styles
	SelectedRow lipgloss.Style
	NormalRow   lipgloss.Style

	// Panel styles
	PanelBorder lipgloss.Style
	PanelHeader lipgloss.Style
	DetailPanel lipgloss.Style

	// Bar styles
	HeaderBar lipgloss.Style
	StatusBar lipgloss.Style

	// Text styles
	MetaText    lipgloss.Style
	AccentCyan  lipgloss.Style
	AccentGreen lipgloss.Style

	// Color support detection
	hasTrueColor bool
	has256Color  bool
	noColor      bool
}

// NewTheme creates a new Theme with auto-detected terminal color support.
func NewTheme() *Theme {
	t := &Theme{}
	t.detectColorSupport()
	t.applyColors()
	return t
}

// detectColorSupport determines the terminal's color capabilities.
func (t *Theme) detectColorSupport() {
	// Check NO_COLOR environment variable (https://no-color.org/)
	if _, exists := os.LookupEnv("NO_COLOR"); exists {
		t.noColor = true
		return
	}

	// Check TERM environment variable
	term := os.Getenv("TERM")

	// Truecolor support
	if os.Getenv("COLORTERM") == "truecolor" || os.Getenv("COLORTERM") == "24bit" {
		t.hasTrueColor = true
		t.has256Color = true
		return
	}

	// 256 color support
	if term == "xterm-256color" || term == "screen-256color" || term == "tmux-256color" {
		t.has256Color = true
		return
	}

	// Dumb terminal
	if term == "dumb" || term == "" {
		t.noColor = true
		return
	}
}

// applyColors configures all styles based on detected color support.
func (t *Theme) applyColors() {
	if t.noColor {
		t.applyNoColor()
		return
	}

	if t.hasTrueColor {
		t.applyTrueColor()
		return
	}

	if t.has256Color {
		t.apply256Color()
		return
	}

	t.applyBasicColor()
}

// applyTrueColor applies full RGB colors (Dracula palette).
func (t *Theme) applyTrueColor() {
	// Badge styles - yellow/red foreground on dark background
	t.StoppedBadge = lipgloss.NewStyle().
		Foreground(lipgloss.Color("#F1FA8C")). // Yellow
		Background(lipgloss.Color("#282A36")). // Dark background
		Bold(true).
		Padding(0, 1).
		MarginRight(1)

	t.PermissionBadge = lipgloss.NewStyle().
		Foreground(lipgloss.Color("#FF5555")). // Red
		Background(lipgloss.Color("#282A36")). // Dark background
		Bold(true).
		Padding(0, 1).
		MarginRight(1)

	// Row styles
	t.SelectedRow = lipgloss.NewStyle().
		Background(lipgloss.Color("#BD93F9")). // Purple
		Foreground(lipgloss.Color("#282A36")). // Dark text for contrast
		Bold(true)

	t.NormalRow = lipgloss.NewStyle().
		Foreground(lipgloss.Color("#F8F8F2")) // Dracula foreground

	// Panel styles - rounded border
	t.PanelBorder = lipgloss.NewStyle().
		Foreground(lipgloss.Color("#6272A4")). // Blue-ish
		Border(lipgloss.RoundedBorder())

	t.PanelHeader = lipgloss.NewStyle().
		Foreground(lipgloss.Color("#BD93F9")). // Purple
		Background(lipgloss.Color("#282A36")).  // Dark background
		Bold(true).
		Padding(0, 1)

	t.DetailPanel = lipgloss.NewStyle().
		Foreground(lipgloss.Color("#F8F8F2")). // Light text
		Padding(0, 1)

	// Bar styles
	t.HeaderBar = lipgloss.NewStyle().
		Foreground(lipgloss.Color("#F8F8F2")). // Light
		Background(lipgloss.Color("#282A36")). // Dark background
		Bold(true).
		Padding(0, 1)

	t.StatusBar = lipgloss.NewStyle().
		Foreground(lipgloss.Color("#F8F8F2")). // Light
		Background(lipgloss.Color("#44475A")). // Gray background
		Padding(0, 1)

	// Text styles
	t.MetaText = lipgloss.NewStyle().
		Foreground(lipgloss.Color("#AAAAAA")) // Gray

	t.AccentCyan = lipgloss.NewStyle().
		Foreground(lipgloss.Color("#8BE9FD")) // Cyan

	t.AccentGreen = lipgloss.NewStyle().
		Foreground(lipgloss.Color("#50FA7B")) // Green
}

// apply256Color applies 256-color palette approximations.
func (t *Theme) apply256Color() {
	// Badge styles
	t.StoppedBadge = lipgloss.NewStyle().
		Foreground(lipgloss.Color("229")). // Closest to #F1FA8C
		Background(lipgloss.Color("235")).  // Closest to #282A36
		Bold(true).
		Padding(0, 1).
		MarginRight(1)

	t.PermissionBadge = lipgloss.NewStyle().
		Foreground(lipgloss.Color("203")). // Closest to #FF5555
		Background(lipgloss.Color("235")).  // Closest to #282A36
		Bold(true).
		Padding(0, 1).
		MarginRight(1)

	// Row styles
	t.SelectedRow = lipgloss.NewStyle().
		Background(lipgloss.Color("141")). // Closest to #BD93F9
		Foreground(lipgloss.Color("235")).  // Dark text for contrast
		Bold(true)

	t.NormalRow = lipgloss.NewStyle().
		Foreground(lipgloss.Color("255")) // White

	// Panel styles
	t.PanelBorder = lipgloss.NewStyle().
		Foreground(lipgloss.Color("61")). // Closest to #6272A4
		Border(lipgloss.RoundedBorder())

	t.PanelHeader = lipgloss.NewStyle().
		Foreground(lipgloss.Color("141")). // Closest to #BD93F9
		Background(lipgloss.Color("235")).  // Closest to #282A36
		Bold(true).
		Padding(0, 1)

	t.DetailPanel = lipgloss.NewStyle().
		Foreground(lipgloss.Color("255")). // White
		Padding(0, 1)

	// Bar styles
	t.HeaderBar = lipgloss.NewStyle().
		Foreground(lipgloss.Color("255")). // White
		Background(lipgloss.Color("235")). // Closest to #282A36
		Bold(true).
		Padding(0, 1)

	t.StatusBar = lipgloss.NewStyle().
		Foreground(lipgloss.Color("255")). // White
		Background(lipgloss.Color("240")). // Closest to #44475A
		Padding(0, 1)

	// Text styles
	t.MetaText = lipgloss.NewStyle().
		Foreground(lipgloss.Color("244")) // Gray

	t.AccentCyan = lipgloss.NewStyle().
		Foreground(lipgloss.Color("117")) // Cyan

	t.AccentGreen = lipgloss.NewStyle().
		Foreground(lipgloss.Color("84")) // Green
}

// applyBasicColor applies basic 8-color fallback.
func (t *Theme) applyBasicColor() {
	// Badge styles
	t.StoppedBadge = lipgloss.NewStyle().
		Foreground(lipgloss.Color("yellow")).
		Bold(true).
		Padding(0, 1).
		MarginRight(1)

	t.PermissionBadge = lipgloss.NewStyle().
		Foreground(lipgloss.Color("red")).
		Bold(true).
		Padding(0, 1).
		MarginRight(1)

	// Row styles
	t.SelectedRow = lipgloss.NewStyle().
		Background(lipgloss.Color("magenta")).
		Foreground(lipgloss.Color("black")).
		Bold(true)

	t.NormalRow = lipgloss.NewStyle().
		Foreground(lipgloss.Color("white"))

	// Panel styles
	t.PanelBorder = lipgloss.NewStyle().
		Foreground(lipgloss.Color("blue")).
		Border(lipgloss.RoundedBorder())

	t.PanelHeader = lipgloss.NewStyle().
		Foreground(lipgloss.Color("magenta")).
		Bold(true).
		Padding(0, 1)

	t.DetailPanel = lipgloss.NewStyle().
		Foreground(lipgloss.Color("white")).
		Padding(0, 1)

	// Bar styles
	t.HeaderBar = lipgloss.NewStyle().
		Foreground(lipgloss.Color("white")).
		Bold(true).
		Padding(0, 1)

	t.StatusBar = lipgloss.NewStyle().
		Foreground(lipgloss.Color("white")).
		Padding(0, 1)

	// Text styles
	t.MetaText = lipgloss.NewStyle().
		Foreground(lipgloss.Color("black"))

	t.AccentCyan = lipgloss.NewStyle().
		Foreground(lipgloss.Color("cyan"))

	t.AccentGreen = lipgloss.NewStyle().
		Foreground(lipgloss.Color("green"))
}

// applyNoColor applies no-color fallback for dumb terminals.
func (t *Theme) applyNoColor() {
	// All styles use basic styling without color
	t.StoppedBadge = lipgloss.NewStyle().Bold(true).Padding(0, 1).MarginRight(1)
	t.PermissionBadge = lipgloss.NewStyle().Bold(true).Padding(0, 1).MarginRight(1)
	t.SelectedRow = lipgloss.NewStyle().Bold(true).Reverse(true)
	t.NormalRow = lipgloss.NewStyle()
	t.PanelBorder = lipgloss.NewStyle().Border(lipgloss.RoundedBorder())
	t.PanelHeader = lipgloss.NewStyle().Bold(true).Padding(0, 1)
	t.DetailPanel = lipgloss.NewStyle().Padding(0, 1)
	t.HeaderBar = lipgloss.NewStyle().Bold(true).Padding(0, 1)
	t.StatusBar = lipgloss.NewStyle().Padding(0, 1)
	t.MetaText = lipgloss.NewStyle()
	t.AccentCyan = lipgloss.NewStyle()
	t.AccentGreen = lipgloss.NewStyle()
}

// HasTrueColor returns true if terminal supports truecolor.
func (t *Theme) HasTrueColor() bool {
	return t.hasTrueColor
}

// Has256Color returns true if terminal supports 256 colors.
func (t *Theme) Has256Color() bool {
	return t.has256Color
}

// NoColor returns true if terminal has no color support.
func (t *Theme) NoColor() bool {
	return t.noColor
}
