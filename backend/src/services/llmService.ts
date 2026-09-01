// LLM service for the admissions chatbot.
//
// Supports either provider, chosen by whichever key is present AND well-formed:
//   ANTHROPIC_API_KEY -> Claude   (preferred when both are set)
//   OPENAI_API_KEY    -> OpenAI
// With no key at all, it falls back to a small built-in knowledge base so the
// whole app stays usable in local development without any credentials. A key
// that is present but malformed is reported and then treated as absent, which
// lands in that same fallback instead of a 401 mid-conversation.
//
// WHAT THE WORKERS PORT CHANGED
//
// Both SDKs are fetch-based and run in a Worker unmodified, so the two API
// calls at the bottom are untouched. What could not survive is the *shape* of
// this module: it used to read process.env at import time and freeze
// `provider` and the two clients into module constants. A Worker has no
// process.env and gets its bindings per request, so all of that moved into
// `createLlmService(env)`. `inspectApiKey` stays a free function — it is pure,
// and the tests call it directly.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Env, ChatMessage, StudentRecord } from "../types.js";

const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";
const DEFAULT_OPENAI_MODEL = "gpt-4o";

export type Provider = "claude" | "openai" | "fallback";

// ---- Key validation ----
//
// A key that is present but wrong — a paste that dropped the last characters,
// the placeholder from .env.example left in place — is worse than no key at
// all: the app looks healthy and then throws a 401 at the first student who
// asks a question. Checking the shape moves that discovery to a log line.
//
// This is deliberately a shape check, not a live API call. Serving a request
// must not depend on a round trip to the provider, and only the provider can
// say whether a well-formed key is actually valid.

const KEY_SPECS: Record<string, { prefix: string; reject?: string; minLength: number; provider: string }> = {
  ANTHROPIC_API_KEY: { prefix: "sk-ant-", minLength: 40, provider: "claude" },
  // Anthropic keys also begin "sk-", so the prefix alone would wave one through
  // if it were pasted into the wrong line. `reject` catches that swap.
  OPENAI_API_KEY: { prefix: "sk-", reject: "sk-ant-", minLength: 40, provider: "openai" },
};

export interface KeyStatus {
  present: boolean;
  valid: boolean;
  problems: string[];
}

/** Inspect one API key. */
export function inspectApiKey(name: string, raw: unknown): KeyStatus {
  const spec = KEY_SPECS[name]!;
  const value = typeof raw === "string" ? raw.trim() : "";

  // Absent and blank are the same thing: run offline, say nothing. This is a
  // supported way to use Compass, not a misconfiguration.
  if (value === "") return { present: false, valid: false, problems: [] };

  const problems: string[] = [];
  if (!value.startsWith(spec.prefix)) {
    problems.push(`should start with "${spec.prefix}"`);
  } else if (spec.reject && value.startsWith(spec.reject)) {
    problems.push(`starts with "${spec.reject}" — that is an Anthropic key, in the OpenAI slot`);
  }
  if (value.length < spec.minLength) {
    problems.push(`is only ${value.length} characters — it looks truncated`);
  }
  if (/\s/.test(value)) {
    problems.push("contains a space or line break — check for a broken paste");
  }

  return { present: true, valid: problems.length === 0, problems };
}

// A Worker isolate is reused across requests, so this is the closest thing to
// "at boot" available: the warning prints on the first request an isolate
// serves and then stays quiet, instead of once per request forever.
const warnedIsolates = new Set<string>();

function warnOnce(name: string, status: KeyStatus): void {
  if (!status.present || status.valid || warnedIsolates.has(name)) return;
  warnedIsolates.add(name);
  console.warn(
    JSON.stringify({
      level: "warn",
      message: `${name} is set but does not look like a valid key — ignoring it`,
      problems: status.problems,
      hint: "Fix it in backend/.dev.vars (local) or `wrangler secret put` (deployed), or remove it to run offline on purpose.",
    })
  );
}

