import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SettlementEngine } from "../target/types/settlement_engine";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { v4 as uuidv4, parse as uuidParse } from "uuid";

describe("settlement-engine", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  const program = anchor.workspace.SettlementEngine as Program<SettlementEngine>;

  it("initializes an RFQ PDA with a UUID", async () => {
    const payer = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      payer.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction({
      signature: sig,
      ...(await provider.connection.getLatestBlockhash()),
    });

    const uuidStr = uuidv4();
    const uuidBytes = uuidParse(uuidStr); // Uint8Array(16)

    const [rfqPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("rfq"), payer.publicKey.toBuffer(), Buffer.from(uuidBytes)],
      program.programId
    );

    const tx = await program.methods
      .initializeRfq(Array.from(uuidBytes)) // [u8;16]
      .accounts({
        // rfq: rfqPda, // old anchor version
        signer: payer.publicKey,
        // systemProgram: SystemProgram.programId, // optional; Anchor defaults it
      })
      .signers([payer])
      .rpc();

    console.log("tx:", tx, "rfqPda:", rfqPda.toBase58(), "uuid:", uuidStr);
  });
});
