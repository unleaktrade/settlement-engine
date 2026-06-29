/**
 * Pure, side-effect-free helpers for reading/validating/diffing Config fields.
 *
 * Deliberately free of Anchor / IDL-type imports so it can be unit-tested
 * without `anchor build`, a provider, or a validator. `scripts/update-config.ts`
 * wires these into the actual on-chain transaction.
 */
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import * as YAML from "yaml";

/** Canonical field set that maps onto the on-chain `update_config` args. */
export type ConfigFields = {
  admin?: PublicKey;
  usdcMint?: PublicKey;
  treasuryWallet?: PublicKey;
  liquidityGuard?: PublicKey;
  facilitatorFeeBps?: number;
};

/** Canonical fields in the order they are passed to `update_config`. */
export const CANONICAL_ORDER: (keyof ConfigFields)[] = [
  "admin",
  "usdcMint",
  "treasuryWallet",
  "liquidityGuard",
  "facilitatorFeeBps",
];

/** Map every accepted input key (snake_case + camelCase + flag) → canonical. */
export const KEY_ALIASES: Record<string, keyof ConfigFields> = {
  admin: "admin",
  "new-admin": "admin",
  new_admin: "admin",
  usdcmint: "usdcMint",
  usdc_mint: "usdcMint",
  "usdc-mint": "usdcMint",
  treasurywallet: "treasuryWallet",
  treasury_wallet: "treasuryWallet",
  "treasury-wallet": "treasuryWallet",
  treasury: "treasuryWallet",
  liquidityguard: "liquidityGuard",
  liquidity_guard: "liquidityGuard",
  "liquidity-guard": "liquidityGuard",
  facilitatorfeebps: "facilitatorFeeBps",
  facilitator_fee_bps: "facilitatorFeeBps",
  "facilitator-fee-bps": "facilitatorFeeBps",
};

