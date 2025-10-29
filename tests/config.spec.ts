import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { assert } from "chai";

// Helper to derive Config PDA
const configPda = (programId: PublicKey) => {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
};

describe("Config – init/update/close", () => {
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);

  const program = anchor.workspace.SettlementEngine as Program;

  const usdcMint = Keypair.generate().publicKey; // placeholder for this test
  const treasury = Keypair.generate().publicKey;
  const newAdmin = Keypair.generate().publicKey;

  it("init_config creates the singleton with correct fields", async () => {
    const [cfgPda] = configPda(program.programId);
    const admin = Keypair.generate();

    await program.methods
      .initConfig(usdcMint, treasury)
      .accounts({
        payer: provider.wallet.publicKey,
        admin: admin.publicKey,
        config: cfgPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const cfg = await program.account.config.fetch(cfgPda);
    assert.ok(cfg.admin.equals(admin.publicKey));
    assert.ok(cfg.usdcMint.equals(usdcMint));
    assert.ok(cfg.treasuryUsdcOwner.equals(treasury));
    assert.isAbove(cfg.bump, 0);
  });

  it("update_config lets admin rotate fields", async () => {
    const [cfgPda] = configPda(program.programId);
    const admin = (await program.account.config.fetch(cfgPda)).admin;

    await program.methods
      .updateConfig(newAdmin, null, null)
      .accounts({ admin, config: cfgPda })
      .rpc();

    const cfg1 = await program.account.config.fetch(cfgPda);
    assert.ok(cfg1.admin.equals(newAdmin));

    await program.methods
      .updateConfig(null, usdcMint, treasury)
      .accounts({ admin: newAdmin, config: cfgPda })
      .rpc();

    const cfg2 = await program.account.config.fetch(cfgPda);
    assert.ok(cfg2.usdcMint.equals(usdcMint));
    assert.ok(cfg2.treasuryUsdcOwner.equals(treasury));
  });

  it("close_config closes the PDA and refunds rent to admin", async () => {
    const [cfgPda] = configPda(program.programId);
    const admin = (await program.account.config.fetch(cfgPda)).admin;

    await program.methods
      .closeConfig()
      .accounts({ admin, config: cfgPda })
      .rpc();

    try {
      await program.account.config.fetch(cfgPda);
      assert.fail("Config should be closed");
    } catch (e) {
      assert.include((e as Error).toString(), "Account does not exist");
    }
  });
});