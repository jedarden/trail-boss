// Notification system for Trail Boss
// Sends alerts when queue depth crosses threshold while operator is away from tmux
import { getStuckCount, getHead } from "./db.ts";

// Configuration from environment
const PROXY_URL = process.env.TELEGRAM_PROXY_URL || "http://localhost:8080";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_THREAD_ID = process.env.TELEGRAM_THREAD_ID;
const NOTIFY_THRESHOLD = parseInt(process.env.NOTIFY_THRESHOLD || "1", 10);
const NOTIFY_COOLDOWN_MS = parseInt(process.env.NOTIFY_COOLDOWN_MS || "3600000", 10); // 1 hour default
const CHECK_INTERVAL_MS = parseInt(process.env.NOTIFY_CHECK_INTERVAL_MS || "30000", 10); // 30 seconds

// Track last notification state to avoid duplicates
interface NotificationState {
  lastNotifiedSessionId: string | null;
  lastNotifiedAt: number | null;
  lastNotifiedCount: number;
}

let notifyState: NotificationState = {
  lastNotifiedSessionId: null,
  lastNotifiedAt: null,
  lastNotifiedCount: 0,
};

/**
 * Send a notification via telegram-claude-bridge proxy
 */
async function sendTelegramNotification(message: string): Promise<boolean> {
  if (!TELEGRAM_CHAT_ID) {
    console.warn("[notify] TELEGRAM_CHAT_ID not set, notification disabled");
    return false;
  }

  try {
    const requestBody: Record<string, unknown> = {
      chat_id: parseInt(TELEGRAM_CHAT_ID, 10),
      text: message,
      parse_mode: "Markdown",
    };

    if (TELEGRAM_THREAD_ID) {
      requestBody.thread_id = parseInt(TELEGRAM_THREAD_ID, 10);
    }

    const response = await fetch(`${PROXY_URL}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[notify] telegram proxy returned ${response.status}: ${errorText}`);
      return false;
    }

    const result = await response.json();
    console.log(`[notify] notification sent: message_id=${result.message_id}`);
    return true;
  } catch (err) {
    console.error("[notify] failed to send notification:", err);
    return false;
  }
}

/**
 * Check if notification should be sent (rate limiting + deduplication)
 */
function shouldNotify(currentCount: number, headSessionId: string): boolean {
  const now = Date.now();

  // Check threshold
  if (currentCount < NOTIFY_THRESHOLD) {
    return false;
  }

  // Check cooldown period
  if (notifyState.lastNotifiedAt && (now - notifyState.lastNotifiedAt) < NOTIFY_COOLDOWN_MS) {
    console.log(`[notify] in cooldown period (${Math.round((now - notifyState.lastNotifiedAt) / 1000)}s ago)`);
    return false;
  }

  // Check if this is a new head item (deduplication)
  if (notifyState.lastNotifiedSessionId === headSessionId && notifyState.lastNotifiedCount === currentCount) {
    console.log("[notify] already notified for this head item and count");
    return false;
  }

  return true;
}

/**
 * Build notification message with current queue state
 */
function buildNotificationMessage(count: number, head: { session_id: string; reason: string } | null): string {
  const lines = [
    "🔔 **Trail Boss Alert**",
    "",
    `Queue depth: **${count}** stuck session${count === 1 ? "" : "s"}`,
    "",
  ];

  if (head) {
    const headSessionShort = head.session_id.slice(0, 8);
    const reasonEmoji = head.reason === "permission" ? "🔐" : "⏸️";
    lines.push(`${reasonEmoji} **Head:** ${headSessionShort} (${head.reason})`);
    lines.push("");
    lines.push("Oldest stuck session needs attention.");
  }

  lines.push("");
  lines.push("Attach to tmux to process the queue.");

  return lines.join("\n");
}

/**
 * Main notification check loop
 */
export async function checkAndNotify(): Promise<void> {
  try {
    const stuckCount = getStuckCount();
    const head = getHead();

    console.log(`[notify] check: stuck=${stuckCount}, threshold=${NOTIFY_THRESHOLD}`);

    if (head && shouldNotify(stuckCount, head.session_id)) {
      const message = buildNotificationMessage(stuckCount, head);
      const sent = await sendTelegramNotification(message);

      if (sent) {
        notifyState = {
          lastNotifiedSessionId: head.session_id,
          lastNotifiedAt: Date.now(),
          lastNotifiedCount: stuckCount,
        };
        console.log(`[notify] alert sent for session ${head.session_id.slice(0, 8)}`);
      }
    }
  } catch (err) {
    console.error("[notify] check failed:", err);
  }
}

/**
 * Start the notification checker loop
 */
export function startNotificationChecker(): void {
  if (!TELEGRAM_CHAT_ID) {
    console.log("[notify] TELEGRAM_CHAT_ID not set, notification disabled");
    return;
  }

  console.log(`[notify] starting checker: threshold=${NOTIFY_THRESHOLD}, interval=${CHECK_INTERVAL_MS}ms`);

  // Run immediately on start
  setTimeout(() => {
    checkAndNotify();
  }, 5000); // Short delay to let daemon initialize

  // Then run on interval
  setInterval(() => {
    checkAndNotify();
  }, CHECK_INTERVAL_MS);
}
