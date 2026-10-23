import { botsratedActionProvider } from "./botsratedActionProvider";
import { EvmWalletProvider } from "../../wallet-providers";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { BASE_USDC, BOTSRATED_PAY_TO } from "./constants";

jest.mock("@x402/fetch");
jest.mock("@x402/evm/exact/client");
jest.mock("../../analytics", () => ({ sendAnalyticsEvent: jest.fn() }));

const SELLER_PAY_TO = "0xe9030014F5DAe217d0A152f02A043567b16c1aBf";

// Trimmed from a real GET https://botsrated.com/v1/preflight response (2026-10-23).
const PREFLIGHT = {
  found: true,
  host: "blockrun.ai",
  latest_probe: {
    ts: "2026-10-23T13:06:35Z",
    url: "https://blockrun.ai/api/v1/chat/completions",
    status: 402,
    latency_ms: 1417,
    valid_402: true,
    live_amount: "2000",
    live_payTo: SELLER_PAY_TO,
    live_network: "eip155:8453",
    receipt_url:
      "https://botsrated.com/receipt/05889891d26734d55948?host=blockrun.ai&day=2026-10-23",
  },
  freshness: { last_probe_at: "2026-10-23T13:06:35Z", stale: false },
  listing: { price_usd: 0.002, payTo: SELLER_PAY_TO, network: "eip155:8453" },
  recent_window: { probes: 4, valid_402: 4, valid_402_rate: 1 },
  paid_tests_count: 1,
};

const CHECK_TERMS = {
  x402Version: 2,
  resource: { url: "https://botsrated.com/v1/check?host=blockrun.ai" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "1000",
      asset: BASE_USDC,
      payTo: BOTSRATED_PAY_TO,
      maxTimeoutSeconds: 300,
    },
  ],
};

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const quote402 = (terms = CHECK_TERMS) =>
  jsonResponse({}, 402, { "payment-required": btoa(JSON.stringify(terms)) });

