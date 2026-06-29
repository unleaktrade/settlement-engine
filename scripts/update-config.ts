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
 * untouched on-chain. Pure parsing/validation/diff logic lives in
 * `./config-fields` so it can be unit-tested without a validator.
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
import { SettlementEngine } from "../target/types/settlement_engine";
import {
  ConfigFields,
  computeChanges,
  normalize,
  parseArgv,
  readConfigFile,
} from "./config-fields";
import { resolveClusterUrl } from "./cluster";

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

  // Default to devnet (and expand aliases) when ANCHOR_PROVIDER_URL is unset;
  // ANCHOR_WALLET is still required by env() since this script signs.
  process.env.ANCHOR_PROVIDER_URL = resolveClusterUrl(
    process.env.ANCHOR_PROVIDER_URL
  );
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

  // Diff desired against current; keep only real changes (no no-op writes).
  const { changes, lines, rotatesAdmin } = computeChanges(
    {
      admin: existing.admin,
      usdcMint: existing.usdcMint,
      treasuryWallet: existing.treasuryWallet,
      liquidityGuard: existing.liquidityGuard,
      facilitatorFeeBps: existing.facilitatorFeeBps,
    },
    desired
  );

  console.log("\nPlanned changes:");
  for (const line of lines) console.log(line);

  if (Object.keys(changes).length === 0) {
    console.log(
      "\nNothing to do — all provided values already match on-chain."
    );
    return;
  }

  if (rotatesAdmin && changes.admin) {
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

// Only run the CLI when executed directly — importing this module (e.g. in
// tests) must not fire a transaction.
if (require.main === module) {
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
}
