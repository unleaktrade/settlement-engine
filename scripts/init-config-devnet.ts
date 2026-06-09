/**
 * One-off: initialise the singleton `Config` account on a live cluster (devnet).
 *
 * The program is deployed to devnet but `init_config` is only ever run by the
 * localnet test suite, so `Config` does not exist on devnet and the app's
 * DevConfigPanel shows "(empty)". Run this once with the admin keypair to
 * create it. Idempotent: if Config already exists it prints and exits without
 * sending a transaction.
 *
 * Usage (admin keypair = the ANCHOR_WALLET; it becomes Config.admin):
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   LIQUIDITY_GUARD=<ed25519 service pubkey of the running liquidity-guard> \
 *   USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU \
 *   TREASURY_WALLET=<pubkey> \
 *   FACILITATOR_FEE_BPS=1000 \
 *   npx ts-node scripts/init-config-devnet.ts
 *
 * - LIQUIDITY_GUARD is REQUIRED and must match the running liquidity-guard's
 *   SIGNING_KEY, or the app's HealthPill will flag pubkey drift.
 * - USDC_MINT defaults to the devnet USDC mint.
 * - TREASURY_WALLET defaults to the admin pubkey (a warning is printed).
 * - FACILITATOR_FEE_BPS is optional; omit to use the program default (1000 = 10%).
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { SettlementEngine } from "../target/types/settlement_engine";

const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function requirePubkey(name: string, value: string | undefined): PublicKey {
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`Env var ${name} is not a valid base58 pubkey: ${value}`);
  }
}

async function main() {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  // PascalCase workspace key from the crate name, same as the test suite. Reads
  // the IDL/program id from target/ — no JSON import (keeps tsconfig untouched).
  const program = anchor.workspace
    .SettlementEngine as Program<SettlementEngine>;

  const admin = provider.wallet.publicKey;
  const liquidityGuard = requirePubkey(
    "LIQUIDITY_GUARD",
    process.env.LIQUIDITY_GUARD
  );
  const usdcMint = requirePubkey(
    "USDC_MINT",
    process.env.USDC_MINT ?? DEVNET_USDC
  );

  let treasury: PublicKey;
  if (process.env.TREASURY_WALLET) {
    treasury = requirePubkey("TREASURY_WALLET", process.env.TREASURY_WALLET);
  } else {
    treasury = admin;
    console.warn(
      "⚠  TREASURY_WALLET not set — defaulting to the admin pubkey."
    );
  }

  const feeBpsRaw = process.env.FACILITATOR_FEE_BPS;
  const feeBps = feeBpsRaw === undefined ? null : Number(feeBpsRaw);
  if (
    feeBps !== null &&
    (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000)
  ) {
    throw new Error(
      `FACILITATOR_FEE_BPS must be an integer 0..10000, got: ${feeBpsRaw}`
    );
  }

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  console.log("cluster      :", provider.connection.rpcEndpoint);
  console.log("program      :", program.programId.toBase58());
  console.log("config PDA   :", configPda.toBase58());
  console.log("admin        :", admin.toBase58());
  console.log("usdcMint     :", usdcMint.toBase58());
  console.log("treasury     :", treasury.toBase58());
  console.log("liquidityGuard:", liquidityGuard.toBase58());
  console.log(
    "facilitatorFeeBps:",
    feeBps === null ? "(program default 1000)" : feeBps
  );

  const existing = await program.account.config.fetchNullable(configPda);
  if (existing) {
    console.log(
      "\nConfig already initialised on this cluster — nothing to do:"
    );
    console.log(JSON.stringify(existing, null, 2));
    return;
  }

  const balance = await provider.connection.getBalance(admin);
  if (balance === 0) {
    throw new Error(
      `Admin ${admin.toBase58()} has 0 SOL on this cluster — fund it before initialising.`
    );
  }

  console.log("\nSending init_config…");
  const sig = await program.methods
    .initConfig(usdcMint, treasury, liquidityGuard, feeBps)
    .accounts({ admin })
    .rpc();

  const latest = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({ signature: sig, ...latest });
  console.log("init_config confirmed:", sig);

  const cfg = await program.account.config.fetch(configPda);
  console.log("\nStored Config:");
  console.log(JSON.stringify(cfg, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
