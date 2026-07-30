import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ChatMessage, LlmProvider, StudentRecord } from "../types";

const MODE_LABEL: Record<LlmProvider, string> = {
  claude: "Claude",
  openai: "OpenAI",
  fallback: "Offline guide",
};

const SUGGESTIONS = [
  "When are Early Action deadlines?",
  "How do I start my personal statement?",
  "How does the FAFSA work?",
  "Should I submit my SAT if it's below average?",
  "How many schools should I apply to?",
  "How do I find scholarships?",
];

export default function ChatBot({
  student,
  onBuildProfile,
}: {
  student: StudentRecord | null;
  onBuildProfile: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<LlmProvider | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.health().then((h) => setMode(h.llm)).catch(() => setMode(null));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    setMessages((m) => [...m, { role: "user", content: question }]);
    setInput("");
    setBusy(true);
    try {
      const res = await api.chat(question, student?.id);
      setMessages((m) => [...m, { role: "assistant", content: res.answer, source: res.source }]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `Sorry — ${(err as Error).message}. Please try again.` },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="view-head">
        <span className="eyebrow">Ask Compass</span>
        <h2 className="section-title">The counselor who&apos;s always in.</h2>
        <p className="lead">
          Ask about deadlines, essays, tests, or financial aid.
          {student
            ? ` Answers are tuned to ${student.name}'s profile.`
            : " Build a profile for answers tuned to you."}
        </p>
      </div>

      {mode === "fallback" && (
        <div className="banner">
          <span>
            Running in <strong>offline mode</strong> — answers come from a built-in guide. Add an
            <code> ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code> to the backend for full,
            personalized answers.
          </span>
        </div>
      )}

      <div className="chat-layout">
        <div className="chat-panel">
          <div className="chat-bar">
            <span className="dot" /> Compass advisor
            {mode && <span className="mode">{MODE_LABEL[mode]}</span>}
          </div>

          <div className="chat-scroll" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="msg assistant">
                Hi{student ? `, ${student.name}` : ""}! I&apos;m Compass. Ask me anything about applying to
                college — deadlines, essays, tests, or paying for it. Not sure where to start? Try one
                of the questions on the {window.innerWidth > 900 ? "right" : "top"}.
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
              placeholder="Ask a question…  (Enter to send, Shift+Enter for a new line)"
              rows={2}
              aria-label="Your question"
            />
            <button className="btn btn-primary chat-send" onClick={() => send(input)} disabled={busy || !input.trim()}>
              Send
            </button>
          </div>
        </div>

        <aside className="suggestions">
          <h4>Try asking</h4>
          {SUGGESTIONS.map((s) => (
            <button key={s} className="suggestion" onClick={() => send(s)} disabled={busy}>
              {s}
            </button>
          ))}
          {!student && (
            <button className="btn btn-ghost" style={{ marginTop: 6 }} onClick={onBuildProfile}>
              Build a profile
            </button>
          )}
        </aside>
      </div>
    </div>
  );
}
