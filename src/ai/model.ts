/**
 * model.ts — LLM call layer (provider-agnostic, zero SDK).
 *
 * Kyun zero SDK? Ek hi `fetch` se OpenAI, Anthropic, Gemini aur koi bhi
 * OpenAI-compatible endpoint (OpenRouter / Groq / Ollama / vLLM) chal jaata hai.
 * Isse dependency kam aur control zyada rehta hai.
 *
 * AI_MODE=off hone pe ye file ka code call hi nahi hota.
 */

import { config } from "../config.ts";
import { fetchJson } from "../util.ts";
import type { AiDecision, AiQuestion } from "./prompt.ts";
import { mockEvaluate } from "./mock.ts";

export interface ModelResult {
  decision: AiDecision;
  provider: string;
  model: string;
  latencyMs: number;
  tokens?: number;
  mock: boolean;
}

const SYSTEM_PROMPT = `You are a disciplined intraday trading analyst for Indian index options (NIFTY/BANKNIFTY/SENSEX).
You are given: (1) a rule-based strategy's signal, (2) market context (candles, indicators, VWAP, ATR, ADX).
Your job: judge whether this trade should be taken RIGHT NOW.

Rules you must follow:
- Be conservative. A missed trade costs nothing; a bad trade costs money.
- Only approve if price action, momentum/trend, and the strategy's own reasoning agree.
- Block trades against a strong opposite trend, in a dead/choppy tape, or when the stop is unrealistic.
- Reply ONLY with compact JSON matching the schema. No prose outside JSON.`;

function userPrompt(q: AiQuestion): string {
  return [
    `QUESTION: ${q.instructions.question}`,
    `GOAL: ${q.instructions.goal}`,
    `TIMING: ${q.instructions.timing}`,
    `INPUTS:\n${q.instructions.inputs}`,
    `CHOICES: ${q.choices.join(" | ")}`,
    "CRITERIA:",
    ...Object.entries(q.criteria).map(([k, v]) => `  - ${k}: ${v}`),
    "",
    `Respond with JSON only, exactly this shape: ${q.responseShape}`,
  ].join("\n");
}

/** Main entry — provider ke hisaab se call. */
export async function evaluate(q: AiQuestion): Promise<ModelResult> {
  const started = Date.now();
  const provider = config.ai.provider;

  if (!config.ai.apiKey) {
    return {
      decision: mockEvaluate(q),
      provider: "mock",
      model: "mock",
      latencyMs: Date.now() - started,
      mock: true,
    };
  }

  try {
    const raw = await callProvider(provider, q);
    const decision = parseDecision(raw, q);
    return {
      decision,
      provider,
      model: config.ai.model,
      latencyMs: Date.now() - started,
      mock: false,
    };
  } catch (e) {
    console.warn(`[ai] ${provider} call fail: ${(e as Error).message} — mock heuristic se kaam chalaya`);
    return { decision: mockEvaluate(q), provider: "mock(fallback)", model: "mock", latencyMs: Date.now() - started, mock: true };
  }
}

async function callProvider(provider: string, q: AiQuestion): Promise<string> {
  const prompt = userPrompt(q);

  if (provider === "anthropic") {
    const res = await fetchJson<{ content: Array<{ text?: string }> }>("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": config.ai.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.ai.model,
        max_tokens: config.ai.maxTokens,
        temperature: config.ai.temperature,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      }),
    }, 20_000);
    return res.content?.map((c) => c.text ?? "").join("") ?? "";
  }

  if (provider === "google") {
    const model = config.ai.model || "gemini-2.0-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.ai.apiKey}`;
    const res = await fetchJson<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: config.ai.temperature, maxOutputTokens: config.ai.maxTokens, responseMimeType: "application/json" },
      }),
    }, 20_000);
    return res.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  }

  // openai / openai-compatible (Groq, OpenRouter, Ollama, vLLM...)
  const base = config.ai.baseUrl || "https://api.openai.com/v1";
  const res = await fetchJson<{ choices?: Array<{ message?: { content?: string } }> }>(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.ai.apiKey}` },
    body: JSON.stringify({
      model: config.ai.model,
      temperature: config.ai.temperature,
      max_tokens: config.ai.maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  }, 20_000);
  return res.choices?.[0]?.message?.content ?? "";
}

/** LLM output → strict decision. Kachra aaya to fallback (reject). */
export function parseDecision(raw: string, q: AiQuestion): AiDecision {
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    const text = raw.slice(jsonStart, jsonEnd + 1);
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const choice = String(obj["choice"] ?? obj["decision"] ?? "").toLowerCase();
      const reason = String(obj["reasoning"] ?? obj["reason"] ?? "").slice(0, 400);
      const confidence = Number(obj["confidence"] ?? 0.5);
      if (q.choices.includes(choice)) {
        return {
          choice,
          confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.5,
          reasoning: reason || "(no reasoning diya)",
        };
      }
    } catch {
      /* fall through */
    }
  }
  // Parse fail = safe side: sabse pehla (blocking) choice
  return { choice: q.choices[0]!, confidence: 0.0, reasoning: `AI response parse nahi hua: ${raw.slice(0, 120)}` };
}
