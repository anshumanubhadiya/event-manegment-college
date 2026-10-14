/** list.ts — supported brokers (dashboard/docs ke liye). */

export const BROKER_LIST = [
  { id: "paper", label: "Paper (simulated)", real: false, note: "Default. Paisa nahi lagta, fills + charges realistic." },
  { id: "zerodha", label: "Zerodha Kite Connect", real: true, note: "₹20/order, daily access_token chahiye." },
  { id: "angel", label: "Angel One SmartAPI", real: true, note: "TOTP auto-generate, scrip master auto-download." },
  { id: "fyers", label: "Fyers API v3", real: true, note: "Daily token refresh (auth code flow)." },
  { id: "upstox", label: "Upstox API v2", real: true, note: "instrument_key master auto-download." },
  { id: "dhan", label: "DhanHQ v2", real: true, note: "securityId master auto-download." },
] as const;
