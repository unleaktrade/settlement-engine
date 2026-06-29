/**
 * View the singleton `Config` account on any cluster.
 *
 * Read-only companion to init-config-devnet.ts / update-config.ts: it fetches
 * the Config PDA (`["config"]`) and prints it. Never sends a transaction, so no
 * admin keypair is required — any wallet works as the provider.
 *
 * Cluster-agnostic: whatever `ANCHOR_PROVIDER_URL` points at (localnet, devnet,
 * mainnet) is the target.
 *
 * Usage:
 *
 *   # Human-readable summary
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn get-config
 *
 *   # Machine-readable JSON only (pipeable); prints `null` if not initialised
 *   yarn get-config --json
 *
 * Flags:
 *   --json   Print only the account as JSON (or `null` if absent)
 *   --help   Show this help
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { SettlementEngine } from "../target/types/settlement_engine";
import { formatConfig, parseGetArgs } from "./config-fields";

const HELP = `View the singleton Config account.

Cluster is whatever ANCHOR_PROVIDER_URL points at. Read-only — no tx is sent.

Flags:
  --json   print only the account as JSON (or \`null\` if not initialised)
  --help   show this help

Example:
  ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \\
  ANCHOR_WALLET=~/.config/solana/id.json \\
  yarn get-config`;

async function main() {
  const { json, help } = parseGetArgs(process.argv.slice(2));
  if (help) {
    console.log(HELP);
    return;
  }

  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace
    .SettlementEngine as Program<SettlementEngine>;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  const cfg = await program.account.config.fetchNullable(configPda);

  if (json) {
    // Pure machine-readable output: the account as JSON, or `null` if absent.
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }

  console.log("cluster      :", provider.connection.rpcEndpoint);
  console.log("program      :", program.programId.toBase58());
  console.log("config PDA   :", configPda.toBase58());

  if (!cfg) {
    console.log(
      `\nConfig not initialised on this cluster (${provider.connection.rpcEndpoint}).` +
        "\nInitialise it with scripts/init-config-devnet.ts (yarn init-config)."
    );
    return;
  }

  console.log("\nConfig:");
  for (const line of formatConfig(cfg)) console.log(line);

  console.log("\nRaw:");
  console.log(JSON.stringify(cfg, null, 2));
}

// Only run the CLI when executed directly — importing this module (e.g. in
// tests) must not hit the network.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
