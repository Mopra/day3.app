import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSendPacer,
  effectiveRate,
  isTransientThrottle,
  withSendPacing,
  DEFAULT_MAX_SEND_RATE,
  SEND_RATE_KEY,
  type SendPaceStore,
  type SendPacer,
} from "../src/email/send-rate";
import type { EmailProvider, SendEmailInput, SendEmailResult } from "../src/email/provider";

// In-memory stand-in for the ioredis slice the pacer uses. The two branches
// mirror RESERVE_SLOT_LUA / BRAKE_LUA line for line (the Lua is the same three
// steps against Redis's own clock); holding `nowUs` still makes the waits the
// pacer hands out exactly predictable.
class FakePaceStore implements SendPaceStore {
  nowUs = 1_700_000_000_000_000;
  tat = 0;
  reserves = 0;
  brakes = 0;
  lastArgs: (string | number)[] = [];

  async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.lastArgs = args;
    const amount = Number(args[1]);
    if (this.tat < this.nowUs) this.tat = this.nowUs;
    if (script.includes("local interval")) {
      this.reserves++;
      const waitUs = this.tat - this.nowUs;
      this.tat += amount;
      return waitUs;
    }
    this.brakes++;
    this.tat += amount;
    return 0;
  }
}

class BrokenPaceStore implements SendPaceStore {
  async eval(): Promise<unknown> {
    throw new Error("ECONNREFUSED");
  }
}

// Commands that never settle — a real ioredis connection with
// `maxRetriesPerRequest: null` while Redis is unreachable. The pacer must fall
// back to unpaced sending via its timeout rather than hang the send forever.
class HangingPaceStore implements SendPaceStore {
  eval(): Promise<unknown> {
    return new Promise<unknown>(() => {});
  }
}

const SEND: SendEmailInput = {
  accountId: "acc_1",
  fromEmail: "hi@example.com",
  fromName: "Day3",
  toEmail: "sub@example.com",
  subject: "hello",
  html: "<p>hi</p>",
};

const sent: SendEmailResult = { provider: "ses", status: "sent", messageId: "m1" };
const throttled: SendEmailResult = {
  provider: "ses",
  status: "rate_limited",
  error: "TooManyRequestsException",
};

class RecordingProvider implements EmailProvider {
  calls = 0;
  results: SendEmailResult[] = [];
  deleted: string[] = [];
  constructor(private fallback: SendEmailResult = sent) {}
  async send(): Promise<SendEmailResult> {
    const result = this.results[this.calls] ?? this.fallback;
    this.calls++;
    return result;
  }
  async deleteIdentity(identity: string): Promise<void> {
    this.deleted.push(identity);
  }
}

function stubPacer(): SendPacer & { acquires: number; brakes: number[] } {
  const state = {
    acquires: 0,
    brakes: [] as number[],
    async acquire() {
      state.acquires++;
    },
    async brake(ms: number) {
      state.brakes.push(ms);
    },
    async warmUp() {
      return 10;
    },
    rate() {
      return 10;
    },
  };
  return state;
}

const ENV_KEYS = ["SES_MAX_SEND_RATE", "SEND_RATE_MARGIN", "SEND_RATE_STORE_TIMEOUT_MS"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.useRealTimers();
});

describe("effectiveRate", () => {
  it("applies the safety margin to a reported ceiling", () => {
    expect(effectiveRate(14, 0.9)).toBeCloseTo(12.6);
    expect(effectiveRate(50, 0.9)).toBeCloseTo(45);
  });

  it("falls back to the conservative default when no ceiling is reported", () => {
    expect(effectiveRate(null, 0.9)).toBeCloseTo(DEFAULT_MAX_SEND_RATE * 0.9);
    // Junk from the provider is the same case, not a reason to send unpaced.
    expect(effectiveRate(0, 0.9)).toBeCloseTo(DEFAULT_MAX_SEND_RATE * 0.9);
    expect(effectiveRate(-5, 0.9)).toBeCloseTo(DEFAULT_MAX_SEND_RATE * 0.9);
    expect(effectiveRate(Number.NaN, 0.9)).toBeCloseTo(DEFAULT_MAX_SEND_RATE * 0.9);
  });

  it("never paces below 1/s", () => {
    // SES hands sandbox accounts 1/s; the margin must not stretch that further.
    expect(effectiveRate(1, 0.9)).toBe(1);
  });
});

