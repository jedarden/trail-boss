// Transcript reconcile loop: the transcript JSONL is ground truth
import * as fs from "fs";
import { execSync } from "child_process";
import { getSession, dequeue, getSessionsForReconcile, upsertSession, enqueue, getSessionsNotInQueue } from "./db.ts";

// Real Claude Code transcript entry shape
interface TranscriptEntry {
  type: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  timestamp?: string | number; // ISO-8601 string or epoch-ms number
  // Non-message types: attachment, queue-operation, last-prompt, etc.
}

// Parse timestamp from ISO string or pass through number
function parseTimestamp(ts: string | number | undefined): number {
  if (ts === undefined) return 0;
  if (typeof ts === "number") return ts;
  const parsed = Date.parse(ts);
  return isNaN(parsed) ? 0 : parsed;
}

// Check if a transcript has advanced past the last stuck point
// Returns true if the session should be dequeued
export function hasTranscriptAdvanced(
  transcriptPath: string,
  lastStuckAt: number
): boolean {
  if (!fs.existsSync(transcriptPath)) {
    return false; // No transcript yet; can't determine
  }

  // Read the last few lines (most recent entries)
  const content = fs.readFileSync(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");

  // Check the last 5 entries for any user message or new assistant turn after last_stuck_at
  const checkCount = Math.min(5, lines.length);
  for (let i = lines.length - checkCount; i < lines.length; i++) {
    try {
      const entry: TranscriptEntry = JSON.parse(lines[i]);
      const entryTime = parseTimestamp(entry.timestamp);

      // Only consider entries strictly newer than the stuck time
      if (entryTime <= lastStuckAt) continue;

      // User message means they answered directly in the pane
      // Real format: type="user" with message.role="user"
      if (entry.type === "user" || entry.message?.role === "user") {
        return true;
      }

      // New assistant turn means the session progressed
      // Real format: type="assistant" with message.role="assistant"
      if (entry.type === "assistant" || entry.message?.role === "assistant") {
        return true;
      }
    } catch {
      continue; // Skip malformed lines
    }
  }

  return false;
}

// Main reconcile sweep: check all sessions and dequeue those that advanced
export function reconcile(): { dequeued: number; checked: number } {
  const sessions = getSessionsForReconcile(100);
  let dequeued = 0;

  for (const sess of sessions) {
    if (!sess.last_stuck_at) continue;

    const advanced = hasTranscriptAdvanced(sess.transcript_path, sess.last_stuck_at);
    if (advanced) {
      dequeue(sess.session_id);
      dequeued++;
    }
  }

  return { dequeued, checked: sessions.length };
}

// Run reconcile periodically
export function startReconcileLoop(intervalMs: number = 5000): void {
  console.log(`[reconcile] started (interval ${intervalMs}ms)`);
  setInterval(() => {
    const result = reconcile();
    if (result.dequeued > 0) {
      console.log(`[reconcile] dequeued ${result.dequeued}/${result.checked} sessions`);
    }
  }, intervalMs);
}

// Check if a pane exists in tmux
function paneExists(paneId: string): boolean {
  try {
    const tmuxSocket = process.env.TMUX_TEST_SOCK || "";
    const tmuxCmd = tmuxSocket ? `tmux -S ${tmuxSocket}` : "tmux";
    const result = execSync(`${tmuxCmd} list-panes -F '#{pane_id}' -t "${paneId}"`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
    return result.toString().trim().includes(paneId);
  } catch {
    return false;
  }
}

// Read the last entry from a transcript to detect stuck state
// Returns { isStuck: boolean, lastAssistantTime: number | null, lastMessage: string | null }
export function detectStuckFromTranscriptTail(
  transcriptPath: string
): { isStuck: boolean; lastAssistantTime: number | null; lastMessage: string | null } {
  if (!fs.existsSync(transcriptPath)) {
    return { isStuck: false, lastAssistantTime: null, lastMessage: null };
  }

  try {
    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");
    if (lines.length === 0) {
      return { isStuck: false, lastAssistantTime: null, lastMessage: null };
    }

    // Check the last 5 entries to find the last assistant turn and see if there's a user message after it
    let lastAssistantTime: number | null = null;
    let lastMessage: string | null = null;
    let foundUserAfterLastAssistant = false;

    // First pass: find the last assistant turn and its message
    const checkCount = Math.min(5, lines.length);
    for (let i = lines.length - checkCount; i < lines.length; i++) {
      try {
        const entry: TranscriptEntry = JSON.parse(lines[i]);
        const entryTime = parseTimestamp(entry.timestamp);

        if (entry.type === "assistant" || entry.message?.role === "assistant") {
          // Found an assistant turn - track it as potentially the stuck point
          lastAssistantTime = entryTime;
          // Try to extract a message from the assistant content
          const content = entry.message?.content;
          if (typeof content === "string") {
            lastMessage = content.length > 100 ? content.slice(0, 97) + "..." : content;
          } else if (content && typeof content === "object" && "text" in content) {
            const text = String((content as { text: string }).text);
            lastMessage = text.length > 100 ? text.slice(0, 97) + "..." : text;
          }
        }
      } catch {
        continue; // Skip malformed lines
      }
    }

    // Second pass: check if there's a user message after the last assistant turn
    if (lastAssistantTime !== null) {
      for (let i = lines.length - checkCount; i < lines.length; i++) {
        try {
          const entry: TranscriptEntry = JSON.parse(lines[i]);
          const entryTime = parseTimestamp(entry.timestamp);

          if ((entry.type === "user" || entry.message?.role === "user") && entryTime > lastAssistantTime) {
            foundUserAfterLastAssistant = true;
            break;
          }
        } catch {
          continue; // Skip malformed lines
        }
      }
    }

    // Session is stuck if the last assistant turn has no following user message
    const isStuck = lastAssistantTime !== null && !foundUserAfterLastAssistant;
    return { isStuck, lastAssistantTime, lastMessage };
  } catch {
    return { isStuck: false, lastAssistantTime: null, lastMessage: null };
  }
}

// Stuck-direction reconcile: find sessions that became stuck while daemon was down
// and enqueue them
export function reconcileStuckDirection(): { enqueued: number; checked: number } {
  const sessions = getSessionsNotInQueue(100);
  let enqueued = 0;

  for (const sess of sessions) {
    // Skip if pane no longer exists
    if (!paneExists(sess.pane_id)) {
      continue;
    }

    // Check if transcript tail shows session is stuck
    const { isStuck, lastAssistantTime } = detectStuckFromTranscriptTail(sess.transcript_path);

    if (isStuck && lastAssistantTime !== null) {
      // Enqueue with reason=stopped and stuck_at derived from assistant timestamp
      enqueue(sess.session_id, "stopped", lastAssistantTime);

      // Update session record with stuck info
      upsertSession(
        sess.session_id,
        sess.pane_id,
        sess.cwd,
        sess.transcript_path,
        lastAssistantTime,
        "stopped",
        null // message already derived from transcript
      );

      enqueued++;
      console.log(`[reconcile] stuck-direction enqueued ${sess.session_id.slice(0, 8)} (reason=stopped)`);
    }
  }

  return { enqueued, checked: sessions.length };
}
