import { Link } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ChatMessage, ChatMode, LlmProvider, StudentRecord } from "../types";

// Which LLM provider answered; unrelated to the chat `mode`.
const PROVIDER_LABEL: Record<LlmProvider, string> = {
  claude: "Claude",
  openai: "OpenAI",
  fallback: "Offline guide",
};

/** Everything that differs per mode. A new mode also needs backend chatMode.ts. */
const MODES: Record<
  ChatMode,
  {
    switchLabel: string;
    panelLabel: string;
    lead: (student: StudentRecord | null) => string;
    greeting: (student: StudentRecord | null) => string;
    placeholder: string;
    suggestions: string[];
  }
> = {
  advising: {
    switchLabel: "Admissions",
    panelLabel: "Compass advisor",
    lead: (student) =>
      student
        ? `Ask about deadlines, tests, or financial aid. Answers are tuned to ${student.name}'s profile.`
        : "Ask about deadlines, tests, or financial aid. Build a profile for answers tuned to you.",
    greeting: (student) =>
      `Hi${student ? `, ${student.name}` : ""}! Ask me anything about applying to college — deadlines, tests, or paying for it.`,
    placeholder: "Ask a question…  (Enter to send, Shift+Enter for a new line)",
    suggestions: [
      "When are Early Action deadlines?",
      "How does the FAFSA work?",
      "Should I submit my SAT if it's below average?",
      "How many schools should I apply to?",
      "How do I find scholarships?",
      "How do I ask for a recommendation letter?",
    ],
  },
  essay: {
    switchLabel: "Essays",
    panelLabel: "Essay brainstorm",
    lead: () =>
      "Work out what to write about and how to say it. This one asks more than it answers — and it won't write the essay for you.",
    greeting: (student) =>
      `Hi${student ? `, ${student.name}` : ""}! Let's find your essay. Tell me a moment you keep coming back to, or ask me where to start — I'll ask questions rather than hand you paragraphs.`,
    placeholder: "Describe a moment, or paste a draft…  (Enter to send, Shift+Enter for a new line)",
    suggestions: [
      "How do I pick a topic?",
      "I'm staring at a blank page.",
      "How do I make this less generic?",
      "My draft is 300 words too long.",
      "How do I write a 'why us' supplement?",
      "How should I end it?",
    ],
  },
};

const MODE_ORDER: ChatMode[] = ["advising", "essay"];

/** An empty thread per mode, so a switch never lands on `undefined`. */
const emptyThreads = (): Record<ChatMode, ChatMessage[]> => ({ advising: [], essay: [] });

