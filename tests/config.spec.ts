import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SettlementEngine } from "../target/types/settlement_engine";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import assert from "assert";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;

// PascalCase key from crate name
const program = anchor.workspace.SettlementEngine as Program<SettlementEngine>;

/** Modern confirm helper (clears deprecation) */
async function confirm(signature: string) {
  const latest = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({ signature, ...latest });
}

/** Airdrop helper (fast + modern) */
async function fund(kp: Keypair, sol = 2) {
  const sig = await provider.connection.requestAirdrop(
    kp.publicKey,
    sol * anchor.web3.LAMPORTS_PER_SOL
  );
  await confirm(sig);
}

// Helper to derive Config PDA
const configPda = (programId: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("config")], programId);

describe("config account", () => {
  it("init/update/close works", async () => {
    const [cfgPda] = configPda(program.programId);

    const admin = Keypair.generate();
    const newAdmin = Keypair.generate();
    await Promise.all([fund(admin), fund(newAdmin)]);

    console.log("admin pubkey:", admin.publicKey.toBase58());
    console.log("config pda:", cfgPda.toBase58());

    const usdcMint = Keypair.generate().publicKey; // placeholder mint
    const treasury = Keypair.generate().publicKey;

    // init_config (admin is both payer and signer)
    await program.methods
      .initConfig(usdcMint, treasury)
      .accounts({
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    const cfg1 = await program.account.config.fetch(cfgPda);
    assert(cfg1.admin.equals(admin.publicKey));
    assert(cfg1.usdcMint.equals(usdcMint));
    assert(cfg1.treasuryUsdcOwner.equals(treasury));
    console.log("stored admin pubkey:", cfg1.admin.toBase58());

    // update_config (must be signed by current admin)
    await program.methods
      .updateConfig(newAdmin.publicKey, null, null)
      .accounts({ admin: admin.publicKey, config: cfgPda })
      .signers([admin])
      .rpc();

    const cfg2 = await program.account.config.fetch(cfgPda);
    assert(cfg2.admin.equals(newAdmin.publicKey));
    console.log("rotated admin pubkey:", newAdmin.publicKey.toBase58());

    // rotate mint + treasury with new admin
    const usdcMint2 = Keypair.generate().publicKey;
    const treasury2 = Keypair.generate().publicKey;
    await program.methods
      .updateConfig(null, usdcMint2, treasury2)
      .accounts({ admin: newAdmin.publicKey, config: cfgPda })
      .signers([newAdmin])
      .rpc();

    const cfg3 = await program.account.config.fetch(cfgPda);
    assert(cfg3.usdcMint.equals(usdcMint2));
    assert(cfg3.treasuryUsdcOwner.equals(treasury2));
    console.log("usdc mint:", cfg3.usdcMint.toBase58());
    console.log("treasury:", cfg3.treasuryUsdcOwner.toBase58());

    // close_config (must be signed by current admin)
    await program.methods
      .closeConfig()
      .accounts({ admin: newAdmin.publicKey, config: cfgPda })
      .signers([newAdmin])
      .rpc();

    let closed = false;
    try { await program.account.config.fetch(cfgPda); } catch { closed = true; }
    assert(closed, "config PDA should be closed");
  });
});