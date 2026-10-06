import type { Attachment } from "../views/Chat";
import type { AgentStep } from "./types";

/**
 * Chat persistence, so a refresh lands exactly where the user left and past
 * conversations stay in a history they can reopen.
 *
 * Two keys: the ACTIVE conversation (restored on load) and the HISTORY list
 * (archived by "New chat", newest first). Everything lives in localStorage —
 * it is user-facing state, not agent state, and needs no server round-trip.
 */

export interface StoredChat {
  id: string;
  title: string;
  at: number;
  messages: StoredMessage[];
}

export interface StoredMessage {
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: Attachment[];
  steps?: AgentStep[];
  stepCount?: number;
}

export interface PersistedChatState {
  messages: StoredMessage[];
  agentic: boolean;
  approvalMode: "ask" | "auto";
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxTokens: number | "";
  /**
   * Set while a turn was streaming when the page went away.
   *
   * An SSE stream cannot be resumed from a dead process, so a reload cannot
   * continue a run it was in the middle of. Recording that it *was* running is
   * the honest alternative to pretending the answer arrived: on the next load the
   * chat says the turn was interrupted and offers to retry, instead of showing a
   * half-finished reply as if it were complete.
   */
  interrupted?: { runId: string; at: number; note: string } | null;
}

const ACTIVE_KEY = "osama.chat.active.v1";
const HISTORY_KEY = "osama.chat.history.v1";
const HISTORY_MAX = 40;
/** LocalStorage is ~5 MB per origin; keep the stored transcript well under. */
const MAX_STORED_BYTES = 2.5 * 1024 * 1024;

export function newChatId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Drop the heavy parts of attachments before storing: image data URLs can be
 * megabytes each. The chips still render from name/size/kind after a reload;
 * only the inlined body is lost, which is the honest trade for persistence.
 * Returns [stored, stripped] so callers know whether anything was dropped.
 */
function stripAttachments<T extends { attachments?: Attachment[] }>(m: T, budget: { left: number }): [T, boolean] {
  if (!m.attachments?.length) return [m, false];
  let stripped = false;
  const attachments = m.attachments.map((a) => {
    if (a.kind === "image" && a.dataUrl) {
      stripped = true;
      const { dataUrl, ...rest } = a;
      return rest as Attachment;
    }
    if (a.text !== undefined) {
      const cost = a.text.length * 2;
      if (cost > budget.left) {
        stripped = true;
        const { text, ...rest } = a;
        return rest as Attachment;
      }
      budget.left -= cost;
    }
    return a;
  });
  return [{ ...m, attachments } as T, stripped];
}

function trimMessages(messages: StoredMessage[]): StoredMessage[] {
  const budget = { left: MAX_STORED_BYTES };
  const out = messages.map((m) => stripAttachments(m, budget)[0]);
  return out;
}

export function loadActive(): PersistedChatState | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedChatState;
    if (!Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveActive(state: PersistedChatState): void {
  try {
    const trimmed: PersistedChatState = { ...state, messages: trimMessages(state.messages) };
    let text = JSON.stringify(trimmed);
    if (text.length > MAX_STORED_BYTES) {
      // last resort: keep the tail of the conversation
      const tail = state.messages.slice(-12);
      text = JSON.stringify({ ...trimmed, messages: trimMessages(tail) });
      if (text.length > MAX_STORED_BYTES) {
        text = JSON.stringify({ ...trimmed, messages: trimMessages(tail.slice(-4)) });
      }
    }
    localStorage.setItem(ACTIVE_KEY, text);
  } catch {
    /* quota or private mode — persistence is best-effort */
  }
}

export function clearActive(): void {
  try {
    localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

export function loadHistory(): StoredChat[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredChat[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveHistory(chats: StoredChat[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(chats.slice(0, HISTORY_MAX)));
  } catch {
    /* best-effort */
  }
}

/** A readable title from a conversation: its first user message. */
export function chatTitle(messages: Array<{ role: string; content: string }>): string {
  const first = messages.find((m) => m.role === "user" && m.content.trim());
  if (!first) return "Empty conversation";
  const line = first.content.trim().split("\n")[0] ?? "";
  return line.length > 64 ? `${line.slice(0, 64)}…` : line || "Empty conversation";
}