describe("BotsRatedActionProvider", () => {
  const fetchMock = jest.fn();
  const paidFetch = jest.fn();
  let hook: ((ctx: unknown) => Promise<unknown>) | undefined;
  let wallet: jest.Mocked<EvmWalletProvider>;

  beforeEach(() => {
    jest.resetAllMocks();
    global.fetch = fetchMock;
    hook = undefined;
    (x402Client as unknown as jest.Mock).mockImplementation(() => ({
      onBeforePaymentCreation: (h: (ctx: unknown) => Promise<unknown>) => {
        hook = h;
      },
    }));
    (wrapFetchWithPayment as jest.Mock).mockReturnValue(paidFetch);
    wallet = Object.create(EvmWalletProvider.prototype);
    wallet.getNetwork = jest
      .fn()
      .mockReturnValue({ protocolFamily: "evm", networkId: "base-mainnet" });
    wallet.toSigner = jest.fn().mockReturnValue({ address: "0x1" });
    wallet.getName = jest.fn().mockReturnValue("test_wallet");
    wallet.getAddress = jest.fn().mockReturnValue("0x1");
  });

  describe("preflight", () => {
    it("reports a payTo that matches what BotsRated observed", async () => {
      fetchMock.mockResolvedValue(jsonResponse(PREFLIGHT));
      const out = JSON.parse(
        await botsratedActionProvider().preflight(wallet, {
          url: "https://blockrun.ai/api/v1/chat/completions",
          payTo: SELLER_PAY_TO.toLowerCase(),
          network: "eip155:8453",
        }),
      );
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://botsrated.com/v1/preflight?url=https%3A%2F%2Fblockrun.ai%2Fapi%2Fv1%2Fchat%2Fcompletions",
      );
      expect(out.payToCheck).toBe("matches_observed");
      expect(out.lastProbe.receiptUrl).toContain("/receipt/");
    });

    it("flags a payTo BotsRated never saw for the host", async () => {
      fetchMock.mockResolvedValue(jsonResponse(PREFLIGHT));
      const out = JSON.parse(
        await botsratedActionProvider().preflight(wallet, {
          url: "blockrun.ai",
          payTo: "0x000000000000000000000000000000000000dEaD",
        }),
      );
      expect(out.payToCheck).toBe("not_seen");
    });

    it("does not compare payTo across networks", async () => {
      fetchMock.mockResolvedValue(jsonResponse(PREFLIGHT));
      const out = JSON.parse(
        await botsratedActionProvider().preflight(wallet, {
          url: "blockrun.ai",
          payTo: "0x000000000000000000000000000000000000dEaD",
          network: "eip155:84532",
        }),
      );
      expect(out.payToCheck).toBe("not_compared");
    });

    it("returns covered=false for hosts BotsRated does not cover", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ error: { code: "host_not_covered", charged: false } }, 404),
      );
      const out = JSON.parse(
        await botsratedActionProvider().preflight(wallet, { url: "x.example" }),
      );
      expect(out).toMatchObject({ covered: false, host: "x.example" });
    });

    it("returns an error object when BotsRated is unreachable", async () => {
      fetchMock.mockRejectedValue(new Error("network down"));
      const out = JSON.parse(
        await botsratedActionProvider().preflight(wallet, { url: "x.example" }),
      );
      expect(out).toMatchObject({ error: true, details: "network down" });
    });
  });

  describe("paid_check", () => {
    it("is disabled without a spend limit and makes no request", async () => {
      delete process.env.BOTSRATED_MAX_SPEND_USDC;
      const out = JSON.parse(
        await botsratedActionProvider().paidCheck(wallet, { host: "blockrun.ai" }),
      );
      expect(out.message).toBe("Paid BotsRated checks are disabled");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("requires an EVM wallet on Base mainnet", async () => {
      wallet.getNetwork = jest
        .fn()
        .mockReturnValue({ protocolFamily: "evm", networkId: "base-sepolia" });
      const out = JSON.parse(
        await botsratedActionProvider({ maxSpendUsdc: 0.01 }).paidCheck(wallet, {
          host: "blockrun.ai",
        }),
      );
      expect(out.error).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not pay when BotsRated answers the unpaid request with a 404", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ error: { code: "host_not_covered", message: "not covered" } }, 404),
      );
      const out = JSON.parse(
        await botsratedActionProvider({ maxSpendUsdc: 0.01 }).paidCheck(wallet, {
          host: "x.example",
        }),
      );
      expect(out.message).toContain("nothing was paid");
      expect(paidFetch).not.toHaveBeenCalled();
    });

    it("rejects a quote to a different payTo", async () => {
      const bad = {
        ...CHECK_TERMS,
        accepts: [{ ...CHECK_TERMS.accepts[0], payTo: SELLER_PAY_TO }],
      };
      fetchMock.mockResolvedValue(quote402(bad));
      const out = JSON.parse(
        await botsratedActionProvider({ maxSpendUsdc: 0.01 }).paidCheck(wallet, {
          host: "blockrun.ai",
        }),
      );
      expect(out.message).toContain("quote rejected");
      expect(paidFetch).not.toHaveBeenCalled();
    });

    it("pays once, tracks spend and stops at the limit", async () => {
      fetchMock.mockImplementation(async () => quote402());
      paidFetch.mockImplementation(async () => jsonResponse({ host: "blockrun.ai", measured: {} }));
      const provider = botsratedActionProvider({ maxSpendUsdc: 0.0015 });

      const first = JSON.parse(await provider.paidCheck(wallet, { host: "blockrun.ai" }));
      expect(first).toMatchObject({ success: true, paidUsdc: 0.001, remainingUsdc: 0.0005 });
      expect(paidFetch).toHaveBeenCalledWith(
        "https://botsrated.com/v1/check?host=blockrun.ai",
        expect.anything(),
      );

      const second = JSON.parse(await provider.paidCheck(wallet, { host: "blockrun.ai" }));
      expect(second.message).toBe("BotsRated spend limit reached");
      expect(paidFetch).toHaveBeenCalledTimes(1);
    });

    it("releases the reservation when the paid request fails", async () => {
      fetchMock.mockImplementation(async () => quote402());
      paidFetch.mockResolvedValueOnce(jsonResponse({}, 500));
      paidFetch.mockResolvedValueOnce(jsonResponse({ host: "blockrun.ai" }));
      const provider = botsratedActionProvider({ maxSpendUsdc: 0.001 });
      expect(JSON.parse(await provider.paidCheck(wallet, { host: "blockrun.ai" })).error).toBe(
        true,
      );
      expect(JSON.parse(await provider.paidCheck(wallet, { host: "blockrun.ai" })).success).toBe(
        true,
      );
    });

    it("uses a free-quota answer without paying or counting it against the limit", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          host: "blockrun.ai",
          charged: false,
          free_quota: { route: "check", used: 1, limit: 100, remaining: 99 },
        }),
      );
      const provider = botsratedActionProvider({ maxSpendUsdc: 0.001 });
      const out = JSON.parse(await provider.paidCheck(wallet, { host: "blockrun.ai" }));
      expect(out).toMatchObject({
        success: true,
        paidUsdc: 0,
        charged: false,
        remainingUsdc: 0.001,
      });
      expect(paidFetch).not.toHaveBeenCalled();
    });

    it("refuses a quote above the published $0.001 price", async () => {
      fetchMock.mockResolvedValue(
        quote402({ ...CHECK_TERMS, accepts: [{ ...CHECK_TERMS.accepts[0], amount: "2000" }] }),
      );
      const out = JSON.parse(
        await botsratedActionProvider({ maxSpendUsdc: 0.01 }).paidCheck(wallet, {
          host: "blockrun.ai",
        }),
      );
      expect(out.message).toContain("quote rejected");
      expect(paidFetch).not.toHaveBeenCalled();
    });

    it("registers a hook that refuses any payment other than the validated quote", async () => {
      fetchMock.mockImplementation(async () => quote402());
      paidFetch.mockImplementation(async () => jsonResponse({}));
      await botsratedActionProvider({ maxSpendUsdc: 0.01 }).paidCheck(wallet, {
        host: "blockrun.ai",
      });
      expect(hook).toBeDefined();
      const ok = CHECK_TERMS.accepts[0];
      expect(await hook!({ selectedRequirements: ok })).toBeUndefined();
      expect(await hook!({ selectedRequirements: { ...ok, amount: "1001" } })).toMatchObject({
        abort: true,
      });
      expect(await hook!({ selectedRequirements: { ...ok, payTo: SELLER_PAY_TO } })).toMatchObject({
        abort: true,
      });
    });
  });

  it("supports every network (preflight is network-independent)", () => {
    expect(botsratedActionProvider().supportsNetwork({ protocolFamily: "svm" })).toBe(true);
  });
});
