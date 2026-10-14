/**
 * mock.ts — API key na hone pe chalne wala heuristic "model".
 *
 * Jev-trader me bhi MockModel hota hai (momentum + imbalance + noise) — hum bhi
 * wahi karte hain par Indian index context pe: trend + VWAP position + ADX +
 * 5m momentum. Ye ASLI AI nahi hai — bas deterministic fallback hai taaki
 * AI_MODE on hone pe bhi system chale. Isliye har decision me mock: true aata hai.
 */

import { clamp } from "../util.ts";
import type { AiDecision, AiQuestion } from "./prompt.ts";

export function mockEvaluate(q: AiQuestion): AiDecision {
  const inputs = q.instructions.inputs;
  const get = (re: RegExp): number | null => {
    const m = re.exec(inputs);
    return m ? Number(m[1]) : null;
  };

  const ltp = get(/ltp:\s*([\d.]+)/);
  const vwap = get(/vwap:\s*([\d.]+)/);
  const adx = get(/adx:\s*([\d.]+)/);
  const atr = get(/atr:\s*([\d.]+)/);
  const returnsLine = /5m returns %:\s*([-\d.,\s]+)/.exec(inputs)?.[1] ?? "";
  const rets = returnsLine
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x));
  const momentum = rets.length ? rets.slice(-3).reduce((a, b) => a + b, 0) : 0;
  const stratAction = /"action":"(buy|sell|hold|exit)"/.exec(inputs)?.[1] ?? "hold";

  const aboveVwap = ltp !== null && vwap !== null ? ltp > vwap : null;
  const trendStrength = adx === null ? 0 : clamp((adx - 15) / 25, 0, 1); // ADX 15→0, 40→1
  const momScore = clamp(momentum / 0.15, -1, 1); // ±0.15% 5m move = full score
  const atrPct = ltp && atr ? (atr / ltp) * 100 : 0;
  // ATR na mile (session ke shuru me) to "dead tape" maan ke sab block karna galat hai —
  // tab decide momentum/VWAP se karo, ATR sirf confirmation ke liye.
  const alive = atrPct === 0 ? true : atrPct > 0.02;

  // blended directional score
  let score = 0.45 * momScore + (aboveVwap === null ? 0 : aboveVwap ? 0.25 : -0.25) + 0.15 * trendStrength * Math.sign(momScore || 1);

  const choiceSet = q.choices;
  if (choiceSet.includes("take") && choiceSet.includes("skip")) {
    // veto mode — signal + context agree?
    const stratDir = stratAction === "buy" ? 1 : stratAction === "sell" ? -1 : 0;
    const agree = stratDir !== 0 && Math.sign(score) === stratDir;
    const strength = Math.abs(score);
    const confidence = clamp(0.35 + strength * 0.6 + (alive ? 0.05 : -0.15), 0, 0.95);
    const take = agree && strength > 0.18 && alive;
    return {
      choice: take ? "take" : "skip",
      confidence: Number(confidence.toFixed(2)),
      reasoning: `mock: mom ${momentum.toFixed(2)}% · ADX ${adx?.toFixed(0) ?? "n/a"} · ${aboveVwap === true ? "VWAP above" : aboveVwap === false ? "VWAP below" : "no vwap"} · strategy ${stratAction} ${agree ? "agrees" : "disagrees"}`,
    };
  }

  if (choiceSet.includes("approve")) {
    const premium = Number(/planned_premium:\s*([\d.]+)/.exec(inputs)?.[1] ?? 0);
    const ok = premium >= 40 && alive;
    return {
      choice: ok ? "approve" : "reject",
      confidence: ok ? 0.7 : 0.6,
      reasoning: ok ? "mock: premium aur volatility theek hai" : `mock: premium ₹${premium} ya tape dead — reject`,
    };
  }

  // decide mode
  const closeTight = /minutesToClose:\s*(\d+)/.exec(inputs)?.[1];
  if (closeTight !== undefined && Number(closeTight) < 30) {
    return { choice: "hold", confidence: 0.7, reasoning: "mock: close ke paas naya entry nahi" };
  }
  if (!alive || Math.abs(score) < 0.2) {
    return { choice: "hold", confidence: clamp(0.5 + (0.2 - Math.abs(score)), 0.5, 0.9), reasoning: `mock: mixed/flat tape (score ${score.toFixed(2)})` };
  }
  return {
    choice: score > 0 ? "buy" : "sell",
    confidence: Number(clamp(0.45 + Math.abs(score) * 0.5, 0, 0.9).toFixed(2)),
    reasoning: `mock heuristic: momentum ${momentum.toFixed(2)}%, trend ${trendStrength.toFixed(2)}, ${aboveVwap ? "above" : "below"} VWAP`,
  };
}
