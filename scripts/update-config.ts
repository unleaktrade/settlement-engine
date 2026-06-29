/**
 * Update any field(s) of the singleton `Config` account on any cluster.
 *
 * Config is the global singleton that drives the whole Settlement Engine
 * (admin, USDC mint, treasury, liquidity-guard ed25519 pubkey, facilitator
 * fee). The on-chain `update_config` instruction takes an Option<T> for every
 * mutable field, so any subset of fields can be changed in a single tx — this
 * script is the client driver for it.
 *
 * Cluster-agnostic: whatever `ANCHOR_PROVIDER_URL` points at (localnet, devnet,
 * mainnet) is the target. The signing wallet (`ANCHOR_WALLET`) MUST be the
 * Config's current `admin`, or the tx fails with `Unauthorized`.
 *
 * Field values come from a JSON/YAML file and/or CLI flags. CLI flags override
 * file values. Only the fields you provide are sent — everything else is left
 * untouched on-chain.
 *
 * Updatable fields (canonical camelCase keys; snake_case also accepted in files):
 *   admin             Pubkey  — rotates the admin authority (one-way handoff!)
 *   usdcMint          Pubkey  — USDC mint for fees/bonds
 *   treasuryWallet    Pubkey  — treasury wallet for fee collection
 *   liquidityGuard    Pubkey  — ed25519 pubkey for liquidity-guard verification
 *   facilitatorFeeBps number  — facilitator fee in BPS, integer 0..10000
 *
 * Usage:
 *
 *   # CLI flags only
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn update-config --facilitator-fee-bps 1500
 *
 *   # From a JSON or YAML file (parsed by extension)
 *   yarn update-config --config scripts/config.example.yaml
 *
 *   # File for the base, flags override individual fields
 *   yarn update-config --config scripts/config.example.yaml --treasury-wallet <pubkey>
 *
 *   # Preview without sending a transaction
 *   yarn update-config --facilitator-fee-bps 1500 --dry-run
 *
 * Flags:
 *   --config <path>          JSON (.json) or YAML (.yaml/.yml) file of field values
 *   --admin <pubkey>
 *   --usdc-mint <pubkey>
 *   --treasury-wallet <pubkey>
 *   --liquidity-guard <pubkey>
 *   --facilitator-fee-bps <n>
 *   --dry-run                Print the planned changes and exit (no tx)
 *   --help                   Show this help
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as YAML from "yaml";
import { SettlementEngine } from "../target/types/settlement_engine";

/** Canonical field set that maps onto the on-chain `update_config` args. */
type ConfigFields = {
  admin?: PublicKey;
  usdcMint?: PublicKey;
  treasuryWallet?: PublicKey;
  liquidityGuard?: PublicKey;
  facilitatorFeeBps?: number;
};