const SYSTEM_PROMPT = `You are Compass, a warm, plain-spoken college admissions advisor for U.S. high school students.
Help with the application process: timelines and deadlines, essays, standardized tests, recommendation letters,
financial aid (FAFSA/CSS Profile, grants, loans, work-study), scholarships, and how to build a balanced college list.

Guidelines:
- Be concise, specific, and encouraging. Prefer short paragraphs and tight bullet lists.
- Give actionable next steps, not vague reassurance.
- Be honest about uncertainty. Admissions policies and deadlines change — tell students to confirm specifics
  on the official college or federal (studentaid.gov) websites.
- Never invent a student's odds at a specific school as a guarantee. Frame chances as reach/target/safety.
- You are not a licensed financial advisor; for personal finance decisions, suggest talking to a school
  counselor or the college's financial aid office.
- Stay on topic. If asked something unrelated to college/admissions/financial aid, gently redirect.`;

function buildContextLine(studentContext: StudentRecord | null): string {
  if (!studentContext) return "";
  const bits: string[] = [];
  if (studentContext.name) bits.push(`Name: ${studentContext.name}`);
  if (studentContext.gpa != null) bits.push(`GPA: ${studentContext.gpa}`);
  if (studentContext.satScore) bits.push(`SAT: ${studentContext.satScore}`);
  if (studentContext.actScore) bits.push(`ACT: ${studentContext.actScore}`);
  if (studentContext.interestedMajors?.length)
    bits.push(`Intended majors: ${studentContext.interestedMajors.join(", ")}`);
  if (studentContext.careerGoals) bits.push(`Career goal: ${studentContext.careerGoals}`);
  if (studentContext.financialNeed) bits.push(`Financial need: ${studentContext.financialNeed}`);
  if (bits.length === 0) return "";
  return `\n\nHere is context about the student you are helping (use it to personalize, don't recite it back):\n${bits.join(
    "\n"
  )}`;
}

export interface LlmAnswer {
  answer: string;
  source: Provider;
}

export type LlmService = ReturnType<typeof createLlmService>;

/**
 * Build the chatbot service for one request's environment.
 *
 * Cheap to call — the constructors below only stash a key; no connection is
 * opened until a question is actually asked.
 */
export function createLlmService(env: Env) {
  const keyStatus = {
    ANTHROPIC_API_KEY: inspectApiKey("ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY),
    OPENAI_API_KEY: inspectApiKey("OPENAI_API_KEY", env.OPENAI_API_KEY),
  };

  for (const [name, status] of Object.entries(keyStatus)) warnOnce(name, status);

  // Only a key that passed the shape check gets to select a provider — a
  // malformed one degrades to the offline fallback rather than to a runtime 401.
  const provider: Provider = keyStatus.ANTHROPIC_API_KEY.valid
    ? "claude"
    : keyStatus.OPENAI_API_KEY.valid
      ? "openai"
      : "fallback";

  const anthropicModel = env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const openaiModel = env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;

  /** Answer an admissions question. */
  async function answerAdmissionsQuestion(
    question: string,
    studentContext: StudentRecord | null = null,
    history: ChatMessage[] = []
  ): Promise<LlmAnswer> {
    if (provider === "fallback") {
      return { answer: fallbackAnswer(question), source: "fallback" };
    }

    const system = SYSTEM_PROMPT + buildContextLine(studentContext);
    const messages = [
      ...history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-10)
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user" as const, content: question },
    ];

    try {
      const answer =
        provider === "claude"
          ? await askClaude(system, messages)
          : await askOpenAI(system, messages);
      return answer
        ? { answer, source: provider }
        : { answer: fallbackAnswer(question), source: "fallback" };
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          message: `${provider} API error`,
          detail: err instanceof Error ? err.message : String(err),
        })
      );
      return {
        answer:
          "I'm having trouble reaching my knowledge service right now. Here's a general pointer:\n\n" +
          fallbackAnswer(question),
        source: "fallback",
      };
    }
  }

  // Claude takes the system prompt as its own top-level parameter.
  async function askClaude(
    system: string,
    messages: { role: "user" | "assistant"; content: string }[]
  ): Promise<string> {
    const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY!.trim() });
    const response = await anthropic.messages.create({
      model: anthropicModel,
      max_tokens: 700,
      temperature: 0.7,
      system,
      messages,
    });
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
  }

  // OpenAI takes the system prompt as the first message in the list.
  async function askOpenAI(
    system: string,
    messages: { role: "user" | "assistant"; content: string }[]
  ): Promise<string> {
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY!.trim() });
    const response = await openai.chat.completions.create({
      model: openaiModel,
      max_tokens: 700,
      temperature: 0.7,
      messages: [{ role: "system", content: system }, ...messages],
    });
    return (response.choices[0]?.message?.content || "").trim();
  }

  return { provider, answerAdmissionsQuestion };
}

