/**
 * Shared liquidity-guard client settings for the Anchor integration tests.
 *
 * - `LIQUIDITY_GUARD_URL` overrides the default devnet "skip" instance
 *   (SKIP_FUND_CHECKS, so test takers need no real balances).
 * - `LIQUIDITY_GUARD_API_KEY` is sent as `X-API-Key` on POST /check once the
 *   guard runs with API_KEYS (liquidity-guard#13); unset = no header, which
 *   still works against a guard without keys. /health never needs it.
 *
 * Pure functions of `env` so tests/unit can cover them without a validator.
 */

export const DEFAULT_LIQUIDITY_GUARD_URL =
  "https://liquidity-guard-devnet-skip-c644b6411603.herokuapp.com";

type Env = Record<string, string | undefined>;

export function resolveLiquidityGuardURL(env: Env = process.env): string {
  const url = env.LIQUIDITY_GUARD_URL?.trim();
  return (url || DEFAULT_LIQUIDITY_GUARD_URL).replace(/\/+$/, "");
}

/** Headers for POST /check: JSON, plus `X-API-Key` when a key is configured. */
export function liquidityGuardHeaders(
  env: Env = process.env
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const key = env.LIQUIDITY_GUARD_API_KEY?.trim();
  if (key) headers["X-API-Key"] = key;
  return headers;
}

export const liquidityGuardURL = resolveLiquidityGuardURL();
