# Away-from-Tmux Notifications

Trail Boss can send Telegram notifications when the queue depth crosses a threshold while you're away from tmux (e.g., commuting, sleeping). This provides push-based alerts for stuck sessions, complementing the existing pull-based status line and TUI.

## Architecture

The notification system runs as a background checker in the daemon:

- **Daemon (`daemon/notify.ts`)**: Polls queue depth every 30 seconds (configurable). Sends alerts via telegram-claude-bridge proxy when threshold is crossed.
- **Rate limiting**: Cooldown period (default 1 hour) prevents spam for the same stuck session.
- **Deduplication**: Tracks last notified session ID to avoid duplicate alerts for the same head item.

## Configuration

Set these environment variables in `~/.config/systemd/user/trailboss-daemon.service`:

```bash
# Telegram integration
TELEGRAM_PROXY_URL="http://localhost:8080"              # telegram-claude-bridge proxy URL
TELEGRAM_CHAT_ID="-1001234567890"                      # Your Telegram chat ID (required)
TELEGRAM_THREAD_ID="5"                                  # Optional: thread ID for forum topics

# Notification behavior
NOTIFY_THRESHOLD="1"                                   # Send alert when queue depth >= N (default: 1)
NOTIFY_COOLDOWN_MS="3600000"                            # Cooldown between alerts (default: 1 hour)
NOTIFY_CHECK_INTERVAL_MS="30000"                       # Polling interval (default: 30 seconds)
```

## Finding Your Telegram Chat ID

1. Send a message to the group where you want notifications
2. Visit `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates` in your browser
3. Find your message in the response and copy the `chat.id` value (negative for groups)

## How It Works

1. **Queue depth check**: Every 30 seconds, the daemon checks `getStuckCount()`
2. **Threshold check**: If count >= `NOTIFY_THRESHOLD`, proceed to rate-limit check
3. **Cooldown check**: If enough time has passed since last notification (default 1 hour), proceed
4. **Deduplication check**: If head session ID differs from last notified item, send alert
5. **Alert sent**: POST to telegram-claude-bridge proxy `/send` endpoint with formatted message

## Message Format

```
🔔 **Trail Boss Alert**

Queue depth: **3** stuck sessions

⏸️ **Head:** a1b2c3d4 (stopped)

Oldest stuck session needs attention.

Attach to tmux to process the queue.
```

## Telegram Bridge Setup

The notification system requires telegram-claude-bridge proxy to be running. The proxy is typically started as part of the bridge systemd service:

```bash
systemctl --user status telegram-claude-bridge
```

If the proxy is not running, notifications will fail gracefully (logged to stderr).

## Testing

```bash
# Manually trigger a notification check
curl -s http://localhost:4000/status | jq '.stuckCount'

# Check notification logs
journalctl --user -u trailboss-daemon -f | grep notify
```

## Design Decisions

- **Polling vs. event-driven**: Polling was chosen for simplicity and to avoid coupling notification logic to every enqueue/dequeue operation.
- **Cooldown per head item**: The cooldown prevents spam but resets when a new session reaches the head of the queue.
- **Telegram-only**: Initial implementation focuses on Telegram since telegram-claude-bridge is already running. Future extensions could add Slack, email, etc.