export function requirePubkey(name: string, value: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${name} is not a valid base58 pubkey: ${value}`);
  }
}

export function parseFeeBps(name: string, value: number | string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10_000) {
    throw new Error(`${name} must be an integer 0..10000, got: ${value}`);
  }
  return n;
}

/** Normalize a raw {key: value} record into a typed, validated ConfigFields. */
export function normalize(
  raw: Record<string, unknown>,
  source: string
): ConfigFields {
  const out: ConfigFields = {};
  for (const [rawKey, rawVal] of Object.entries(raw)) {
    if (rawVal === undefined || rawVal === null) continue;
    const key = KEY_ALIASES[rawKey.toLowerCase()];
    if (!key) {
      throw new Error(
        `Unknown field "${rawKey}" in ${source}. Allowed: admin, usdcMint, ` +
          `treasuryWallet, liquidityGuard, facilitatorFeeBps (snake_case ok).`
      );
    }
    if (key === "facilitatorFeeBps") {
      out[key] = parseFeeBps(rawKey, rawVal as number | string);
    } else {
      out[key] = requirePubkey(rawKey, String(rawVal));
    }
  }
  return out;
}

/** Parse a JSON/YAML config file into a raw record (by file extension). */
export function readConfigFile(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) {
    throw new Error(`--config file not found: ${file}`);
  }
  const text = fs.readFileSync(file, "utf8");
  const ext = path.extname(file).toLowerCase();
  let parsed: unknown;
  if (ext === ".json") {
    parsed = JSON.parse(text);
  } else if (ext === ".yaml" || ext === ".yml") {
    parsed = YAML.parse(text);
  } else {
    throw new Error(
      `--config must be .json, .yaml, or .yml (got "${ext || "no extension"}")`
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`--config file must contain a top-level object: ${file}`);
  }
  return parsed as Record<string, unknown>;
}

export type ParsedArgs = {
  raw: Record<string, string>;
  configFile?: string;
  dryRun: boolean;
  help: boolean;
};

/** Minimal flag parser: --key value, plus --dry-run / --help booleans. */
export function parseArgv(argv: string[]): ParsedArgs {
  const raw: Record<string, string> = {};
  let configFile: string | undefined;
  let dryRun = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      throw new Error(`Unexpected argument: ${tok} (flags must start with --)`);
    }
    const name = tok.slice(2);
    if (name === "help") {
      help = true;
      continue;
    }
    if (name === "dry-run") {
      dryRun = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) {
      throw new Error(`Flag --${name} requires a value`);
    }
    if (name === "config") {
      configFile = value;
    } else {
      raw[name] = value;
    }
  }
  return { raw, configFile, dryRun, help };
}

export function fmt(value: PublicKey | number): string {
  return value instanceof PublicKey ? value.toBase58() : String(value);
}

export type ChangePlan = {
  /** Fields that genuinely differ from the current on-chain value. */
  changes: ConfigFields;
  /** Canonical keys that were requested but already match on-chain. */
  skipped: (keyof ConfigFields)[];
  /** Human-readable diff lines (one per requested field). */
  lines: string[];
  /** True when `admin` is among the real changes (one-way authority handoff). */
  rotatesAdmin: boolean;
};

/**
 * Diff the desired fields against the current on-chain values. Only fields that
 * actually change end up in `changes`, so the resulting tx never carries no-op
 * writes. Pure: returns the plan instead of printing it.
 */
export function computeChanges(
  current: Record<keyof ConfigFields, PublicKey | number>,
  desired: ConfigFields
): ChangePlan {
  const changes: ConfigFields = {};
  const skipped: (keyof ConfigFields)[] = [];
  const lines: string[] = [];

  for (const field of CANONICAL_ORDER) {
    const next = desired[field];
    if (next === undefined) continue;
    const cur = current[field];
    const unchanged =
      next instanceof PublicKey
        ? (cur as PublicKey).equals(next)
        : cur === next;
    if (unchanged) {
      skipped.push(field);
      lines.push(`  ${field}: ${fmt(cur)} (already set — skipping)`);
      continue;
    }
    lines.push(`  ${field}: ${fmt(cur)} -> ${fmt(next)}`);
    (changes as Record<string, unknown>)[field] = next;
  }

  return { changes, skipped, lines, rotatesAdmin: changes.admin !== undefined };
}

/** Structural shape of a fetched Config account (no Anchor import needed). */
export type ConfigAccount = {
  admin: PublicKey;
  usdcMint: PublicKey;
  treasuryWallet: PublicKey;
  liquidityGuard: PublicKey;
  facilitatorFeeBps: number;
  bump: number;
};

/** Format a BPS fee as a human percentage, e.g. 1500 -> "15%", 1234 -> "12.34%". */
export function feeBpsToPercent(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : Number(pct.toFixed(2))}%`;
}

/** Render a fetched Config account as human-readable display lines (pure). */
export function formatConfig(cfg: ConfigAccount): string[] {
  return [
    `  admin            : ${cfg.admin.toBase58()}`,
    `  usdcMint         : ${cfg.usdcMint.toBase58()}`,
    `  treasuryWallet   : ${cfg.treasuryWallet.toBase58()}`,
    `  liquidityGuard   : ${cfg.liquidityGuard.toBase58()}`,
    `  facilitatorFeeBps: ${cfg.facilitatorFeeBps} (${feeBpsToPercent(
      cfg.facilitatorFeeBps
    )})`,
    `  bump             : ${cfg.bump}`,
  ];
}

export type GetArgs = { json: boolean; help: boolean };

/** Minimal boolean-flag parser for the get-config script (--json / --help). */
export function parseGetArgs(argv: string[]): GetArgs {
  let json = false;
  let help = false;
  for (const tok of argv) {
    if (!tok.startsWith("--")) {
      throw new Error(`Unexpected argument: ${tok} (flags must start with --)`);
    }
    const name = tok.slice(2);
    if (name === "json") json = true;
    else if (name === "help") help = true;
    else throw new Error(`Unknown flag --${name} (supported: --json, --help)`);
  }
  return { json, help };
}
