/**
 * index.ts — broker factory. Config ke BROKER se sahi adapter uthao.
 */

import { config } from "../config.ts";
import { AngelBroker } from "./angel.ts";
import { DhanBroker } from "./dhan.ts";
import { FyersBroker } from "./fyers.ts";
import { PaperBroker } from "./paper.ts";
import { UpstoxBroker } from "./upstox.ts";
import { ZerodhaBroker } from "./zerodha.ts";
import type { Broker } from "./types.ts";
import { BrokerError } from "./types.ts";

export function createBroker(name = config.broker.name): Broker {
  switch (name.toLowerCase()) {
    case "paper":
      return new PaperBroker(config.risk.capital);
    case "zerodha":
      return new ZerodhaBroker();
    case "angel":
    case "angelone":
      return new AngelBroker();
    case "fyers":
      return new FyersBroker();
    case "upstox":
      return new UpstoxBroker();
    case "dhan":
      return new DhanBroker();
    default:
      throw new BrokerError(
        `Broker "${name}" support nahi hai. Allowed: paper | zerodha | angel | fyers | upstox | dhan`,
        name,
      );
  }
}

export type { Broker } from "./types.ts";
export { PaperBroker } from "./paper.ts";
export { BROKER_LIST } from "./list.ts";