export default function ChatBot({
  student,
  mode = "advising",
  onModeChange,
  initialQuestion = null,
  onQuestionSent,
}: {
  student: StudentRecord | null;
  /** Which assistant is open. Carried in the URL by ChatRoute. */
  mode?: ChatMode;
  onModeChange?: (mode: ChatMode) => void;
  /** A question handed over from another page, sent once on arrival. */
  initialQuestion?: string | null;
  onQuestionSent?: () => void;
}) {
  // One thread per mode rather than one list, because the switch has to be
  // free: flipping to essays and back mid-question should return you to the
  // conversation you left, not to an empty panel.
  const [threads, setThreads] = useState<Record<ChatMode, ChatMessage[]>>(emptyThreads);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<LlmProvider | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const spec = MODES[mode];
  const messages = threads[mode];

  useEffect(() => {
    api.health().then((h) => setProvider(h.llm)).catch(() => setProvider(null));
  }, []);

  const studentId = student?.id ?? null;

  // Clear both threads when the student changes. Not keyed on `mode`: a
  // guest's threads live only here, so a mode switch must not wipe them.
  useEffect(() => {
    setThreads(emptyThreads);
  }, [studentId]);

  // Restore this mode's saved thread; the model sees it as context anyway.
  useEffect(() => {
    if (!studentId) return;
    let live = true;
    api
      .chatHistory(studentId, mode)
      .then((data) => {
        // Only seed an untouched thread. A reply that landed while this was in
        // flight is newer than what the server just described, and so is
        // anything typed since.
        if (live) {
          setThreads((t) => (t[mode].length > 0 ? t : { ...t, [mode]: data.messages }));
        }
      })
      .catch(() => {
        /* an unreachable history is an empty panel, not an error worth showing */
      });
    return () => {
      live = false;
    };
  }, [studentId, mode]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const append = (m: ChatMode, message: ChatMessage) =>
    setThreads((t) => ({ ...t, [m]: [...t[m], message] }));

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    // Captured before the await: switching modes mid-request must not file the
    // answer under whichever thread happens to be open when it lands.
    const asked = mode;
    append(asked, { role: "user", content: question });
    setInput("");
    setBusy(true);
    try {
      const res = await api.chat(question, student?.id, asked);
      append(asked, { role: "assistant", content: res.answer, source: res.source });
    } catch (err) {
      append(asked, {
        role: "assistant",
        content: `Sorry — ${(err as Error).message}. Please try again.`,
      });
    } finally {
      setBusy(false);
    }
  };

  // Send a question handed over from another page exactly once. The ref guard
  // matters because StrictMode re-runs effects on mount in development, and a
  // duplicate here would be a duplicate API call and a duplicate bubble.
  const handedOff = useRef<string | null>(null);
  useEffect(() => {
    if (!initialQuestion || handedOff.current === initialQuestion) return;
    handedOff.current = initialQuestion;
    send(initialQuestion);
    onQuestionSent?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);

  return (
    <div>
      <div className="view-head">
        <span className="eyebrow">Ask Compass</span>
        <h1 className="section-title">
          {mode === "essay" ? "Your essay, in your voice." : "The counselor who's always in."}
        </h1>
        <p className="lead">{spec.lead(student)}</p>

        <div className="segmented chat-modes" role="group" aria-label="Choose an assistant">
          {MODE_ORDER.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => onModeChange?.(m)}
            >
              {MODES[m].switchLabel}
            </button>
          ))}
        </div>
      </div>

      <div className="chat-layout">
        <div className="chat-panel">
          <div className="chat-bar">
            <span className="dot" /> {spec.panelLabel}
            {provider && <span className="mode">{PROVIDER_LABEL[provider]}</span>}
          </div>

          {/* The thread is a live region so a screen reader hears the answer
              arrive. "polite" rather than "assertive": a reply should wait its
              turn behind whatever the user is currently reading. */}
          {/* tabIndex 0 because this scrolls. A keyboard user with no mouse
              cannot reach a scrollable box that isn't focusable, and the
              messages inside it are text, not controls — so there is nothing
              else here to tab to and scroll it with. axe's
              scrollable-region-focusable, which the Phase 5 audit could not
              see: an empty thread does not overflow, so there was nothing to
              scroll on a freshly loaded page. */}
          <div
            className="chat-scroll"
            ref={scrollRef}
            tabIndex={0}
            role="log"
            aria-live="polite"
            aria-label={`${spec.panelLabel} conversation`}
          >
            {messages.length === 0 && (
              <div className="msg assistant">
                {spec.greeting(student)} Not sure where to start? Try one of the questions on the{" "}
                {window.innerWidth > 900 ? "right" : "top"}.
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.content}
              </div>
            ))}
            {busy && (
              <div className="msg assistant thinking">
                Compass is thinking<span className="dots" />
              </div>
            )}
          </div>

          <div className="chat-compose">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder={spec.placeholder}
              rows={2}
              aria-label="Your question"
            />
            <button
              className="btn btn-primary chat-send"
              onClick={() => send(input)}
              disabled={busy || !input.trim()}
            >
              Send
            </button>
          </div>
        </div>

        <aside className="suggestions">
          <h2>Try asking</h2>
          {spec.suggestions.map((s) => (
            <button key={s} className="suggestion" onClick={() => send(s)} disabled={busy}>
              {s}
            </button>
          ))}
          {!student && (
            <Link className="btn btn-ghost" style={{ marginTop: 6 }} to="/profile">
              Build a profile
            </Link>
          )}
        </aside>
      </div>
    </div>
  );
}
