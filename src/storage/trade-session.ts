import type { TradeSession } from "../trade/session.js";
import type { StorageDriver } from "./wallet-repository.js";

const TRADE_SESSIONS_KEY = "granola.trade-sessions.v1";
const HEX_32 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalAmount(value: unknown): boolean {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

function assertSession(value: unknown): asserts value is TradeSession {
  if (!value || typeof value !== "object") throw new Error("Trade session storage is corrupt");
  const session = value as Partial<TradeSession>;
  if (session.schema !== "granola/trade-session/v1") {
    throw new Error(`Unsupported trade session schema: ${String(session.schema)}`);
  }
  if (!session.sessionId || !HEX_32.test(session.sessionId)) {
    throw new Error("Trade session ID is invalid");
  }
  if (!session.reservationId || !UUID_V4.test(session.reservationId)) {
    throw new Error("Trade reservation ID is invalid");
  }
  if (session.role !== "maker" && session.role !== "taker") {
    throw new Error("Trade role is invalid");
  }
  if (
    typeof session.phase !== "string" ||
    typeof session.orderAddress !== "string" ||
    !session.orderAddress ||
    typeof session.orderHead !== "string" ||
    !HEX_32.test(session.orderHead) ||
    !Number.isSafeInteger(session.createdAt) ||
    !Number.isSafeInteger(session.updatedAt) ||
    (session.createdAt ?? -1) < 0 ||
    (session.updatedAt ?? -1) < (session.createdAt ?? 0)
  ) {
    throw new Error("Trade session metadata is invalid");
  }
  const terms = session.terms;
  if (
    !terms ||
    typeof terms.baseMint !== "string" ||
    typeof terms.baseUnit !== "string" ||
    typeof terms.baseKeyset !== "string" ||
    !canonicalAmount(terms.baseAmount) ||
    typeof terms.quoteMint !== "string" ||
    typeof terms.quoteUnit !== "string" ||
    typeof terms.quoteKeyset !== "string" ||
    !canonicalAmount(terms.quoteAmount) ||
    !terms.price ||
    !canonicalAmount(terms.price.numerator) ||
    !canonicalAmount(terms.price.denominator)
  ) {
    throw new Error("Trade terms are invalid");
  }
  const plan = session.plan;
  if (!plan || Object.values(plan).some((item) => !Number.isSafeInteger(item) || item < 0)) {
    throw new Error("Trade settlement plan is invalid");
  }
  if (
    !session.evidence ||
    typeof session.evidence.makerPubkey !== "string" ||
    !Array.isArray(session.evidence.commitments) ||
    !Array.isArray(session.evidence.mintStates)
  ) {
    throw new Error("Trade evidence is invalid");
  }
  const privateState = session.privateState;
  if (
    !privateState ||
    typeof privateState.nostrPrivateKey !== "string" ||
    typeof privateState.cashuPrivateKey !== "string" ||
    typeof privateState.refundPrivateKey !== "string" ||
    !(typeof privateState.preimage === "string" || privateState.preimage === null) ||
    !(typeof privateState.baseToken === "string" || privateState.baseToken === null) ||
    !(typeof privateState.quoteToken === "string" || privateState.quoteToken === null) ||
    !Array.isArray(privateState.exactOutbox) ||
    privateState.exactOutbox.some((item) => typeof item !== "string")
  ) {
    throw new Error("Trade recovery state is invalid");
  }
}

function assertSessions(value: unknown): asserts value is TradeSession[] {
  if (!Array.isArray(value)) throw new Error("Trade session storage is corrupt");
  const seen = new Set<string>();
  for (const session of value) {
    assertSession(session);
    if (seen.has(session.sessionId)) throw new Error("Trade session storage has duplicate IDs");
    seen.add(session.sessionId);
  }
}

export class TradeSessionRepository {
  constructor(private readonly driver: StorageDriver) {}

  async list(): Promise<TradeSession[]> {
    const stored = await this.driver.get(TRADE_SESSIONS_KEY);
    if (stored === undefined || stored === null) return [];
    assertSessions(stored);
    return clone(stored);
  }

  async get(sessionId: string): Promise<TradeSession | undefined> {
    return (await this.list()).find((session) => session.sessionId === sessionId);
  }

  async save(session: TradeSession): Promise<void> {
    assertSession(session);
    const sessions = await this.list();
    const index = sessions.findIndex((item) => item.sessionId === session.sessionId);
    if (index >= 0) {
      const current = sessions[index];
      if (current && session.updatedAt < current.updatedAt) {
        throw new Error("Refusing to overwrite a newer trade session with an older trade session");
      }
      sessions[index] = clone(session);
    } else {
      sessions.push(clone(session));
    }
    await this.driver.set(TRADE_SESSIONS_KEY, sessions);
  }
}
