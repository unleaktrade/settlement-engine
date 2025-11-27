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

// --- tests (ONLY initRfq) --------------------------------------------------

describe("RFQ", () => {
    const admin = Keypair.generate();
    let configPda: PublicKey;
    let usdcMint: PublicKey;

    before(async () => {
        await fund(admin);

        // 1) Create a real USDC-like mint (6 decimals) owned by admin
        usdcMint = await createMint(
            provider.connection,
            admin,                 // payer
            admin.publicKey,       // mint authority
            null,                  // freeze authority
            6                      // decimals
        );

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
    });

    after(async () => {
        await program.methods
            .closeConfig()
            .accounts({ admin: admin.publicKey, config: configPda })
            .signers([admin])
            .rpc();
    });

    it("creates RFQ PDA with uuid and stores fields", async () => {
        const maker = Keypair.generate();
        await fund(maker);

        const u = uuidBytes();
        const [rfqAddr, bump] = rfqPda(maker.publicKey, u);



        const baseMint = Keypair.generate().publicKey;
        const quoteMint = Keypair.generate().publicKey;

        const commitTTL = 60, revealTTL = 60, selectionTTL = 60, fundingTTL = 60;

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

        const rfq = await program.account.rfq.fetch(rfqAddr);
        assert(rfq.maker.equals(maker.publicKey), "maker mismatch");
        assert.strictEqual(rfq.bump, bump, "bump mismatch");
        assert.deepStrictEqual(rfq.uuid, Array.from(u), "uuid mismatch");
        assert(rfq.baseMint.equals(baseMint), "base mint mismatch");
        assert(rfq.quoteMint.equals(quoteMint), "quote mint mismatch");
        assert.ok(new anchor.BN(1_000_000).eq(rfq.bondAmount), "bond amount mismatch");
        assert.ok(new anchor.BN(1_000_000_000).eq(rfq.baseAmount), "base amount mismatch");
        assert.ok(new anchor.BN(1_000_000_000).eq(rfq.minQuoteAmount), "min quote amount mismatch");
        assert.ok(new anchor.BN(1_000).eq(rfq.feeAmount), "taker fee mismatch");
        assert.strictEqual(rfq.commitTtlSecs, commitTTL);
        assert.strictEqual(rfq.revealTtlSecs, revealTTL);
        assert.strictEqual(rfq.selectionTtlSecs, selectionTTL);
        assert.strictEqual(rfq.fundTtlSecs, fundingTTL);
        assert.strictEqual(rfq.bondsFeesVault, null, "bonds_fees_vault should be None before open");
        assert.strictEqual(rfq.makerPaymentAta, null, "maker_payment_ata should be None before open");
        expect(rfq.state).to.have.property('draft');
        assert.ok(rfq.state.draft);
        expect(rfq.state.open, "state should be draft, not opened").to.be.undefined;
    });

    it("rejects re-init with same (maker, uuid) PDA", async () => {
        const maker = Keypair.generate();
        await fund(maker);

        const u = uuidBytes();
        const baseMint = Keypair.generate().publicKey;
        const quoteMint = Keypair.generate().publicKey;

        await program.methods
            .initRfq(Array.from(u) as any, baseMint, quoteMint, new anchor.BN(1_000_000),
                new anchor.BN(1_000_000_000),
                new anchor.BN(1_000_000_000),
                new anchor.BN(1_000), 1, 1, 1, 1)
            .accounts({ maker: maker.publicKey, config: configPda, usdcMint })
            .signers([maker])
            .rpc();

        // Second init with same seeds should fail (account already in use)
        let failed = false;
        try {
            await program.methods
                .initRfq(Array.from(u) as any, baseMint, quoteMint, new anchor.BN(1_000_000),
                    new anchor.BN(1_000_000_000),
                    new anchor.BN(1_000_000_000),
                    new anchor.BN(1_000), 1, 1, 1, 1)
                .accounts({ maker: maker.publicKey, config: configPda, usdcMint })
                .signers([maker])
                .rpc();
        } catch {
            failed = true;
        }
        assert(failed, "re-initialization with same (maker, uuid) should fail");
    });

    it("rejects RFQ with 0 bond/fee/base/quote", async () => {
        const maker = Keypair.generate();
        await fund(maker);

        const u = uuidBytes();
        const baseMint = Keypair.generate().publicKey;
        const quoteMint = Keypair.generate().publicKey;

        let failed = false;
        try {
            await program.methods
                .initRfq(Array.from(u) as any, baseMint, quoteMint, new anchor.BN(0),
                    new anchor.BN(1_000_000_000),
                    new anchor.BN(1_000_000_000),
                    new anchor.BN(1_000), 1, 1, 1, 1)
                .accounts({ maker: maker.publicKey, config: configPda, usdcMint })
                .signers([maker])
                .rpc();
        } catch {
            failed = true;
        }
        assert(failed, "cannot create RFQ with zero bond amount");

        failed = false;
        try {
            await program.methods
                .initRfq(Array.from(u) as any, baseMint, quoteMint, new anchor.BN(1_000_000),
                    new anchor.BN(0),
                    new anchor.BN(1_000_000_000),
                    new anchor.BN(1_000), 1, 1, 1, 1)
                .accounts({ maker: maker.publicKey, config: configPda, usdcMint })
                .signers([maker])
                .rpc();
        } catch {
            failed = true;
        }
        assert(failed, "cannot create RFQ with zero base amount");

        failed = false;
        try {
            await program.methods
                .initRfq(Array.from(u) as any, baseMint, quoteMint, new anchor.BN(1_000_000),
                    new anchor.BN(1_000_000_000),
                    new anchor.BN(0),
                    new anchor.BN(1_000), 1, 1, 1, 1)
                .accounts({ maker: maker.publicKey, config: configPda, usdcMint })
                .signers([maker])
                .rpc();
        } catch {
            failed = true;
        }
        assert(failed, "cannot create RFQ with zero quote amount");

        failed = false;
        try {
            await program.methods
                .initRfq(Array.from(u) as any, baseMint, quoteMint, new anchor.BN(1_000_000),
                    new anchor.BN(1_000_000_000),
                    new anchor.BN(1_000_000_000),
                    new anchor.BN(0), 1, 1, 1, 1)
                .accounts({ maker: maker.publicKey, config: configPda, usdcMint })
                .signers([maker])
                .rpc();
        } catch {
            failed = true;
        }
        assert(failed, "cannot create RFQ with zero fee amount");
    });

    it("allows same uuid with different makers (different PDA)", async () => {
        const makerA = Keypair.generate();
        const makerB = Keypair.generate();
        await Promise.all([fund(makerA), fund(makerB)]);

        const u = uuidBytes();
        const [pdaA] = rfqPda(makerA.publicKey, u);
        const [pdaB] = rfqPda(makerB.publicKey, u);
        assert(!pdaA.equals(pdaB), "PDAs should differ across makers for same uuid");

        const baseMint = Keypair.generate().publicKey;
        const quoteMint = Keypair.generate().publicKey;

        await program.methods
            .initRfq(Array.from(u) as any, baseMint, quoteMint, new anchor.BN(1_000_000),
                new anchor.BN(1_000_000_000),
                new anchor.BN(1_000_000_000),
                new anchor.BN(1_000), 1, 1, 1, 1)
            .accounts({ maker: makerA.publicKey, config: configPda, usdcMint })
            .signers([makerA])
            .rpc();

        await program.methods
            .initRfq(Array.from(u) as any, baseMint, quoteMint, new anchor.BN(1_000_000),
                new anchor.BN(1_000_000_000),
                new anchor.BN(1_000_000_000),
                new anchor.BN(1_000), 1, 1, 1, 1)
            .accounts({ maker: makerB.publicKey, config: configPda, usdcMint })
            .signers([makerB])
            .rpc();

        const [a, b] = await Promise.all([
            program.account.rfq.fetch(pdaA),
            program.account.rfq.fetch(pdaB),
        ]);
        assert(a.maker.equals(makerA.publicKey));
        assert.deepStrictEqual(a.uuid, Array.from(u), "uuid mismatch for rfq a");
        assert(b.maker.equals(makerB.publicKey));
        assert.deepStrictEqual(b.uuid, Array.from(u), "uuid mismatch for rfq b");
    });

    it("allows same maker with different uuids (multiple RFQs per maker)", async () => {
        const maker = Keypair.generate();
        await fund(maker);

        const baseMint = Keypair.generate().publicKey;
        const quoteMint = Keypair.generate().publicKey;

        // uuid 1
        const u1 = uuidBytes();
        const [pda1] = rfqPda(maker.publicKey, u1);

        await program.methods
            .initRfq(Array.from(u1) as any, baseMint, quoteMint, new anchor.BN(1_000_000),
                new anchor.BN(1_000_000_000),
                new anchor.BN(1_000_000_000),
                new anchor.BN(1_000), 1, 1, 1, 1)
            .accounts({ maker: maker.publicKey, config: configPda, usdcMint })
            .signers([maker])
            .rpc();

        // uuid 2
        const u2 = uuidBytes();
        const [pda2] = rfqPda(maker.publicKey, u2);
        assert(!pda1.equals(pda2), "Different uuids must produce different PDAs for same maker");

        await program.methods
            .initRfq(Array.from(u2) as any, baseMint, quoteMint, new anchor.BN(1_000_000),
                new anchor.BN(1_000_000_000),
                new anchor.BN(1_000_000_000),
                new anchor.BN(1_000), 1, 1, 1, 1)
            .accounts({ maker: maker.publicKey, config: configPda, usdcMint })
            .signers([maker])
            .rpc();

        const [r1, r2] = await Promise.all([
            program.account.rfq.fetch(pda1),
            program.account.rfq.fetch(pda2),
        ]);
        assert.ok(new anchor.BN(1_000_000).eq(r1.bondAmount), "bond amount mismatch");
        assert.deepStrictEqual(r1.uuid, Array.from(u1), "uuid mismatch for rfq r1");
        assert.ok(new anchor.BN(1_000_000).eq(r2.bondAmount), "bond amount mismatch");
        assert.deepStrictEqual(r2.uuid, Array.from(u2), "uuid mismatch for rfq r2");
    });

    it("updates RFQ", async () => {
        const maker = Keypair.generate();
        await fund(maker);

        const u = uuidBytes();
        const [rfqAddr, bump] = rfqPda(maker.publicKey, u);

        const baseMint = Keypair.generate().publicKey;
        const quoteMint = Keypair.generate().publicKey;

        console.log("maker:", maker.publicKey.toBase58());
        console.log("rfqAddr:", rfqAddr.toBase58());
        console.log("baseMint:", baseMint.toBase58());
        console.log("quoteMint:", quoteMint.toBase58());

        const commitTTL = 60, revealTTL = 60, selectionTTL = 60, fundingTTL = 60;

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

        await program.methods
            .updateRfq(
                quoteMint, // flip base/quote mints
                baseMint,
                new anchor.BN(1_000_001),
                new anchor.BN(1_000_000_001),
                new anchor.BN(1_000_000_001),
                new anchor.BN(1_001),
                commitTTL + 1,
                revealTTL + 1,
                selectionTTL + 1,
                null //skip funding TTL update
            )
            .accounts({
                maker: maker.publicKey,
                rfq: rfqAddr,
            })
            .signers([maker])
            .rpc();

        const rfq = await program.account.rfq.fetch(rfqAddr);
        assert(rfq.maker.equals(maker.publicKey), "maker mismatch");
        assert.strictEqual(rfq.bump, bump, "bump mismatch");
        assert.deepStrictEqual(rfq.uuid, Array.from(u), "uuid mismatch");
        assert(rfq.baseMint.equals(quoteMint), "base mint mismatch");
        assert(rfq.quoteMint.equals(baseMint), "quote mint mismatch");
        assert.ok(new anchor.BN(1_000_001).eq(rfq.bondAmount), "bond amount mismatch");
        assert.ok(new anchor.BN(1_000_000_001).eq(rfq.baseAmount), "base amount mismatch");
        assert.ok(new anchor.BN(1_000_000_001).eq(rfq.minQuoteAmount), "min quote amount mismatch");
        assert.ok(new anchor.BN(1_001).eq(rfq.feeAmount), "taker fee mismatch");
        assert.strictEqual(rfq.commitTtlSecs, commitTTL + 1);
        assert.strictEqual(rfq.revealTtlSecs, revealTTL + 1);
        assert.strictEqual(rfq.selectionTtlSecs, selectionTTL + 1);
        assert.strictEqual(rfq.fundTtlSecs, fundingTTL); // unchanged
        assert.strictEqual(rfq.bondsFeesVault, null, "bonds_fees_vault should be None before open");
        assert.strictEqual(rfq.makerPaymentAta, null, "maker_payment_ata should be None before open");
        expect(rfq.state).to.have.property('draft');
        assert.ok(rfq.state.draft);
        expect(rfq.state.open, "state should be draft, not open").to.be.undefined;
    });

    it("opens RFQ", async () => {
        const maker = Keypair.generate();
        await fund(maker);

        const u = uuidBytes();
        const [rfqAddr, bump] = rfqPda(maker.publicKey, u);

        const bondsFeesVault = getAssociatedTokenAddressSync(usdcMint, rfqAddr, true);
        const makerPaymentAta = getAssociatedTokenAddressSync(usdcMint, maker.publicKey);

        const baseMint = Keypair.generate().publicKey;
        const quoteMint = Keypair.generate().publicKey;

        console.log("maker:", maker.publicKey.toBase58());
        console.log("rfqAddr:", rfqAddr.toBase58());
        console.log("bondsFeesVault:", bondsFeesVault.toBase58());
        console.log("baseMint:", baseMint.toBase58());
        console.log("quoteMint:", quoteMint.toBase58());

        const commitTTL = 60, revealTTL = 60, selectionTTL = 60, fundingTTL = 60;

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

        await program.methods
            .openRfq()
            .accounts({
                maker: maker.publicKey,
                rfq: rfqAddr,
                config: configPda,
                bondsFeesVault,
                makerPaymentAta,
                usdcMint,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([maker])
            .rpc();

        const rfq = await program.account.rfq.fetch(rfqAddr);
        assert(rfq.maker.equals(maker.publicKey), "maker mismatch");
        assert.strictEqual(rfq.bump, bump, "bump mismatch");
        assert.deepStrictEqual(rfq.uuid, Array.from(u), "uuid mismatch");
        assert(rfq.baseMint.equals(baseMint), "base mint mismatch");
        assert(rfq.quoteMint.equals(quoteMint), "quote mint mismatch");
        assert.ok(new anchor.BN(1_000_000).eq(rfq.bondAmount), "bond amount mismatch");
        assert.ok(new anchor.BN(1_000_000_000).eq(rfq.baseAmount), "base amount mismatch");
        assert.ok(new anchor.BN(1_000_000_000).eq(rfq.minQuoteAmount), "min quote amount mismatch");
        assert.ok(new anchor.BN(1_000).eq(rfq.feeAmount), "taker fee mismatch");
        assert.strictEqual(rfq.commitTtlSecs, commitTTL);
        assert.strictEqual(rfq.revealTtlSecs, revealTTL);
        assert.strictEqual(rfq.selectionTtlSecs, selectionTTL);
        assert.strictEqual(rfq.fundTtlSecs, fundingTTL);
        assert(rfq.bondsFeesVault.equals(bondsFeesVault), "bonds_fees_vault mismatch");
        assert(rfq.makerPaymentAta.equals(makerPaymentAta), "maker_payment_ata mismatch");
        expect(rfq.state).to.have.property('open');
        assert.ok(rfq.state.open);
        expect(rfq.state.draft, "state should be open, not draft").to.be.undefined;

        // Should fail to re-open
        let failed = false;
        try {
            await program.methods
                .openRfq()
                .accounts({
                    maker: maker.publicKey,
                    rfq: rfqAddr,
                    config: configPda,
                    bondsFeesVault,
                    makerPaymentAta,
                    usdcMint,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([maker])
                .rpc();
        } catch {
            failed = true;
        }
        assert(failed, "re-open an existing RFQ should fail");

        // Should fail to update after opened
        failed = false;
        try {
            await program.methods
                .updateRfq(
                    quoteMint, // flip base/quote mints
                    baseMint,
                    new anchor.BN(1_000_001),
                    new anchor.BN(1_000_000_001),
                    new anchor.BN(1_000_000_001),
                    new anchor.BN(1_001),
                    commitTTL + 1,
                    revealTTL + 1,
                    selectionTTL + 1,
                    null //skip funding TTL update
                )
                .accounts({
                    maker: maker.publicKey,
                    rfq: rfqAddr,
                })
                .signers([maker])
                .rpc();
        } catch {
            failed = true;
        }
        assert(failed, "update on opened RFQ should fail");

        // should fail to cancel after opened
        failed = false;
        try {
            await program.methods
                .cancelRfq()
                .accounts({
                    maker: maker.publicKey,
                    rfq: rfqAddr,
                })
                .signers([maker])
                .rpc();
        } catch {
            failed = true;
        }
        assert(failed, "cancel on opened RFQ should fail");
    });

    it("should close RFQ", async () => {
        const maker = Keypair.generate();
        await fund(maker);

        const u = uuidBytes();
        const [rfqAddr, bump] = rfqPda(maker.publicKey, u);

        const bondsFeesVault = getAssociatedTokenAddressSync(usdcMint, rfqAddr, true);

        const baseMint = Keypair.generate().publicKey;
        const quoteMint = Keypair.generate().publicKey;

        console.log("maker:", maker.publicKey.toBase58());
        console.log("rfqAddr:", rfqAddr.toBase58());
        console.log("bondsFeesVault:", bondsFeesVault.toBase58());
        console.log("baseMint:", baseMint.toBase58());
        console.log("quoteMint:", quoteMint.toBase58());

        const commitTTL = 60, revealTTL = 60, selectionTTL = 60, fundingTTL = 60;

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

        await program.methods
            .cancelRfq()
            .accounts({
                maker: maker.publicKey,
                rfq: rfqAddr,
            })
            .signers([maker])
            .rpc();

        // Should not be able to fetch the RFQ anymore
        let failed = false;
        try {
            await program.account.rfq.fetch(rfqAddr);
        } catch {
            failed = true;
        }
        assert(failed, "RFQ should be cancelled and not fetchable anymore");

    });
});
