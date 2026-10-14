/**
 * prompt.ts — AI ke liye "typed question" banao (jev-trader style).
 *
 * Jev me QUESTIONS ek typed choice question hote hain: instructions
 * (question / goal / timing / inputs) + per-choice criteria. Hum wahi pattern
 * use karte hain — model ko sirf ek clean decision dena hai, prose nahi.
 */

import type { MarketState, Signal } from "../strategy/types.ts";

export interface AiQuestion {
  instructions: {
    question: string;
    goal: string;
    timing: string;
    inputs: string;
  };
  choices: string[];
  criteria: Record<string, string>;
  responseShape: string;
}

export interface AiDecision {
  choice: string;
  confidence: number;
  reasoning: string;
}

function fmt(n: number | null | undefined, dp = 1): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "n/a" : n.toFixed(dp);
}

/** Market state ko compact text me — model ko sirf relevant cheezein dikhani hain. */
export function stateDigest(s: MarketState, signal: Signal, extra: Record<string, unknown> = {}): string {
  const lines: string[] = [];
  lines.push(`index: ${s.symbol}  ltp: ${fmt(s.ltp)}  time: ${new Date(s.ts).toISOString().slice(11, 16)}Z`);
  lines.push(`dayOpen: ${fmt(s.dayOpen)}  dayHigh: ${fmt(s.dayHigh)}  dayLow: ${fmt(s.dayLow)}  prevClose: ${fmt(s.prevClose)}`);
  lines.push(`vwap: ${fmt(s.vwap)}  atr: ${fmt(s.atr)}  adx: ${fmt(s.adx)}  minutesToClose: ${s.minutesToClose}`);
  const b5 = s.bars["5m"] ?? [];
  const lastBars = b5.slice(-6);
  if (lastBars.length) {
    lines.push("last 5m bars (O/H/L/C/vol):");
    for (const b of lastBars) {
      lines.push(`  ${fmt(b.open)}/${fmt(b.high)}/${fmt(b.low)}/${fmt(b.close)}/${Math.round(b.volume)}`);
    }
    const rets: number[] = [];
    for (let i = 1; i < lastBars.length; i++) {
      const prev = lastBars[i - 1]!.close;
      rets.push(((lastBars[i]!.close - prev) / prev) * 100);
    }
    lines.push(`5m returns %: ${rets.map((r) => r.toFixed(2)).join(", ")}`);
  }
  lines.push(`position: ${s.position ? `${s.position.side} ${s.position.qty} @ ${fmt(s.position.entry)}` : "none"}`);
  lines.push(`dayPnl: ${fmt(s.dayPnl, 0)}  tradesToday: ${s.tradesToday}  consecutiveLosses: ${s.consecutiveLosses}`);
  for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${JSON.stringify(v)}`);
  return lines.join("\n");
}

/** Veto mode — "ye signal lena chahiye ya nahi?" */
export function vetoQuestion(s: MarketState, signal: Signal): AiQuestion {
  return {
    instructions: {
      question: `Rule-based strategy ne "${signal.action.toUpperCase()}" signal diya. Kya ye trade abhi lena chahiye?`,
      goal: "Sirf wahi trades approve karo jahan price action aur context strategy ke saath agree karein. Shak ho to block karo.",
      timing: `Entry abhi, ${s.minutesToClose} min market close tak.`,
      inputs: stateDigest(s, signal, {
        strategy_signal: { action: signal.action, reason: signal.reason, confidence: signal.confidence },
        planned_stop: signal.stop,
        planned_target: signal.target,
      }),
    },
    choices: ["take", "skip"],
    criteria: {
      take: "Strategy direction momentum/trend/VWAP ke saath hai, structure clear hai, stop realistic hai, koi event-risk nahi.",
      skip: "Direction strong opposite trend/ADX ke khilaf hai, tape choppy/dead hai, stop bada/bekar hai, ya confidence kam hai.",
    },
    responseShape: `{"choice":"take"|"skip","confidence":0.0-1.0,"reasoning":"ek line"}`,
  };
}

/** Decide mode — AI hi final decision leta hai. */
export function decideQuestion(s: MarketState, signal: Signal): AiQuestion {
  return {
    instructions: {
      question: "Abhi kya karna chahiye: long (CE), short (PE), ya wait?",
      goal: "Maximum 1 position at a time. Trade tabhi jab edge clear ho; warna wait.",
      timing: `${s.minutesToClose} min close tak. Naye entry ${s.minutesToClose < 30 ? "allowed nahi (close ke paas)" : "allowed"}.`,
      inputs: stateDigest(s, signal, {
        strategy_suggestion: { action: signal.action, reason: signal.reason, confidence: signal.confidence },
      }),
    },
    choices: ["buy", "sell", "hold"],
    criteria: {
      buy: "Uptrend/momentum upar, VWAP ke upar, breakout dhakka, aur close tak kaafi time bacha hai.",
      sell: "Downtrend/momentum neeche, VWAP ke neeche, breakdown dhakka.",
      hold: "Choppy/range-bound tape, mixed signals, ya close ke paas — wait karo.",
    },
    responseShape: `{"choice":"buy"|"sell"|"hold","confidence":0.0-1.0,"reasoning":"ek line"}`,
  };
}

/** Naye position ko sanity-check karne wala question (entry se pehle). */
export function sanityQuestion(s: MarketState, signal: Signal, strike: number, premium: number): AiQuestion {
  return {
    instructions: {
      question: `Option leg plan: ${signal.action === "buy" ? "CE" : "PE"} strike ${strike} @ ₹${premium}. Kya ye plan theek hai?`,
      goal: "Sirf tab approve karo jab strike/premium aur risk plan sensible ho (premium bahut sasta/mehenga nahi, stop realistic).",
      timing: "Entry abhi.",
      inputs: stateDigest(s, signal, { planned_strike: strike, planned_premium: premium }),
    },
    choices: ["approve", "reject"],
    criteria: {
      approve: "Premium reasonable (₹40+), strike ATM/near-ATM, index plan coherent.",
      reject: "Premium bahut sasta (charges kha jayenge), strike bahut door, ya plan me contradiction.",
    },
    responseShape: `{"choice":"approve"|"reject","confidence":0.0-1.0,"reasoning":"ek line"}`,
  };
}