describe("isTransientThrottle", () => {
  it("is true only for a plain rate throttle", () => {
    expect(isTransientThrottle(throttled)).toBe(true);
    expect(
      isTransientThrottle({ provider: "ses", status: "rate_limited", error: "LimitExceededException" }),
    ).toBe(true);
  });

  it("is false for the walls that retrying cannot clear", () => {
    // These reach the handler so it pauses the campaign (and pages ops).
    for (const error of [
      "E_DAILY_LIMIT_EXCEEDED",
      "E_ACCOUNT_SUSPENDED: SendingPausedException",
      "E_SENDING_MISCONFIGURED: no such configuration set",
    ]) {
      expect(isTransientThrottle({ provider: "ses", status: "rate_limited", error })).toBe(false);
    }
  });

  it("is false for any non-rate-limited result", () => {
    expect(isTransientThrottle(sent)).toBe(false);
    expect(isTransientThrottle({ provider: "ses", status: "failed", error: "MessageRejected" })).toBe(
      false,
    );
  });
});

describe("createSendPacer", () => {
  it("does not pace a provider that reports no ceiling", async () => {
    const store = new FakePaceStore();
    const pacer = createSendPacer({ store });
    await pacer.warmUp();
    await pacer.acquire();
    await pacer.acquire();
    // The mock provider has no maxSendRate, so Redis is never touched.
    expect(store.reserves).toBe(0);
    expect(pacer.rate()).toBe(Number.POSITIVE_INFINITY);
  });

  it("spaces successive sends by one interval", async () => {
    const store = new FakePaceStore();
    // margin 1 keeps the arithmetic legible: 1000/s → a 1000µs interval.
    const pacer = createSendPacer({ store, rate: 1000, margin: 1 });
    await pacer.warmUp();

    await pacer.acquire();
    await pacer.acquire();
    await pacer.acquire();

    expect(store.reserves).toBe(3);
    expect(store.lastArgs[0]).toBe(SEND_RATE_KEY);
    expect(Number(store.lastArgs[1])).toBe(1000); // µs per send
    // Three reservations against a frozen clock leave the next slot 3 intervals out.
    expect(store.tat - store.nowUs).toBe(3000);
  });

  it("derives the rate from the provider and refreshes it later", async () => {
    const store = new FakePaceStore();
    const pacer = createSendPacer({
      store,
      margin: 1,
      discover: async () => 40,
    });
    expect(await pacer.warmUp()).toBe(40);
    await pacer.acquire();
    expect(Number(store.lastArgs[1])).toBe(25_000); // 1e6 / 40
  });

  it("prefers an explicit override to discovery", async () => {
    const store = new FakePaceStore();
    process.env.SES_MAX_SEND_RATE = "5";
    const discover = vi.fn(async () => 500);
    const pacer = createSendPacer({ store, margin: 1, discover });
    expect(await pacer.warmUp()).toBe(5);
    expect(discover).not.toHaveBeenCalled();
  });

  it("ignores an unparseable override rather than sending at NaN/s", async () => {
    const store = new FakePaceStore();
    process.env.SES_MAX_SEND_RATE = "14/s";
    const pacer = createSendPacer({ store, margin: 1, discover: async () => 40 });
    expect(await pacer.warmUp()).toBe(40);
  });

  it("falls back to the conservative default when discovery fails", async () => {
    const store = new FakePaceStore();
    const pacer = createSendPacer({
      store,
      margin: 1,
      discover: async () => {
        throw new Error("AccessDenied");
      },
    });
    // Still paced — a failed lookup must not read as "no limit".
    expect(await pacer.warmUp()).toBe(DEFAULT_MAX_SEND_RATE);
    await pacer.acquire();
    expect(store.reserves).toBe(1);
  });

  it("fails open when the store throws", async () => {
    const pacer = createSendPacer({
      store: new BrokenPaceStore(),
      rate: 10,
      margin: 1,
    });
    await pacer.warmUp();
    await expect(pacer.acquire()).resolves.toBeUndefined();
  });

  it("fails open when the store hangs", async () => {
    process.env.SEND_RATE_STORE_TIMEOUT_MS = "20";
    const pacer = createSendPacer({
      store: new HangingPaceStore(),
      rate: 10,
      margin: 1,
    });
    await pacer.warmUp();
    const startedAt = Date.now();
    await expect(pacer.acquire()).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("brakes by pushing every sender's next slot out", async () => {
    const store = new FakePaceStore();
    const pacer = createSendPacer({ store, rate: 1000, margin: 1 });
    await pacer.warmUp();
    await pacer.brake(500);
    expect(store.brakes).toBe(1);
    expect(store.tat - store.nowUs).toBe(500_000); // ms → µs
  });
});

describe("withSendPacing", () => {
  it("acquires a slot before every send and passes the result through", async () => {
    const provider = new RecordingProvider();
    const pacer = stubPacer();
    const paced = withSendPacing(provider, pacer);

    await expect(paced.send(SEND)).resolves.toEqual(sent);
    expect(pacer.acquires).toBe(1);
    expect(provider.calls).toBe(1);
    expect(pacer.brakes).toEqual([]);
  });

  it("absorbs a throttle that clears on retry", async () => {
    vi.useFakeTimers();
    const provider = new RecordingProvider();
    provider.results = [throttled, sent];
    const pacer = stubPacer();
    const paced = withSendPacing(provider, pacer);

    const promise = paced.send(SEND);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).resolves.toEqual(sent);
    expect(provider.calls).toBe(2);
    // Every sender backs off, not just this one.
    expect(pacer.brakes).toEqual([1000]);
    // The retry takes a fresh slot rather than jumping the queue.
    expect(pacer.acquires).toBe(2);
  });

  it("gives up after a bounded number of retries so the handler can pause", async () => {
    vi.useFakeTimers();
    const provider = new RecordingProvider(throttled);
    const pacer = stubPacer();
    const paced = withSendPacing(provider, pacer);

    const promise = paced.send(SEND);
    await vi.advanceTimersByTimeAsync(30_000);

    // The unchanged rate_limited result is what makes send-batch pause the
    // campaign and return the batch to pending — retrying forever would hold
    // claimed rows past the sweep's stuck-lock window instead.
    await expect(promise).resolves.toEqual(throttled);
    expect(provider.calls).toBe(4); // initial + 3 retries
    expect(pacer.brakes).toEqual([1000, 2000, 4000]);
  });

  it("does not retry a daily quota, suspension, or misconfiguration", async () => {
    for (const error of [
      "E_DAILY_LIMIT_EXCEEDED",
      "E_ACCOUNT_SUSPENDED: SendingPausedException",
      "E_SENDING_MISCONFIGURED: no such configuration set",
    ]) {
      const result: SendEmailResult = { provider: "ses", status: "rate_limited", error };
      const provider = new RecordingProvider(result);
      const pacer = stubPacer();
      await expect(withSendPacing(provider, pacer).send(SEND)).resolves.toEqual(result);
      expect(provider.calls).toBe(1);
      expect(pacer.brakes).toEqual([]);
    }
  });

  it("never retries an ambiguous failure", async () => {
    // `failed` covers transport errors where the message may already be at SES;
    // retrying one would duplicate an email.
    const failed: SendEmailResult = { provider: "ses", status: "failed", error: "TimeoutError" };
    const provider = new RecordingProvider(failed);
    const pacer = stubPacer();
    await expect(withSendPacing(provider, pacer).send(SEND)).resolves.toEqual(failed);
    expect(provider.calls).toBe(1);
  });

  it("passes identity teardown through to the wrapped provider", async () => {
    const provider = new RecordingProvider();
    const paced = withSendPacing(provider, stubPacer());
    await paced.deleteIdentity!("mail.example.com");
    expect(provider.deleted).toEqual(["mail.example.com"]);
  });
});