/** Map every accepted input key (snake_case + camelCase + flag) → canonical. */
const KEY_ALIASES: Record<string, keyof ConfigFields> = {
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

const HELP = `Update any field(s) of the singleton Config account.

Cluster is whatever ANCHOR_PROVIDER_URL points at; ANCHOR_WALLET must be the
current Config admin. CLI flags override --config file values.

Flags:
  --config <path>            JSON (.json) or YAML (.yaml/.yml) file of fields
  --admin <pubkey>           rotate admin authority (one-way!)
  --usdc-mint <pubkey>
  --treasury-wallet <pubkey>
  --liquidity-guard <pubkey>
  --facilitator-fee-bps <n>  integer 0..10000
  --dry-run                  print planned changes, send no tx
  --help                     show this help

Example:
  ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \\
  ANCHOR_WALLET=~/.config/solana/id.json \\
  yarn update-config --config scripts/config.example.yaml --facilitator-fee-bps 1500`;

function requirePubkey(name: string, value: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${name} is not a valid base58 pubkey: ${value}`);
  }
}

function parseFeeBps(name: string, value: number | string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10_000) {
    throw new Error(`${name} must be an integer 0..10000, got: ${value}`);
  }
  return n;
}

/** Normalize a raw {key: value} record into a typed, validated ConfigFields. */
function normalize(raw: Record<string, unknown>, source: string): ConfigFields {
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
function readConfigFile(file: string): Record<string, unknown> {
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

/** Minimal flag parser: --key value, plus --dry-run / --help booleans. */
function parseArgv(argv: string[]): {
  raw: Record<string, string>;
  configFile?: string;
  dryRun: boolean;
  help: boolean;
} {
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

function fmt(field: keyof ConfigFields, value: PublicKey | number): string {
  return value instanceof PublicKey ? value.toBase58() : String(value);
}

async function main() {
  const { raw, configFile, dryRun, help } = parseArgv(process.argv.slice(2));
  if (help) {
    console.log(HELP);
    return;
  }

  // Merge: config file first, then CLI flags override.
  const fromFile = configFile
    ? normalize(readConfigFile(configFile), configFile)
    : {};
  const fromFlags = normalize(raw, "CLI flags");
  const desired: ConfigFields = { ...fromFile, ...fromFlags };

  if (Object.keys(desired).length === 0) {
    throw new Error(
      "No fields to update. Pass --config <file> and/or field flags " +
        "(e.g. --facilitator-fee-bps 1500). Use --help for usage."
    );
  }

  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  // PascalCase workspace key from the crate name, same as the test suite.
  const program = anchor.workspace
    .SettlementEngine as Program<SettlementEngine>;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  console.log("cluster      :", provider.connection.rpcEndpoint);
  console.log("program      :", program.programId.toBase58());
  console.log("config PDA   :", configPda.toBase58());
  console.log("signer (admin):", provider.wallet.publicKey.toBase58());

  const existing = await program.account.config.fetchNullable(configPda);
  if (!existing) {
    throw new Error(
      `Config does not exist on this cluster (${provider.connection.rpcEndpoint}). ` +
        "Initialise it first with scripts/init-config-devnet.ts."
    );
  }

  // Map on-chain account fields to our canonical keys for the before/after diff.
  const current: Record<keyof ConfigFields, PublicKey | number> = {
    admin: existing.admin,
    usdcMint: existing.usdcMint,
    treasuryWallet: existing.treasuryWallet,
    liquidityGuard: existing.liquidityGuard,
    facilitatorFeeBps: existing.facilitatorFeeBps,
  };

  // Keep only real changes so the tx never carries no-op writes.
  const changes: ConfigFields = {};
  const ORDER: (keyof ConfigFields)[] = [
    "admin",
    "usdcMint",
    "treasuryWallet",
    "liquidityGuard",
    "facilitatorFeeBps",
  ];
  console.log("\nPlanned changes:");
  for (const field of ORDER) {
    const next = desired[field];
    if (next === undefined) continue;
    const cur = current[field];
    const unchanged =
      next instanceof PublicKey
        ? (cur as PublicKey).equals(next)
        : cur === next;
    if (unchanged) {
      console.log(`  ${field}: ${fmt(field, cur)} (already set — skipping)`);
      continue;
    }
    console.log(`  ${field}: ${fmt(field, cur)} -> ${fmt(field, next)}`);
    (changes as Record<string, unknown>)[field] = next;
  }

  if (Object.keys(changes).length === 0) {
    console.log(
      "\nNothing to do — all provided values already match on-chain."
    );
    return;
  }

  if (changes.admin) {
    console.warn(
      "\n⚠  ADMIN ROTATION REQUESTED — this hands control of Config to " +
        `${changes.admin.toBase58()}.\n   After this tx the current wallet can no longer update Config.`
    );
  }

  if (dryRun) {
    console.log("\n--dry-run set — no transaction sent.");
    return;
  }

  console.log("\nSending update_config…");
  const sig = await program.methods
    .updateConfig(
      changes.admin ?? null,
      changes.usdcMint ?? null,
      changes.treasuryWallet ?? null,
      changes.liquidityGuard ?? null,
      changes.facilitatorFeeBps ?? null
    )
    .accounts({ admin: provider.wallet.publicKey, config: configPda })
    .rpc();

  const latest = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({ signature: sig, ...latest });
  console.log("update_config confirmed:", sig);

  const cfg = await program.account.config.fetch(configPda);
  console.log("\nStored Config:");
  console.log(JSON.stringify(cfg, null, 2));
}

main().catch((err) => {
  const msg = String(err?.message ?? err);
  if (/has_one|Unauthorized|2001|has one/i.test(msg)) {
    console.error(
      "\nUpdate failed: the signing wallet is not the current Config admin.\n" +
        "Point ANCHOR_WALLET at the admin keypair and retry."
    );
  }
  console.error(err);
  process.exit(1);
});