// ---- Offline fallback knowledge base ----
// Keyword-matched canned answers so the chatbot is useful without an API key.

const FALLBACKS = [
  {
    keys: ["fafsa", "financial aid", "aid", "money", "afford", "net price"],
    answer:
      "Financial aid starts with the FAFSA at studentaid.gov (it opens in the fall for the next school year — file as early as you can). Some private colleges also require the CSS Profile. Aid comes as grants and scholarships (free money), work-study, and loans. Use each college's Net Price Calculator to estimate what you'd actually pay after aid — the sticker tuition is rarely the real cost.",
  },
  {
    keys: ["scholarship", "grant", "merit"],
    answer:
      "Look for scholarships in three buckets: (1) college merit awards — often automatic with your application, (2) local/community scholarships — smaller but far less competitive, ask your school counselor, and (3) national databases like Fastweb, Going Merry, and Scholarships.com. Apply to many small ones; they add up. Watch deadlines closely.",
  },
  {
    keys: ["essay", "personal statement", "write", "common app"],
    answer:
      "A strong personal statement is specific and reflective, not a résumé in prose. Pick one focused moment or theme, show what you did and how you changed, and let your real voice come through. Aim for a strong first draft early (summer before senior year), then revise 3–4 times. Have one adult read it for honesty, not to rewrite it.",
  },
  {
    keys: ["deadline", "timeline", "when", "early decision", "early action", "regular"],
    answer:
      "Rough senior-year timeline:\n• Aug–Sep: finalize your college list, start essays.\n• Nov 1: most Early Decision/Early Action deadlines.\n• Jan 1–15: most Regular Decision deadlines.\n• Oct onward: file the FAFSA.\n• Mar–Apr: decisions arrive.\n• May 1: national deposit deadline to commit.\nEarly Decision is binding; Early Action is not. Always confirm exact dates on each college's site.",
  },
  {
    keys: ["sat", "act", "test", "score", "test optional"],
    answer:
      "Many colleges are test-optional, but a strong SAT/ACT can still help — submit scores that are at or above a school's middle-50% range, and consider withholding ones well below it. Prep with official free tools (Khan Academy for SAT, ACADEMY/official ACT materials), take a couple of timed practice tests, and register early so you have a retake window.",
  },
  {
    keys: ["recommendation", "letter", "teacher rec"],
    answer:
      "Ask teachers who know you well (usually junior-year core subjects), ideally in person, at least a month before deadlines. Give each recommender a short brag sheet: your goals, a couple of specific moments from their class, and the deadlines. A thoughtful letter from a teacher who likes you beats one from the most famous teacher who barely knows you.",
  },
  {
    keys: ["reach", "target", "safety", "college list", "how many", "balanced"],
    answer:
      "Build a balanced list of ~8–12 schools: a few reaches (admit odds below your profile), several targets (right in your range), and 2–3 safeties (very likely admits you'd be happy to attend and can afford). Make sure every school on the list — including safeties — is one you'd genuinely enroll at.",
  },
  {
    keys: ["major", "undecided", "what should i study"],
    answer:
      "It's fine to apply undecided — many students change majors. Choose based on subjects you enjoy and are good at, and look at what a major actually involves day to day (required courses, careers it leads to). If you're between fields, pick a college strong in several of them so you keep options open.",
  },
];

export function fallbackAnswer(question: string): string {
  const q = (question || "").toLowerCase();
  const hit = FALLBACKS.find((f) => f.keys.some((k) => q.includes(k)));
  if (hit) return hit.answer;
  return (
    "I can help with admissions timelines, essays, tests, building a balanced college list, and financial aid basics. " +
    "Try asking something like \"When are early action deadlines?\", \"How do I start my personal statement?\", or " +
    "\"How does the FAFSA work?\"\n\n(Note: I'm running in offline mode right now. Add an ANTHROPIC_API_KEY or " +
    "OPENAI_API_KEY to backend/.dev.vars for full, personalized answers.)"
  );
}
