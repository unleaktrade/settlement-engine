/**
 * Cluster resolution shared by the config scripts.
 *
 * The whole point: when `ANCHOR_PROVIDER_URL` is unset, default to **devnet**
 * (the project's primary cluster) instead of throwing. Pure (no Anchor import)
 * so it can be unit-tested.
 */

/** Default cluster used when ANCHOR_PROVIDER_URL is unset. */
export const DEFAULT_CLUSTER = "devnet";

/** Short cluster aliases → RPC endpoint URLs. */
export const CLUSTER_ALIASES: Record<string, string> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
  localhost: "http://127.0.0.1:8899",
};

/**
 * Resolve a cluster RPC URL from an `ANCHOR_PROVIDER_URL`-style value:
 * - undefined / blank  → the default (devnet) endpoint
 * - a known alias (case-insensitive, e.g. "devnet", "localnet") → its URL
 * - anything else      → returned unchanged (treated as a full RPC URL)
 */
export function resolveClusterUrl(envValue?: string): string {
  const v = (envValue ?? "").trim();
  if (!v) return CLUSTER_ALIASES[DEFAULT_CLUSTER];
  return CLUSTER_ALIASES[v.toLowerCase()] ?? v;
}
