/**
 * View the singleton `Config` account on any cluster.
 *
 * Read-only companion to init-config-devnet.ts / update-config.ts: it fetches
 * the Config PDA (`["config"]`) and prints it. Never sends a transaction, so no
 * admin keypair is required — any wallet works as the provider.
 *
 * Cluster-agnostic: the target is `ANCHOR_PROVIDER_URL` if set (a full URL or a
 * short alias like `devnet`/`localnet`), otherwise it **defaults to devnet**.
 * Read-only, so no `ANCHOR_WALLET` is needed — an ephemeral wallet is used.
 *
 * Usage:
 *
 *   # Human-readable summary (defaults to devnet)
 *   yarn get-config
 *
 *   # Target another cluster
 *   ANCHOR_PROVIDER_URL=localnet yarn get-config
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
import { resolveClusterUrl } from "./cluster";

const HELP = `View the singleton Config account.

Cluster comes from ANCHOR_PROVIDER_URL (full URL or alias devnet/testnet/
mainnet/localnet); defaults to devnet when unset. Read-only — no tx is sent and
no ANCHOR_WALLET is required.

Flags:
  --json   print only the account as JSON (or \`null\` if not initialised)
  --help   show this help

Example:
  yarn get-config
  ANCHOR_PROVIDER_URL=localnet yarn get-config --json`;

async function main() {
  const { json, help } = parseGetArgs(process.argv.slice(2));
  if (help) {
    console.log(HELP);
    return;
  }

  // Read-only provider: default to devnet, and use an ephemeral wallet so no
  // ANCHOR_WALLET keypair is needed just to view Config (it never signs).
  const url = resolveClusterUrl(process.env.ANCHOR_PROVIDER_URL);
  const connection = new anchor.web3.Connection(url, "confirmed");
  const wallet = new anchor.Wallet(anchor.web3.Keypair.generate());
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
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
