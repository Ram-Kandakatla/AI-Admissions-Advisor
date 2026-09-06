// The chatbot's two modes.
//
// Compass has had one assistant since the beginning: an admissions advisor
// answering questions about deadlines, tests, aid, and building a list. Phase
// 6.3 adds a second — an essay brainstorm partner — over the same provider
// abstraction and the same offline fallback.
//
// The two are separated by more than wording. Each keeps its own thread (see
// migrations/0004_chat_modes.sql), each gets its own system prompt, and each
// has its own bank of offline answers. What they share is every line of
// plumbing: key inspection, provider selection, rate limiting, ownership
// checks, and the error path. That split is the whole design — a second mode
// costs a prompt and a fallback bank, not a second service.
//
// This module exists so the mode's name is defined once. It is imported by the
// store (to scope a query), the LLM service (to pick a prompt), and the routes
// (to reject an unknown one) — three places that would otherwise each carry
// their own string literal and drift apart the first time a third mode lands.

export const CHAT_MODES = ["advising", "essay"] as const;

export type ChatMode = (typeof CHAT_MODES)[number];

/** The mode a request gets when it doesn't ask for one. */
export const DEFAULT_CHAT_MODE: ChatMode = "advising";

export function isChatMode(value: unknown): value is ChatMode {
  return typeof value === "string" && (CHAT_MODES as readonly string[]).includes(value);
}

/**
 * Read a mode off a request.
 *
 * Absent means the default, which is what keeps every pre-6.3 client working
 * unchanged: a POST /chat with no `mode` is an advising turn, exactly as it
 * was. An unknown mode is a different thing entirely and returns null so the
 * caller can answer 400 — silently treating "esay" as advising would file the
 * turn in the wrong thread and give no clue why.
 */
export function parseChatMode(value: unknown): ChatMode | null {
  if (value === undefined || value === null || value === "") return DEFAULT_CHAT_MODE;
  return isChatMode(value) ? value : null;
}
