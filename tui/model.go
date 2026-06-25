package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ---------------------------------------------------------------------------
// Tea message types
// ---------------------------------------------------------------------------

type tickMsg time.Time
type queueMsg []QueueItem
type statusMsg StatusResponse
type errMsg struct{ err error }
type jumpDoneMsg struct{}
type paneMapMsg map[string]string

func (e errMsg) Error() string { return e.err.Error() }

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

// Model is the main Bubble Tea model for the Trail Boss TUI.
type Model struct {
	queue        []QueueItem // Changed from QueueResponse to []QueueItem
	status       StatusResponse
	paneMap      map[string]string // pane_id → session_name
	cursor       int
	detailScroll int
	width        int
	height       int
	daemonOK     bool
	err          error
	lastKey      string
	showHelp     bool
	loading      bool
	theme        *Theme
	detail       viewport.Model
}

// NewModel creates a fully-initialized Model.
func NewModel() Model {
	return Model{
		theme:   NewTheme(),
		paneMap: map[string]string{},
		loading: true,
	}
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

func (m Model) Init() tea.Cmd {
	return tea.Batch(
		fetchQueueCmd(),
		fetchStatusCmd(),
		fetchPaneMapCmd(),
		tickCmd(),
	)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

func tickCmd() tea.Cmd {
	return tea.Tick(3*time.Second, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func fetchQueueCmd() tea.Cmd {
	return func() tea.Msg {
		q, err := FetchQueue()
		if err != nil {
			return errMsg{err}
		}
		return queueMsg(q)
	}
}

func fetchStatusCmd() tea.Cmd {
	return func() tea.Msg {
		s, err := FetchStatus()
		if err != nil {
			return errMsg{err}
		}
		return statusMsg(s)
	}
}

func fetchPaneMapCmd() tea.Cmd {
	return func() tea.Msg {
		return paneMapMsg(GetPaneSessionMap())
	}
}

func skipCmd() tea.Cmd {
	return func() tea.Msg {
		_ = PostSkip()
		q, err := FetchQueue()
		if err != nil {
			return errMsg{err}
		}
		return queueMsg(q)
	}
}

func jumpToPaneCmd(paneID string) tea.Cmd {
	return func() tea.Msg {
		_ = JumpToPane(paneID)
		return jumpDoneMsg{}
	}
}

func jumpToNextCmd() tea.Cmd {
	return func() tea.Msg {
		paneID, err := PostNext()
		if err != nil || paneID == "" {
			return jumpDoneMsg{}
		}
		_ = JumpToPane(paneID)
		return jumpDoneMsg{}
	}
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.detail = viewport.New(m.detailWidth(), m.contentHeight())
		m.detail.SetContent(m.detailContent())
		return m, nil

	case tickMsg:
		return m, tea.Batch(fetchQueueCmd(), fetchStatusCmd(), fetchPaneMapCmd(), tickCmd())

	case queueMsg:
		m.loading = false
		m.daemonOK = true
		m.err = nil
		oldLen := len(m.queue)
		m.queue = msg
		// Clamp cursor.
		if m.cursor >= len(m.queue) {
			m.cursor = max(0, len(m.queue)-1)
		}
		// Reset detail scroll only when the list shrank or was empty.
		if len(m.queue) < oldLen || oldLen == 0 {
			m.detailScroll = 0
		}
		m.detail.SetContent(m.detailContent())
		m.syncPreview()
		return m, nil

	case statusMsg:
		m.status = StatusResponse(msg)
		return m, nil

	case errMsg:
		m.loading = false
		m.daemonOK = false
		m.err = msg.err
		return m, nil

	case paneMapMsg:
		m.paneMap = map[string]string(msg)
		return m, nil

	case jumpDoneMsg:
		return m, nil

	case tea.KeyMsg:
		return m.handleKey(msg)
	}

	return m, nil
}

func (m Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := msg.String()

	if m.showHelp {
		if key == "?" || key == "q" || key == "esc" {
			m.showHelp = false
		}
		return m, nil
	}

	n := len(m.queue)

	// gg — jump to top
	if key == "g" {
		if m.lastKey == "g" {
			m.cursor = 0
			m.detailScroll = 0
			m.lastKey = ""
			m.detail.SetContent(m.detailContent())
			m.syncPreview()
			return m, nil
		}
		m.lastKey = "g"
		return m, nil
	}
	m.lastKey = key

	switch key {
	case "q", "ctrl+c":
		return m, tea.Quit

	case "?":
		m.showHelp = true

	case "j", "down":
		if m.cursor < n-1 {
			m.cursor++
			m.detailScroll = 0
			m.detail.SetContent(m.detailContent())
			m.syncPreview()
		}

	case "k", "up":
		if m.cursor > 0 {
			m.cursor--
			m.detailScroll = 0
			m.detail.SetContent(m.detailContent())
			m.syncPreview()
		}

	case "G":
		if n > 0 {
			m.cursor = n - 1
			m.detailScroll = 0
			m.detail.SetContent(m.detailContent())
			m.syncPreview()
		}

	case "ctrl+d":
		half := max(1, m.contentHeight()/2)
		m.cursor = min(n-1, m.cursor+half)
		m.detailScroll = 0
		m.detail.SetContent(m.detailContent())
		m.syncPreview()

	case "ctrl+u":
		half := max(1, m.contentHeight()/2)
		m.cursor = max(0, m.cursor-half)
		m.detailScroll = 0
		m.detail.SetContent(m.detailContent())
		m.syncPreview()

	case "enter", "l":
		if n > 0 && m.cursor < n {
			return m, jumpToPaneCmd(m.queue[m.cursor].PaneID)
		}

	case "tab":
		return m, jumpToNextCmd()

	case "s":
		return m, skipCmd()

	case "r":
		return m, tea.Batch(fetchQueueCmd(), fetchStatusCmd(), fetchPaneMapCmd())

	case "J":
		m.detail.LineDown(1)

	case "K":
		m.detail.LineUp(1)

	case "1", "2", "3", "4", "5", "6", "7", "8", "9":
		idx := int(key[0]-'0') - 1
		if idx >= 0 && idx < n {
			m.cursor = idx
			m.detailScroll = 0
			m.detail.SetContent(m.detailContent())
			m.syncPreview()
		}
	}

	return m, nil
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

func (m Model) View() string {
	if m.width == 0 || m.height == 0 {
		return "Loading..."
	}

	if m.showHelp {
		return m.helpView()
	}

	header := m.headerView()
	status := m.statusBarView()
	// Reserve 2 rows for header + status bar.
	bodyHeight := m.height - 2

	var body string
	if m.width >= 100 {
		body = m.splitView(bodyHeight)
	} else {
		body = m.listOnlyView(bodyHeight)
	}

	return lipgloss.JoinVertical(lipgloss.Left, header, body, status)
}

// headerView renders the top bar.
func (m Model) headerView() string {
	var countBadge string
	if len(m.queue) == 0 {
		countBadge = m.theme.AccentGreen.Render(fmt.Sprintf("✓ %d stuck", len(m.queue)))
	} else {
		countBadge = m.theme.AccentCyan.Render(fmt.Sprintf("⚠ %d stuck", len(m.queue)))
	}

	keys := m.theme.MetaText.Render("  [Tab] next   [s] skip   [Enter] jump   [?] help   [q] quit")
	title := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#BD93F9")).Render("Trail Boss")
	content := title + "  " + countBadge + keys

	return m.theme.HeaderBar.Width(m.width).Render(content)
}

// statusBarView renders the bottom status bar.
func (m Model) statusBarView() string {
	var parts []string

	if m.daemonOK {
		parts = append(parts, m.theme.AccentGreen.Render("daemon: ok ✓"))
	} else {
		parts = append(parts, lipgloss.NewStyle().Foreground(lipgloss.Color("#FF5555")).Bold(true).Render("daemon: unreachable ✗"))
	}

	parts = append(parts, fmt.Sprintf("queue: %d", len(m.queue)))

	if m.daemonOK {
		ago := m.status.LastReconcileAgoS
		if ago < 0 {
			ago = 0
		}
		parts = append(parts, fmt.Sprintf("reconcile: %.0fs ago", ago))

		if m.status.SkipCooldownS > 0 {
			parts = append(parts, fmt.Sprintf("skip cooldown: %.0fs", m.status.SkipCooldownS))
		} else {
			parts = append(parts, "skip cooldown: —")
		}
	}

	content := strings.Join(parts, "   ")
	return m.theme.StatusBar.Width(m.width).Render(content)
}

// splitView renders the two-pane layout.
func (m Model) splitView(height int) string {
	listW := m.listWidth()
	detailW := m.detailWidth()

	listContent := m.listView(listW, height)
	detailContent := m.detailPaneView(detailW, height)

	// Pad list to full height.
	listLines := strings.Split(listContent, "\n")
	for len(listLines) < height {
		listLines = append(listLines, strings.Repeat(" ", listW))
	}
	listContent = strings.Join(listLines, "\n")

	// Draw vertical divider.
	divider := lipgloss.NewStyle().
		Foreground(m.theme.BorderColor).
		Render(strings.Repeat("│\n", height-1)+"│")

	return lipgloss.JoinHorizontal(lipgloss.Top, listContent, divider, detailContent)
}

// listOnlyView renders the list filling the full width.
func (m Model) listOnlyView(height int) string {
	return m.listView(m.width, height)
}

// listWidth returns the width for the list pane.
func (m Model) listWidth() int {
	w := m.width * 40 / 100
	if w < 30 {
		w = 30
	}
	return w
}

// detailWidth returns the width for the detail pane.
func (m Model) detailWidth() int {
	// Subtract list width and the 1-char divider.
	return m.width - m.listWidth() - 1
}

// contentHeight returns body height (total minus header/status rows).
func (m Model) contentHeight() int {
	h := m.height - 2
	if h < 1 {
		h = 1
	}
	return h
}

// listView renders the queue list pane.
func (m Model) listView(width, height int) string {
	t := m.theme

	// Header row.
	colIdx := padRight(" #", 3)
	colReason := padRight("REASON", 12)
	colSession := "SESSION"
	headerText := t.MetaText.Render(colIdx + " " + colReason + " " + colSession)

	sep := t.MetaText.Render(strings.Repeat("─", width))

	lines := []string{headerText, sep}

	if len(m.queue) == 0 {
		emptyMsg := t.MetaText.Render("  (no stuck sessions)")
		lines = append(lines, emptyMsg)
	}

	for i, item := range m.queue.Items {
		// Determine session label.
		sessLabel := m.paneMap[item.PaneID]
		if sessLabel == "" {
			// Fall back to last path component of CWD.
			parts := strings.Split(strings.TrimRight(item.CWD, "/"), "/")
			if len(parts) > 0 {
				sessLabel = parts[len(parts)-1]
			}
		}
		if sessLabel == "" && len(item.SessionID) > 8 {
			sessLabel = item.SessionID[:8]
		} else if sessLabel == "" {
			sessLabel = item.SessionID
		}

		// Reason badge.
		var badge string
		switch item.Reason {
		case "permission":
			badge = t.PermissionBadge.Render("perm")
		default:
			badge = t.StoppedBadge.Render("stop")
		}

		// Marker for selected row.
		marker := " "
		if i == m.cursor {
			marker = "▶"
		}

		idxStr := fmt.Sprintf("%2d", i+1)
		// Plain text portion of the row: idx + badge + session.
		// We can't easily mix styled badge and row highlight, so render differently.
		plain := fmt.Sprintf("%s %s  %-14s %s", idxStr, badge, padRight(sessLabel, 14), marker)

		var line string
		if i == m.cursor {
			line = t.SelectedRow.Width(width).Render(plain)
		} else {
			line = t.NormalRow.Width(width).Render(plain)
		}
		lines = append(lines, line)
	}

	// Pad to height.
	for len(lines) < height {
		lines = append(lines, strings.Repeat(" ", width))
	}
	// Truncate if too tall.
	if len(lines) > height {
		lines = lines[:height]
	}

	return strings.Join(lines, "\n")
}

// detailPaneView renders the right detail panel.
func (m Model) detailPaneView(width, height int) string {
	t := m.theme

	if len(m.queue) == 0 || m.cursor >= len(m.queue) {
		empty := t.MetaText.Render("  (select an item to view details)")
		return padToHeight(empty, width, height)
	}

	item := m.queue[m.cursor]

	// Resolve session.
	sessLabel := m.paneMap[item.PaneID]
	if sessLabel == "" {
		parts := strings.Split(strings.TrimRight(item.CWD, "/"), "/")
		if len(parts) > 0 {
			sessLabel = parts[len(parts)-1]
		}
	}

	// Compute relative stuck time.
	stuckAge := ""
	if item.StuckAt > 0 {
		d := time.Since(time.UnixMilli(item.StuckAt))
		stuckAge = formatDuration(d)
	}

	// Build detail title.
	titleText := fmt.Sprintf("Detail: %s", sessLabel)
	if stuckAge != "" {
		titleText += fmt.Sprintf(" — %s", stuckAge)
	}
	title := t.AccentCyan.Render(titleText)
	sep := t.MetaText.Render(strings.Repeat("─", width-2))

	// CWD line.
	cwdLine := t.MetaText.Render("cwd: ") + t.NormalRow.Render(item.CWD)

	// Last message, wrapped.
	msgLabel := t.MetaText.Render("last message:")
	innerWidth := width - 4 // 2 for padding each side
	if innerWidth < 10 {
		innerWidth = 10
	}
	wrapped := wordWrap(item.LastMessage, innerWidth)

	// Update the viewport with the latest content, then render it.
	m.detail.Width = width
	m.detail.Height = height - 4 // subtract title+sep+cwd+label rows
	if m.detail.Height < 1 {
		m.detail.Height = 1
	}

	fullContent := lipgloss.JoinVertical(lipgloss.Left,
		title,
		sep,
		cwdLine,
		msgLabel,
		"  "+strings.ReplaceAll(wrapped, "\n", "\n  "),
	)
	_ = fullContent // set in Update, not here

	// Compose visible lines.
	var lines []string
	lines = append(lines, title)
	lines = append(lines, sep)
	lines = append(lines, cwdLine)
	lines = append(lines, msgLabel)

	msgLines := strings.Split("  "+strings.ReplaceAll(strings.TrimSpace(wrapped), "\n", "\n  "), "\n")
	lines = append(lines, msgLines...)

	// Apply scroll offset.
	if m.detail.YOffset > 0 && m.detail.YOffset < len(lines) {
		lines = lines[m.detail.YOffset:]
	}

	// Pad / truncate to height.
	for len(lines) < height {
		lines = append(lines, "")
	}
	if len(lines) > height {
		lines = lines[:height]
	}

	return strings.Join(lines, "\n")
}

// detailContent returns the text to put in the viewport for the current item.
func (m Model) detailContent() string {
	if len(m.queue) == 0 || m.cursor >= len(m.queue) {
		return "(no item selected)"
	}
	item := m.queue[m.cursor]
	innerWidth := m.detailWidth() - 4
	if innerWidth < 10 {
		innerWidth = 10
	}
	wrapped := wordWrap(item.LastMessage, innerWidth)
	return wrapped
}

// helpView renders the keyboard shortcut overlay.
func (m Model) helpView() string {
	help := `
  Trail Boss — Keyboard Shortcuts
  ─────────────────────────────────────────
  j / ↓        Move cursor down
  k / ↑        Move cursor up
  g g          Jump to top
  G            Jump to bottom
  ctrl+d       Page down (half)
  ctrl+u       Page up (half)
  1–9          Jump directly to item N

  Enter / l    Jump to cursor's pane
  Tab          Jump to queue head
  s            Skip queue head
  r            Force refresh

  J            Scroll detail pane down
  K            Scroll detail pane up

  ?            Toggle this help
  q / ctrl+c   Quit
  ─────────────────────────────────────────
  Press ? or q to close
`
	boxStyle := lipgloss.NewStyle().
		BorderStyle(lipgloss.RoundedBorder()).
		BorderForeground(m.theme.BorderColor).
		Padding(1, 2)

	box := boxStyle.Render(strings.TrimLeft(help, "\n"))

	// Center in terminal.
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, box)
}

// syncPreview writes the currently-selected pane_id to the preview target file
// so the trailboss-preview pane below mirrors the right session.
func (m Model) syncPreview() {
	if len(m.queue) > 0 && m.cursor < len(m.queue) {
		WritePreviewTarget(m.queue[m.cursor].PaneID)
	} else {
		WritePreviewTarget("")
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func padRight(s string, n int) string {
	if len(s) >= n {
		return s[:n]
	}
	return s + strings.Repeat(" ", n-len(s))
}

func padToHeight(content string, width, height int) string {
	lines := strings.Split(content, "\n")
	for len(lines) < height {
		lines = append(lines, strings.Repeat(" ", width))
	}
	return strings.Join(lines[:height], "\n")
}

func formatDuration(d time.Duration) string {
	d = d.Round(time.Second)
	if d < 0 {
		d = 0
	}
	total := int(d.Seconds())
	h := total / 3600
	m := (total % 3600) / 60
	s := total % 60
	if h > 0 {
		return fmt.Sprintf("%dh %dm %ds", h, m, s)
	}
	if m > 0 {
		return fmt.Sprintf("%dm %ds", m, s)
	}
	return fmt.Sprintf("%ds", s)
}

// wordWrap wraps text at word boundaries to fit within the given width.
func wordWrap(text string, width int) string {
	if width <= 0 {
		return text
	}
	var result strings.Builder
	for _, paragraph := range strings.Split(text, "\n") {
		words := strings.Fields(paragraph)
		if len(words) == 0 {
			result.WriteString("\n")
			continue
		}
		lineLen := 0
		for i, word := range words {
			wl := len(word)
			if i == 0 {
				result.WriteString(word)
				lineLen = wl
			} else if lineLen+1+wl > width {
				result.WriteString("\n")
				result.WriteString(word)
				lineLen = wl
			} else {
				result.WriteString(" ")
				result.WriteString(word)
				lineLen += 1 + wl
			}
		}
		result.WriteString("\n")
	}
	return strings.TrimRight(result.String(), "\n")
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
