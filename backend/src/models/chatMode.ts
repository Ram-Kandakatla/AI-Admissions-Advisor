// The chatbot's modes, defined once for the store, the LLM service and the
// routes. Each mode has its own thread, prompt and offline answers.

export const CHAT_MODES = ["advising", "essay"] as const;

export type ChatMode = (typeof CHAT_MODES)[number];

export const DEFAULT_CHAT_MODE: ChatMode = "advising";

export function isChatMode(value: unknown): value is ChatMode {
  return typeof value === "string" && (CHAT_MODES as readonly string[]).includes(value);
}

/**
 * Absent means the default. An unknown mode returns null so the caller can
 * answer 400 rather than file the turn in the wrong thread.
 */
export function parseChatMode(value: unknown): ChatMode | null {
  if (value === undefined || value === null || value === "") return DEFAULT_CHAT_MODE;
  return isChatMode(value) ? value : null;
}
