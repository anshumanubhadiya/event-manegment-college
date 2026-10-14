/**
 * gate.ts — AI ke teen modes ka darwaza.
 *
 *   off    → strategy ka signal jaisa hai waisa jaata hai (AI ka koi role nahi)
 *   veto   → signal bana, AI haan/na bole. AI block kare to trade skip.
 *   decide → AI final decision leta hai (buy/sell/hold); strategy sirf context deti hai.
 *
 * Safety: AI fail ho jaye (network/key/parse) to rule-only behaviour pe gir
 * jaate hain (fail-open) aur decide mode me "hold" → trade nahi (fail-closed on
 * real money). Dono decisions journal me log hote hain (audit trail).
 */

import { config } from "../config.ts";
import { evaluate } from "./model.ts";
import type { AiDecision, AiQuestion } from "./prompt.ts";
import { decideQuestion, vetoQuestion } from "./prompt.ts";
import type { MarketState, Signal } from "../strategy/types.ts";

export interface AiOutcome {
  mode: string;
  used: boolean;
  choice: string;
  confidence: number;
  reasoning: string;
  provider: string;
  mock: boolean;
  latencyMs: number;
  blocked: boolean;
}

export interface GateResult {
  signal: Signal;
  ai?: AiOutcome;
}

/**
 * Signal ko AI gate se guzaro.
 * Exit signals kabhi block nahi hote (position band karna always allowed).
 */
export async function applyAiGate(state: MarketState, signal: Signal): Promise<GateResult> {
  if (config.ai.mode === "off" || signal.action === "hold" || signal.action === "exit") {
    return { signal };
  }

  const q: AiQuestion = config.ai.mode === "veto" ? vetoQuestion(state, signal) : decideQuestion(state, signal);
  const res = await evaluate(q);
  const d: AiDecision = res.decision;

  const outcome: AiOutcome = {
    mode: config.ai.mode,
    used: true,
    choice: d.choice,
    confidence: d.confidence,
    reasoning: d.reasoning,
    provider: res.provider,
    mock: res.mock,
    latencyMs: res.latencyMs,
    blocked: false,
  };

  if (config.ai.mode === "veto") {
    const approved = d.choice === "take" && d.confidence >= config.ai.minConfidence;
    if (!approved) {
      outcome.blocked = true;
      return {
        ai: outcome,
        signal: {
          action: "hold",
          reason: `AI ne block kiya (${d.choice} ${d.confidence.toFixed(2)}): ${d.reasoning}`,
          confidence: d.confidence,
          meta: { ai: outcome },
        },
      };
    }
    // risk reduce agar AI kam confident hai — signal wahi rehta hai
    return { ai: outcome, signal: { ...signal, confidence: signal.confidence * (0.6 + 0.4 * d.confidence) } };
  }

  // decide mode
  if (d.choice === "hold") {
    outcome.blocked = true;
    return {
      ai: outcome,
      signal: { action: "hold", reason: `AI ne wait bola (${d.confidence.toFixed(2)}): ${d.reasoning}`, confidence: d.confidence, meta: { ai: outcome } },
    };
  }
  const wantsBuy = d.choice === "buy";
  const directionMatches = (wantsBuy && signal.action === "buy") || (!wantsBuy && signal.action === "sell");
  if (!directionMatches) {
    // AI ka apna direction — stop/target strategy ke plan se len (agar uske paas hai)
    return {
      ai: outcome,
      signal: {
        action: wantsBuy ? "buy" : "sell",
        reason: `AI decide (${d.confidence.toFixed(2)}): ${d.reasoning} [strategy ne ${signal.action} bola tha]`,
        confidence: d.confidence,
        stop: null, // engine ATR se stop banayega
        target: null,
        tag: signal.tag ? `${signal.tag}+ai` : "ai",
        meta: { ai: outcome, strategyAction: signal.action, strategyReason: signal.reason },
      },
    };
  }
  return { ai: outcome, signal: { ...signal, confidence: Math.max(signal.confidence, d.confidence) } };
}
