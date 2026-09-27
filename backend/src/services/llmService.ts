// The chatbot's LLM. Claude if ANTHROPIC_API_KEY is well-formed, else OpenAI,
// else a built-in offline knowledge base so the app works with no credentials.
// A malformed key is logged and treated as absent, rather than surfacing as a
// 401 mid-conversation.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createLogger, errorFields, type Logger } from "../log.js";
import { DEFAULT_CHAT_MODE, type ChatMode } from "../models/chatMode.js";
import type { Env, ChatMessage, StudentRecord } from "../types.js";

const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";
const DEFAULT_OPENAI_MODEL = "gpt-4o";

export type Provider = "claude" | "openai" | "fallback";

// ---- Key validation ----
//
// A shape check only, never a live call: catches truncated pastes and
// placeholders at startup instead of as a 401 on a student's first question.

const KEY_SPECS: Record<string, { prefix: string; reject?: string; minLength: number; provider: string }> = {
  ANTHROPIC_API_KEY: { prefix: "sk-ant-", minLength: 40, provider: "claude" },
  // Anthropic keys also start "sk-"; `reject` catches one in the wrong slot.
  OPENAI_API_KEY: { prefix: "sk-", reject: "sk-ant-", minLength: 40, provider: "openai" },
};

export interface KeyStatus {
  present: boolean;
  valid: boolean;
  problems: string[];
}

