import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SettlementEngine } from "../target/types/settlement_engine";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
    createMint,
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { v4 as uuidv4, parse as uuidParse } from "uuid";
import assert from "assert";
import { expect } from "chai";
import { config } from "process";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;
const program = anchor.workspace.SettlementEngine as Program<SettlementEngine>;
// --- helpers ---------------------------------------------------------------

async function confirm(signature: string) {
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...bh });
}

async function fund(kp: Keypair, sol = 2) {
    const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        sol * anchor.web3.LAMPORTS_PER_SOL
    );
    await confirm(sig);
}

/** Derive RFQ PDA from (maker, uuid) */
const rfqPda = (maker: PublicKey, u16: Uint8Array) =>
    PublicKey.findProgramAddressSync(
        [Buffer.from("rfq"), maker.toBuffer(), Buffer.from(u16)],
        program.programId
    );

const uuidBytes = () => Uint8Array.from(uuidParse(uuidv4()));
const liquidityGuardURL = "https://liquidity-guard-devnet-skip-c644b6411603.herokuapp.com";

// --- tests (ONLY initRfq) --------------------------------------------------

describe("QUOTE", () => {
    const admin = Keypair.generate();
    const maker = Keypair.generate();

    let configPda: PublicKey;
    let usdcMint: PublicKey;
    let rfqPDA: PublicKey;

    before(async () => {
        await fund(admin);
        await fund(maker);

        // 1) Create a real USDC-like mint (6 decimals) owned by admin
        usdcMint = await createMint(
            provider.connection,
            admin,                 // payer
            admin.publicKey,       // mint authority
            null,                  // freeze authority
            6                      // decimals
        );

        console.log("USDC mint:", usdcMint.toBase58());

        // 2) Ensure config exists and points to that mint
        [configPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("config")],
            program.programId
        );
        let needInit = false;
        try {
            await program.account.config.fetch(configPda);
        } catch { needInit = true; }
        if (needInit) {
            const treasury = Keypair.generate().publicKey;
            const liquidityGuard = new PublicKey("5gfPFweV3zJovznZqBra3rv5tWJ5EHVzQY1PqvNA4HGg");
            await program.methods
                .initConfig(usdcMint, treasury, liquidityGuard)
                .accounts({ admin: admin.publicKey })
                .signers([admin])
                .rpc();
        }

        const u = uuidBytes();
        const [rfqAddr, bump] = rfqPda(maker.publicKey, u);


        needInit = false;
        try {
            await program.account.rfq.fetch(rfqAddr);
        } catch { needInit = true; }
        if (needInit) {
            // bonds_vault = ATA(owner = rfq PDA, mint = usdcMint)
            const bondsVault = getAssociatedTokenAddressSync(usdcMint, rfqAddr, true);

            const baseMint = Keypair.generate().publicKey;
            const quoteMint = Keypair.generate().publicKey;

            const commitTTL = 3, revealTTL = 3, selectionTTL = 3, fundingTTL = 3;
            await program.methods
                .initRfq(
                    Array.from(u),
                    baseMint,
                    quoteMint,
                    new anchor.BN(1_000_000),
                    new anchor.BN(1_000_000_000),
                    new anchor.BN(1_000_000_000),
                    new anchor.BN(1_000),
                    commitTTL,
                    revealTTL,
                    selectionTTL,
                    fundingTTL
                )
                .accounts({
                    maker: maker.publicKey,
                    config: configPda,
                    usdcMint
                })
                .signers([maker])
                .rpc();
        }

        console.log("RFQ PDA:", rfqAddr.toBase58());

    });

    after(async () => {
        await program.methods
            .closeConfig()
            .accounts({ admin: admin.publicKey, config: configPda })
            .signers([admin])
            .rpc();
    });

    it("commits a quote", async () => {
        const taker = Keypair.generate();
        await fund(taker);
    });
});