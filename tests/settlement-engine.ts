import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SettlementEngine } from "../target/types/settlement_engine";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { v4 as uuidv4, parse as uuidParse } from "uuid";
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

describe("settlement-engine", () => {
  it("creates RFQ PDA and stores fields (owner/uuid/bump)", async () => {
    const payer = Keypair.generate();
    await fund(payer);

    // 16-byte UUID
    const uuidStr = uuidv4();
    const uuidBytes = uuidParse(uuidStr); // Uint8Array(16)

    // Pre-compute PDA only for verification (don't pass it to .accounts)
    const [rfqPda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("rfq"), payer.publicKey.toBuffer(), Buffer.from(uuidBytes)],
      program.programId
    );

    // Call instruction (PDA auto-derived)
    const tx = await program.methods
      .initializeRfq(Array.from(uuidBytes))
      .accountsPartial({
        signer: payer.publicKey,
        // systemProgram: SystemProgram.programId, // optional
      })
      .signers([payer])
      .rpc();

    // Verify
    const rfq = await program.account.rfq.fetch(rfqPda);

    assert(rfq.owner.equals(payer.publicKey), "owner mismatch");
    assert.strictEqual(rfq.bump, bump, "bump mismatch");

    // UUID equality (byte-by-byte)
    const stored = rfq.uuid as number[];
    assert.strictEqual(stored.length, 16, "uuid len != 16");
    for (let i = 0; i < 16; i++) {
      assert.strictEqual(stored[i], uuidBytes[i], `uuid byte mismatch @${i}`);
    }

    // created_at sanity
    const createdBn = anchor.BN.isBN(rfq.createdAt)
      ? rfq.createdAt
      : new anchor.BN(rfq.createdAt);
    assert(createdBn.gtn(0), "created_at invalid");


    console.log("PDA account created:", { tx, rfqPda: rfqPda.toBase58(), uuid: uuidStr });
  });

  it("rejects re-initialization with same (signer, uuid)", async () => {
    const payer = Keypair.generate();
    await fund(payer);

    const uuidStr = uuidv4();
    const uuidBytes = uuidParse(uuidStr);

    const [rfqPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("rfq"), payer.publicKey.toBuffer(), Buffer.from(uuidBytes)],
      program.programId
    );

    // First init
    await program.methods
      .initializeRfq(Array.from(uuidBytes))
      .accountsPartial({ signer: payer.publicKey })
      .signers([payer])
      .rpc();

    // Re-init should fail (account already exists)
    let failed = false;
    try {
      await program.methods
        .initializeRfq(Array.from(uuidBytes))
        .accountsPartial({ signer: payer.publicKey })
        .signers([payer])
        .rpc();
    } catch (e) {
      failed = true;
      // Optional: console.log("expected re-init error:", (e as any)?.toString?.());
    }
    assert(failed, "re-initialize should have failed");
    // Optional sanity fetch
    const rfq = await program.account.rfq.fetch(rfqPda);
    assert(rfq.owner.equals(payer.publicKey));
  });

  it("allows the same UUID with different signers (different PDA)", async () => {
    const signerA = Keypair.generate();
    const signerB = Keypair.generate();

    // Parallel fund for speed
    await Promise.all([fund(signerA), fund(signerB)]);

    const uuidStr = uuidv4();
    const uuidBytes = uuidParse(uuidStr);

    const [pdaA] = PublicKey.findProgramAddressSync(
      [Buffer.from("rfq"), signerA.publicKey.toBuffer(), Buffer.from(uuidBytes)],
      program.programId
    );
    const [pdaB] = PublicKey.findProgramAddressSync(
      [Buffer.from("rfq"), signerB.publicKey.toBuffer(), Buffer.from(uuidBytes)],
      program.programId
    );

    assert(!pdaA.equals(pdaB), "PDAs should differ for different signers");

    // Initialize both (omit rfq; Anchor derives)
    await program.methods
      .initializeRfq(Array.from(uuidBytes))
      .accountsPartial({ signer: signerA.publicKey })
      .signers([signerA])
      .rpc();

    await program.methods
      .initializeRfq(Array.from(uuidBytes))
      .accountsPartial({ signer: signerB.publicKey })
      .signers([signerB])
      .rpc();

    const [a, b] = await Promise.all([
      program.account.rfq.fetch(pdaA),
      program.account.rfq.fetch(pdaB),
    ]);

    assert(a.owner.equals(signerA.publicKey), "owner A mismatch");
    assert(b.owner.equals(signerB.publicKey), "owner B mismatch");
  });
});
