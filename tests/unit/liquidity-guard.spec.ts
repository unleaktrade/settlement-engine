/**
 * Unit tests for tests/utils/liquidityGuard.ts. Pure — no validator, no network.
 */
import { expect } from "chai";
import {
  DEFAULT_LIQUIDITY_GUARD_URL,
  liquidityGuardHeaders,
  resolveLiquidityGuardURL,
} from "../utils/liquidityGuard";

describe("liquidity-guard / resolveLiquidityGuardURL", () => {
  it("defaults to the devnet skip instance when unset or blank", () => {
    expect(resolveLiquidityGuardURL({})).to.equal(DEFAULT_LIQUIDITY_GUARD_URL);
    expect(resolveLiquidityGuardURL({ LIQUIDITY_GUARD_URL: "  " })).to.equal(
      DEFAULT_LIQUIDITY_GUARD_URL
    );
  });

  it("uses LIQUIDITY_GUARD_URL without trailing slashes", () => {
    expect(
      resolveLiquidityGuardURL({
        LIQUIDITY_GUARD_URL: " http://127.0.0.1:8080// ",
      })
    ).to.equal("http://127.0.0.1:8080");
  });
});

describe("liquidity-guard / liquidityGuardHeaders", () => {
  it("sends only Content-Type when no API key is configured", () => {
    for (const env of [
      {},
      { LIQUIDITY_GUARD_API_KEY: "" },
      { LIQUIDITY_GUARD_API_KEY: "  " },
    ]) {
      expect(liquidityGuardHeaders(env)).to.deep.equal({
        "Content-Type": "application/json",
      });
    }
  });

  it("adds a trimmed X-API-Key when LIQUIDITY_GUARD_API_KEY is set", () => {
    expect(
      liquidityGuardHeaders({ LIQUIDITY_GUARD_API_KEY: " k3y " })
    ).to.deep.equal({
      "Content-Type": "application/json",
      "X-API-Key": "k3y",
    });
  });
});