export function inspectApiKey(name: string, raw: unknown): KeyStatus {
  const spec = KEY_SPECS[name]!;
  const value = typeof raw === "string" ? raw.trim() : "";

  // No key is a supported offline mode, not a misconfiguration.
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

// Once per isolate: the nearest thing a Worker has to "at boot".
const warnedIsolates = new Set<string>();

function warnOnce(log: Logger, name: string, status: KeyStatus): void {
  if (!status.present || status.valid || warnedIsolates.has(name)) return;
  warnedIsolates.add(name);
  log.warn(`${name} is set but does not look like a valid key — ignoring it`, {
    problems: status.problems,
    hint: "Fix it in backend/.dev.vars (local) or `wrangler secret put` (deployed), or remove it to run offline on purpose.",
  });
}

// ---- The two modes ----
//
// Each mode is a prompt plus an offline answer bank over the same plumbing. The
// essay prompt is mostly restraint: unless told not to, a model will write the
// essay, and it must stay in the student's voice.

const ADVISING_PROMPT = `You are Compass, a warm, plain-spoken college admissions advisor for U.S. high school students.
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

const ESSAY_PROMPT = `You are Compass, helping a U.S. high school student brainstorm and revise their college application essays.
This covers the personal statement (Common App), supplemental essays, and "why us" essays.

Your job is to get the student's own thinking onto the page. You are a question-asker and an editor, not a ghostwriter.

Guidelines:
- NEVER write the essay, a paragraph of it, or an opening line for the student to paste. If asked directly,
  say plainly that the essay has to be in their voice and offer to help them find it instead.
- Lead with questions. "What were you actually thinking in that moment?" gets further than any suggestion.
- Push for the specific. Vague drafts are the universal problem: ask for the concrete detail, the real
  sentence someone said, the thing that surprised them.
- Reflection over narration. Admissions readers want to know what the student made of an experience,
  not a retelling of it. Ask "so what did that change?" relentlessly.
- Ordinary topics beat dramatic ones done badly. Talk them out of writing about trauma they don't want to
  share, and out of assuming their life is too boring to write about.
- When they share a draft, react as a reader first — what landed, what confused you — then be specific
  about what to cut. Most drafts are 30% too long.
- Be encouraging and honest at once. A first draft is supposed to be bad; say so.
- Stay on topic. If asked something about deadlines, tests, or financial aid, answer briefly and point
  them back to the main Compass advisor.`;

const PROMPTS: Record<ChatMode, string> = {
  advising: ADVISING_PROMPT,
  essay: ESSAY_PROMPT,
};

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

/** Built per request; cheap, since the SDK clients open nothing until asked. */
export function createLlmService(env: Env) {
  const log = createLogger(env);
  const keyStatus = {
    ANTHROPIC_API_KEY: inspectApiKey("ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY),
    OPENAI_API_KEY: inspectApiKey("OPENAI_API_KEY", env.OPENAI_API_KEY),
  };

  for (const [name, status] of Object.entries(keyStatus)) warnOnce(log, name, status);

  // Only a key that passed the shape check gets to select a provider — a
  // malformed one degrades to the offline fallback rather than to a runtime 401.
  const provider: Provider = keyStatus.ANTHROPIC_API_KEY.valid
    ? "claude"
    : keyStatus.OPENAI_API_KEY.valid
      ? "openai"
      : "fallback";

  const anthropicModel = env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const openaiModel = env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;

  /** Answer a question in one of the chatbot's modes. */
  async function answerAdmissionsQuestion(
    question: string,
    studentContext: StudentRecord | null = null,
    history: ChatMessage[] = [],
    mode: ChatMode = DEFAULT_CHAT_MODE
  ): Promise<LlmAnswer> {
    if (provider === "fallback") {
      return { answer: fallbackAnswer(question, mode), source: "fallback" };
    }

    const system = PROMPTS[mode] + buildContextLine(studentContext);
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
        : { answer: fallbackAnswer(question, mode), source: "fallback" };
    } catch (err) {
      log.error(`${provider} API error`, errorFields(err));
      return {
        answer:
          "I'm having trouble reaching my knowledge service right now. Here's a general pointer:\n\n" +
          fallbackAnswer(question, mode),
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

// ---- Essay mode's own bank ----
//
// Each answer is a prompt to think, never a draft, matching the live prompt.

const ESSAY_FALLBACKS = [
  {
    keys: ["start", "begin", "blank page", "stuck", "where do i", "how do i start"],
    answer:
      "Don't start by writing — start by collecting. Give yourself 20 minutes and list ten small, specific moments from the last few years: an argument you changed your mind in, something you made badly and then made better, a time you were the only person who noticed something. No filtering. Then pick the one you still have opinions about and freewrite for 15 minutes without stopping. That's your raw material. The opening line is the last thing to write, not the first.",
  },
  {
    keys: ["topic", "what should i write about", "idea", "boring", "nothing interesting"],
    answer:
      "The best topics are usually small. Readers remember the student who wrote about repairing a bike or losing an argument with their grandmother far more than the one who wrote about a service trip. Two tests for a topic: (1) can only you have written it? (2) does it show you thinking, not just doing? If your life feels too ordinary, that's a sign you're looking for events instead of moments — the material is in what you noticed, not in what happened to you.",
  },
  {
    keys: ["show don't tell", "show dont tell", "descriptive", "vague", "generic", "cliché", "cliche"],
    answer:
      "\"I learned resilience\" tells; the two hours you spent redoing it shows. A working rule: every abstract noun in your draft (passion, resilience, leadership, growth) is a place where you summarized instead of showing. Cut the noun, put the scene back. If a sentence could appear in another student's essay with a word swapped, it isn't doing work.",
  },
  {
    keys: ["supplement", "why us", "why this college", "why major"],
    answer:
      "A \"why us\" essay is a research assignment wearing an essay's clothes. Name specifics only that school has — a named course, a lab, a program's actual structure — and connect each to something you've already done, not something you hope to feel. Anything you could paste into another school's box is filler. And never praise the school's ranking, weather, or prestige; they know.",
  },
  {
    keys: ["revise", "edit", "draft", "feedback", "too long", "word count", "cut"],
    answer:
      "Revise in three separate passes, never at once. First: is the essay about the right moment? (This is the pass that sometimes means starting over — do it early.) Second: does every paragraph earn its space? Most drafts run about 30% long, and the fat is usually setup before the real story starts. Third, and last: sentences and words. Read the whole thing aloud — anything you stumble over is a sentence to rewrite, and anything that sounds like someone else is a sentence to cut.",
  },
  {
    keys: ["hard topic", "trauma", "mental health", "difficult", "personal", "too much", "share"],
    answer:
      "You are never obligated to write about the hardest thing that has happened to you, and a difficult topic isn't automatically a strong essay. If you do write about one, the test is whether you can write about it from the other side — reflecting on it rather than still inside it. And ask yourself who you'd be comfortable having read it, because you can't control who does.",
  },
  {
    keys: ["ai", "chatgpt", "write it for me", "write my essay", "generate"],
    answer:
      "I won't write it for you, and it isn't only a rules question. Admissions readers read thousands of these; generated prose reads as flat and interchangeable precisely where an essay needs to sound like a person. What I can do is ask you the questions that get your own thinking out — tell me the moment you're circling, and I'll start there.",
  },
  {
    // "end" alone is unusable as a key — it is inside "recommend", "friend",
    // "attend", and "weekend", all of which appear in real essay questions.
    // These are the phrasings that actually mean the closing paragraph.
    keys: [
      "ending",
      "conclusion",
      "how to end",
      "how do i end",
      "how should i end",
      "last line",
      "final paragraph",
      "wrap up",
    ],
    answer:
      "Don't summarize what you just said, and don't promise what you'll do at their college — both are endings that could be pasted onto anyone's essay. The strongest closings usually return to the concrete thing you opened with and show it looking different now. If you're stuck, try deleting your final paragraph entirely: essays are often already over one paragraph before their author stops.",
  },
];

const BANKS: Record<ChatMode, { keys: string[]; answer: string }[]> = {
  advising: FALLBACKS,
  essay: ESSAY_FALLBACKS,
};

const NO_MATCH: Record<ChatMode, string> = {
  advising:
    "I can help with admissions timelines, essays, tests, building a balanced college list, and financial aid basics. " +
    'Try asking something like "When are early action deadlines?", "How do I start my personal statement?", or ' +
    '"How does the FAFSA work?"',
  essay:
    "I can help you brainstorm and revise your college essays — finding a topic, getting off a blank page, " +
    'making a draft specific, and cutting it down. Try asking "How do I pick a topic?", "How do I start when ' +
    'I\'m stuck?", or "How do I make this less generic?"',
};

const OFFLINE_NOTE =
  "\n\n(Note: I'm running in offline mode right now. Add an ANTHROPIC_API_KEY or " +
  "OPENAI_API_KEY to backend/.dev.vars for full, personalized answers.)";

export function fallbackAnswer(question: string, mode: ChatMode = DEFAULT_CHAT_MODE): string {
  const q = (question || "").toLowerCase();
  const hit = BANKS[mode].find((f) => f.keys.some((k) => q.includes(k)));
  if (hit) return hit.answer;
  return NO_MATCH[mode] + OFFLINE_NOTE;
}
