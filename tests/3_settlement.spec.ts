import * as anchor from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import { Program } from "@coral-xyz/anchor";
import { SettlementEngine } from "../target/types/settlement_engine";
import { Ed25519Program, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
    createMint,
    getAssociatedTokenAddressSync,
    mintTo,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import assert from "assert";
import { CheckResult, fetchJson, sleep, waitForLiquidityGuardReady } from "./2_quote.spec";
import { waitForChainTime } from "./utils/time";
import { slashedBondsTrackerPda, uuidBytes } from "./1_rfq.spec";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;
const program = anchor.workspace.SettlementEngine as Program<SettlementEngine>;

const liquidityGuardURL = "https://liquidity-guard-devnet-skip-c644b6411603.herokuapp.com";
const liquidityGuard = new PublicKey("5gfPFweV3zJovznZqBra3rv5tWJ5EHVzQY1PqvNA4HGg");
const DEFAULT_QUOTE_AMOUNT = 1_000_000_001;
const DEFAULT_BASE_AMOUNT = 1_000_000_000;
const DEFAULT_BOND_AMOUNT = 1_000_000;
const DEFAULT_FEE_AMOUNT = 1_000;

const confirm = async (signature: string) => {
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...bh });
};

const fund = async (kp: Keypair, sol = 2) => {
    const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        sol * anchor.web3.LAMPORTS_PER_SOL
    );
    await confirm(sig);
};

/** Derive RFQ PDA from (maker, uuid) */
const rfqPda = (maker: PublicKey, u16: Uint8Array) =>
    PublicKey.findProgramAddressSync(
        [Buffer.from("rfq"), maker.toBuffer(), Buffer.from(u16)],
        program.programId
    );

const settlementPda = (rfqPDA: PublicKey) => PublicKey.findProgramAddressSync(
    [Buffer.from("settlement"), rfqPDA.toBuffer()],
    program.programId
);

const feesTrackerPda = (rfqPDA: PublicKey) => PublicKey.findProgramAddressSync(
    [Buffer.from("fees_tracker"), rfqPDA.toBuffer()],
    program.programId
);

const getAndLogBalance = async (label: string, owner: string, tokenAccount: PublicKey) => {
    const balance = await provider.connection.getTokenAccountBalance(tokenAccount).then(b => new anchor.BN(b.value.amount));
    console.log(`${label} - ${owner}:`, balance.toNumber().toLocaleString("en-US"));
    return balance;
};

const provideLiquidityGuardAttestation = async (taker: anchor.web3.Keypair,
    rfqPDA: anchor.web3.PublicKey,
    quoteMint: anchor.web3.PublicKey,
    quoteAmount = DEFAULT_QUOTE_AMOUNT,
    bondAmount = DEFAULT_BOND_AMOUNT,
    feeAmount = DEFAULT_FEE_AMOUNT) => {
    const rfqAddr = Buffer.from(rfqPDA.toBytes());
    const salt = nacl.sign.detached(rfqAddr, taker.secretKey);
    console.log("salt:", Buffer.from(salt).toString("hex"));

    const payload = {
        rfq: rfqPDA.toBase58(),
        taker: taker.publicKey.toBase58(),
        salt: Buffer.from(salt).toString("hex"),
        quote_mint: quoteMint.toBase58(),
        quote_amount: new anchor.BN(quoteAmount).toString(),
        bond_amount_usdc: new anchor.BN(bondAmount).toString(),
        fee_amount_usdc: new anchor.BN(feeAmount).toString(),
    };

    const response = await fetchJson<CheckResult>(`${liquidityGuardURL}/check`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });
    if ("error" in response) {
        throw new Error(`Liquidity Guard error: ${response.error}`);
    } else {
        return [
            salt,
            Buffer.from(response.commit_hash, "hex"),
            Buffer.from(response.liquidity_proof, "hex"),
        ];
    }
};

const commitQuote = async (
    commit_hash: Uint8Array<ArrayBufferLike> | Buffer<ArrayBuffer>,
    liquidity_proof: Uint8Array<ArrayBufferLike> | Buffer<ArrayBuffer>,
    taker: Keypair,
    rfqPDA: PublicKey,
    usdcMint: PublicKey,
    configPda: PublicKey,
    takerPaymentAccount: PublicKey,
    facilitator: PublicKey | null = null) => {
    // Create Ed25519 verification instruction using the helper
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
        publicKey: liquidityGuard.toBytes(),
        message: commit_hash,
        signature: liquidity_proof,
    });
    const commitQuoteIx1 = await program.methods
        .commitQuote(Array.from(commit_hash), Array.from(liquidity_proof), facilitator)
        .accounts({
            taker: taker.publicKey,
            rfq: rfqPDA,
            usdcMint: usdcMint,
            config: configPda,
            instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
            takerPaymentAccount: takerPaymentAccount,
        })
        .instruction();

    const tx = new anchor.web3.Transaction();
    // Add ONLY these two instructions, in this exact order:
    tx.add(ed25519Ix);
    tx.add(commitQuoteIx1);

    // Send and confirm
    const txSig = await provider.sendAndConfirm(tx, [taker], { skipPreflight: false });
    console.log("Transaction signature:", txSig);
};

describe("COMPLETE_SETTLEMENT", () => {
    let configPda: PublicKey;
    let usdcMint: PublicKey;
    let baseMint: PublicKey;
    let quoteMint: PublicKey;

    const admin = Keypair.generate();
    const treasury = Keypair.generate();
    const commitTTL = 10, revealTTL = 10, selectionTTL = 10, fundingTTL = 20;


    before(async () => {
        await waitForLiquidityGuardReady();
        await fund(admin);

        // Mint USDC, base, quote mints
        [usdcMint, baseMint, quoteMint] = await Promise.all(
            [6, 9, 9].map(d => createMint(
                provider.connection,
                admin,                 // payer
                admin.publicKey,       // mint authority
                null,                  // freeze authority
                d                      // decimals
            )));

        console.log("USDC mint:", usdcMint.toBase58());
        console.log("Base mint:", baseMint.toBase58());
        console.log("Quote mint:", quoteMint.toBase58());

        [configPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("config")],
            program.programId
        );


        let failed = false;
        try {
            await program.methods
                .initConfig(usdcMint, treasury.publicKey, liquidityGuard, null)
                .accounts({ admin: admin.publicKey })
                .signers([admin])
                .rpc();
        } catch (e) {
            failed = true;
            console.log("initConfig failed (probably already initialized):", e);
        }
        assert.equal(failed, false, "initConfig failed");
        console.log("Config PDA:", configPda.toBase58());
    });

    after(async () => {
        // console.log("All CONFIG:", JSON.stringify((await program.account.config.all()), null, 2));
        // console.log("All RFQ:", JSON.stringify((await program.account.rfq.all()), null, 2));
        // console.log("All QUOTE:", JSON.stringify((await program.account.quote.all()), null, 2));
        // console.log("All COMMIT GUARDS:", JSON.stringify((await program.account.commitGuard.all()), null, 2));
        // console.log("All SETTLEMENT:", JSON.stringify((await program.account.settlement.all()), null, 2));
        // console.log("All FEES_TRAKER:", JSON.stringify((await program.account.feesTracker.all()), null, 2));
        // console.log("All SLASHED_BONDS_TRAKER:", JSON.stringify((await program.account.slashedBondsTracker.all()), null, 2));
        await program.methods
            .closeConfig()
            .accounts({ admin: admin.publicKey, config: configPda })
            .signers([admin])
            .rpc();
    });

    it("should complete settlement", async () => {
        const maker = Keypair.generate();
        await fund(maker);
        console.log("Maker:", maker.publicKey.toBase58());
        const [taker, taker2] = [Keypair.generate(), Keypair.generate()];
        await Promise.all([fund(taker), fund(taker2)]);
        console.log("Taker:", taker.publicKey.toBase58());
        console.log("Taker2:", taker2.publicKey.toBase58());

        const u = uuidBytes();
        const [rfqPDA, rfqBump] = rfqPda(maker.publicKey, u);
        const [settlementPDA, bumpSettlement] = settlementPda(rfqPDA);
        const [feesTrackerPDA, bumpFeesTracker] = feesTrackerPda(rfqPDA);
        const [slashedBondsTrackerPDA, bumpslashedBondsTracker] = slashedBondsTrackerPda(rfqPDA);

        // create token accounts & mint usdc, base and quote.
        const makerPaymentAccount = getAssociatedTokenAddressSync(usdcMint, maker.publicKey);
        const makerBaseAccount = getAssociatedTokenAddressSync(baseMint, maker.publicKey);
        const makerQuoteAccount = getAssociatedTokenAddressSync(quoteMint, maker.publicKey);
        const takerPaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker.publicKey);
        const taker2PaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker2.publicKey);
        const takerBaseAccount = getAssociatedTokenAddressSync(baseMint, taker.publicKey);
        const takerQuoteAccount = getAssociatedTokenAddressSync(quoteMint, taker.publicKey);
        const bondsFeesVault = getAssociatedTokenAddressSync(usdcMint, rfqPDA, true);
        const baseVault = getAssociatedTokenAddressSync(baseMint, rfqPDA, true);
        const treasuryPaymentAccount = getAssociatedTokenAddressSync(usdcMint, treasury.publicKey);

        // mint USDC for bonds
        await Promise.all([
            await getOrCreateAssociatedTokenAccount(
                provider.connection,
                admin,
                usdcMint,
                maker.publicKey
            ).then(account => mintTo(
                provider.connection,
                admin,
                usdcMint,
                account.address,
                admin,
                DEFAULT_BOND_AMOUNT
            )),
            await getOrCreateAssociatedTokenAccount(
                provider.connection,
                admin,
                baseMint,
                maker.publicKey
            ).then(account => mintTo(
                provider.connection,
                admin,
                baseMint,
                account.address,
                admin,
                DEFAULT_BASE_AMOUNT
            )),
            await getOrCreateAssociatedTokenAccount(
                provider.connection,
                admin,
                usdcMint,
                taker.publicKey
            ).then(account => mintTo(
                provider.connection,
                admin,
                usdcMint,
                account.address,
                admin,
                DEFAULT_BOND_AMOUNT + DEFAULT_FEE_AMOUNT //sufficient for bonds + fees
            )),
            await getOrCreateAssociatedTokenAccount(
                provider.connection,
                admin,
                usdcMint,
                taker2.publicKey
            ).then(account => mintTo(
                provider.connection,
                admin,
                usdcMint,
                account.address,
                admin,
                DEFAULT_BOND_AMOUNT + DEFAULT_FEE_AMOUNT //sufficient for bonds + fees
            )),
            await getOrCreateAssociatedTokenAccount(
                provider.connection,
                admin,
                quoteMint,
                taker.publicKey
            ).then(account => mintTo(
                provider.connection,
                admin,
                quoteMint,
                account.address,
                admin,
                DEFAULT_QUOTE_AMOUNT
            )),
        ]);

        await Promise.all([
            getAndLogBalance("Before Init RFQ", "Maker USDC", makerPaymentAccount),
            getAndLogBalance("Before Init RFQ", "Maker Base", makerBaseAccount),
            getAndLogBalance("Before Init RFQ", "Taker USDC", takerPaymentAccount),
            getAndLogBalance("Before Init RFQ", "Taker2 USDC", taker2PaymentAccount),
            getAndLogBalance("Before Init RFQ", "Taker Quote", takerQuoteAccount),
        ]);

        //INIT RFQ
        let failed = false;
        try {
            await program.methods
                .initRfq(
                    Array.from(u),
                    baseMint,
                    quoteMint,
                    new anchor.BN(DEFAULT_BOND_AMOUNT),
                    new anchor.BN(DEFAULT_BASE_AMOUNT),
                    new anchor.BN(1_000_000_000),
                    new anchor.BN(DEFAULT_FEE_AMOUNT),
                    commitTTL,
                    revealTTL,
                    selectionTTL,
                    fundingTTL,
                    null
                )
                .accounts({
                    maker: maker.publicKey,
                    config: configPda,
                    usdcMint,
                    bondsFeesVault,
                    makerPaymentAccount,
                    systemProgram: SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                })
                .signers([maker])
                .rpc();
        } catch (e) {
            failed = true;
            console.log("initRfq failed:", e);
        }

        await getAndLogBalance("Before opening RFQ", "RFQ Bonds Vault", bondsFeesVault);

        console.log("Rfq PDA:", rfqPDA.toBase58());
        console.log("Slashed Bonds Tracker PDA", slashedBondsTrackerPDA.toBase58());
        //OPEN RFQ
        failed = false;
        try {
            await program.methods.openRfq()
                .accounts({
                    maker: maker.publicKey,
                    rfq: rfqPDA,
                    config: configPda,
                    bondsFeesVault,
                    makerPaymentAccount,
                    usdcMint,
                })
                .signers([maker])
                .rpc();
        } catch (e) {
            failed = true;
            console.log("openRfq failed:", e);
        }
        await Promise.all([
            getAndLogBalance("After opening RFQ", "Maker USDC", makerPaymentAccount),
            getAndLogBalance("After opening RFQ", "Taker USDC", takerPaymentAccount),
            getAndLogBalance("After opening RFQ", "RFQ Bonds Vault", bondsFeesVault),
        ]);

        const [saltQ1, commit_hashQ1, liquidity_proofQ1] = await provideLiquidityGuardAttestation(taker, rfqPDA, quoteMint);
        await commitQuote(
            commit_hashQ1,
            liquidity_proofQ1,
            taker,
            rfqPDA,
            usdcMint,
            configPda,
            takerPaymentAccount);

        // taker2 will commit an invalid quote (smaller quote amount)
        const [saltQ2, commit_hashQ2, liquidity_proofQ2] = await provideLiquidityGuardAttestation(taker2, rfqPDA, quoteMint, DEFAULT_QUOTE_AMOUNT / 10);
        await commitQuote(
            commit_hashQ2,
            liquidity_proofQ2,
            taker2,
            rfqPDA,
            usdcMint,
            configPda,
            taker2PaymentAccount);

        const [quotePda] = PublicKey.findProgramAddressSync(
            [Buffer.from("quote"), rfqPDA.toBuffer(), taker.publicKey.toBuffer()],
            program.programId
        );
        console.log("Quote PDA:", quotePda.toBase58());

        const [commitGuardPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("commit-guard"), commit_hashQ1],
            program.programId
        );
        console.log("Commit Guard PDA:", commitGuardPda.toBase58());

        const [quote2Pda] = PublicKey.findProgramAddressSync(
            [Buffer.from("quote"), rfqPDA.toBuffer(), taker2.publicKey.toBuffer()],
            program.programId
        );
        console.log("Quote2 PDA:", quote2Pda.toBase58());

        const [commitGuard2Pda] = PublicKey.findProgramAddressSync(
            [Buffer.from("commit-guard"), commit_hashQ2],
            program.programId
        );
        console.log("Commit Guard 2 PDA:", commitGuard2Pda.toBase58());

        await Promise.all([
            getAndLogBalance("After commiting quote", "Maker USDC", makerPaymentAccount),
            getAndLogBalance("After commiting quote", "Taker USDC", takerPaymentAccount),
            getAndLogBalance("After commiting quote", "Taker2 USDC", taker2PaymentAccount),
            getAndLogBalance("After commiting quote", "RFQ Bonds Vault", bondsFeesVault),
        ]);

        const rfqAfterCommit = await program.account.rfq.fetch(rfqPDA);

        const openedAt = rfqAfterCommit.openedAt?.toNumber();
        assert.ok(openedAt, "rfq openedAt should be set");
        const commitDeadline = openedAt + rfqAfterCommit.commitTtlSecs;
        const revealDeadline = commitDeadline + rfqAfterCommit.revealTtlSecs;
        console.log("Waiting for commit deadline to pass on-chain...");
        await waitForChainTime(provider.connection, commitDeadline, "commit deadline");
        console.log("Reveal period begins (past commit deadline)...");

        await program.methods
            .revealQuote(Array.from(saltQ1), new anchor.BN(DEFAULT_QUOTE_AMOUNT))
            .accounts({ rfq: rfqPDA, quote: quotePda, taker: taker.publicKey, config: configPda })
            .signers([taker])
            .rpc();

        failed = false;
        try {
            await program.methods
                .revealQuote(Array.from(saltQ2), new anchor.BN(DEFAULT_QUOTE_AMOUNT / 10))
                .accounts({ rfq: rfqPDA, quote: quote2Pda, taker: taker2.publicKey, config: configPda })
                .signers([taker2])
                .rpc();
        } catch { failed = true; }
        assert(failed, "Taker2 can't reveal invalid quote");

        const bondsFeesVaultBeforeSelection = await getAndLogBalance("After revealing ALL quotes", "RFQ Bonds Vault", bondsFeesVault);
        assert(bondsFeesVaultBeforeSelection.eq(new anchor.BN(DEFAULT_BOND_AMOUNT).muln(3)), `RFQ Bonds Vault should contain ${DEFAULT_BOND_AMOUNT * 3} USDC`);

        await Promise.all([
            getAndLogBalance("After revealing quote", "Maker USDC", makerPaymentAccount),
            getAndLogBalance("After revealing quote", "Taker USDC", takerPaymentAccount),
            getAndLogBalance("After commiting quote", "Taker2 USDC", taker2PaymentAccount),
            getAndLogBalance("Before selecting quote", "Maker Base", makerBaseAccount),
        ]);

        console.log("Waiting for reveal deadline to pass on-chain...");
        await waitForChainTime(provider.connection, revealDeadline, "reveal deadline");
        console.log("Selection period begins (past reveal deadline)...");

        await program.methods.selectQuote()
            .accounts({
                maker: maker.publicKey,
                rfq: rfqPDA,
                quote: quotePda,
                baseMint,
                quoteMint,
                vaultBaseAta: baseVault,
                makerBaseAccount,
                config: configPda,
            })
            .signers([maker])
            .rpc();

        await Promise.all([
            getAndLogBalance("After selecting quote", "Maker USDC", makerPaymentAccount),
            getAndLogBalance("After selecting quote", "Maker Base", makerBaseAccount),
            getAndLogBalance("After selecting quote", "Taker USDC", takerPaymentAccount),
            getAndLogBalance("After selecting quote", "RFQ Bonds Vault", bondsFeesVault),
            getAndLogBalance("After selecting quote", "RFQ Vault Base", baseVault),
        ]);

        await program.methods.completeSettlement()
            .accounts({
                taker: taker.publicKey,
                config: configPda,
                treasuryUsdcOwner: treasury.publicKey,
                rfq: rfqPDA,
                settlement: settlementPDA,
                usdcMint,
                baseMint,
                quoteMint,
                takerPaymentAccount,
                makerPaymentAccount,
                vaultBaseAta: baseVault,
                takerBaseAccount,
                makerQuoteAccount,
                takerQuoteAccount,
                feesTracker: feesTrackerPDA,
            })
            .remainingAccounts([{
                pubkey: slashedBondsTrackerPDA,
                isSigner: false,
                isWritable: true,
            }, {
                pubkey: quotePda,
                isSigner: false,
                isWritable: true,
            }])
            .signers([taker])
            .rpc();

        const [rfq, settlement, feesTracker, slashedBondsTracker, quote, quote2] = await Promise.all([
            program.account.rfq.fetch(rfqPDA),
            program.account.settlement.fetch(settlementPDA),
            program.account.feesTracker.fetch(feesTrackerPDA),
            program.account.slashedBondsTracker.fetch(slashedBondsTrackerPDA),
            program.account.quote.fetch(quotePda),
            program.account.quote.fetch(quote2Pda),
        ]);

        assert.strictEqual(rfq.bump, rfqBump, "rfq bump mismatch");
        assert.ok(rfq.state.settled, "rfq state should be settled");
        assert.ok(rfq.completedAt!.toNumber() > 0, "rfq completedAt should be set");
        assert.strictEqual(settlement.bump, bumpSettlement, "settlement bump mismatch");
        assert.ok(settlement.completedAt!.toNumber() > 0, "settlement completedAt should be set");
        assert(rfq.completedAt.eq(settlement.completedAt), "rfq and settlement completeAt should be equal");
        assert(settlement.takerFundedAt!.toNumber() > 0, "settlement takerFundedAt should be set");
        assert(settlement.takerFundedAt.eq(rfq.completedAt), "settlement takerFundedAt and rfq completedAt should be equal");
        assert(settlement.takerBaseAccount.equals(takerBaseAccount), "taker base account mismatch in settlement");
        assert(settlement.takerQuoteAccount.equals(takerQuoteAccount), "taker quote account mismatch in settlement");
        assert.strictEqual(feesTracker.bump, bumpFeesTracker, "feesTracker bump mismatch");
        assert(feesTracker.rfq.equals(rfqPDA), "RFQ mismatch in feesTracker");
        assert(feesTracker.taker.equals(taker.publicKey), "Taker mismatch in feesTracker");
        assert(feesTracker.usdcMint.equals(usdcMint), "usdcMint mismatch in feesTracker");
        assert(feesTracker.treasuryUsdcOwner.equals(treasury.publicKey), "treasury mismatch in feesTracker");
        assert(feesTracker.amount.eq(settlement.feeAmount), "amount mismatch in feesTracker");
        assert.ok(feesTracker.payedAt!.toNumber() > 0, "feesTracker payedAt should be set");
        assert(slashedBondsTracker.rfq.equals(rfqPDA), "RFQ mismatch in slashBoundsTracker");
        assert.strictEqual(slashedBondsTracker.bump, bumpslashedBondsTracker, "bump mismatch for slashedBondsTracker");
        //bonds of invalid quote should be seized
        assert(slashedBondsTracker.amount.eq(rfq.bondAmount), "amount should be equal to Rfq bondAmount");
        assert(slashedBondsTracker.seizedAt.toNumber() > 0, "seizedAt should be set in slashedBondsTracker");
        assert(slashedBondsTracker.seizedAt.eq(rfq.completedAt), "seizedAt in slashedBondsTracker and completedAt in Rfq should be equal");
        assert(slashedBondsTracker.usdcMint.equals(usdcMint), "usdcMint mismatch in slashedBondsTracker");
        assert(slashedBondsTracker.treasuryUsdcOwner.equals(treasury.publicKey), "treasury mismatch in slashedBondsTracker");
        assert(quote.bondsRefundedAt.eq(settlement.completedAt), "quote bondsRefundedAt and settlement completedAt should be equal");
        assert(quote2.bondsRefundedAt === null || quote2.bondsRefundedAt === undefined, "quote2 bondsRefundedAt should be None");
        const [
            makerUsdcBalance,
            makerBaseBalance,
            makerQuoteBalance,
            takerUsdcBalance,
            takerBaseBalance,
            takerQuoteBalance,
            bondsVaultBalance,
            baseVaultBalance,
            treasuryUsdcBalance,
        ] = await Promise.all([
            getAndLogBalance("After complete settlement", "Maker USDC", makerPaymentAccount),
            getAndLogBalance("After complete settlement", "Maker Base", makerBaseAccount),
            getAndLogBalance("After complete settlement", "Maker Quote", makerQuoteAccount),
            getAndLogBalance("After complete settlement", "Taker USDC", takerPaymentAccount),
            getAndLogBalance("After complete settlement", "Taker Base", takerBaseAccount),
            getAndLogBalance("After complete settlement", "Taker Quote", takerQuoteAccount),
            getAndLogBalance("After complete settlement", "RFQ Bonds Vault", bondsFeesVault),
            getAndLogBalance("After complete settlement", "RFQ Vault Base", baseVault),
            getAndLogBalance("After complete settlement", "Treasury USCD", treasuryPaymentAccount),
        ]);

        assert.ok(makerUsdcBalance.eq(new anchor.BN(DEFAULT_BOND_AMOUNT)), "maker should get bond back");
        assert.ok(makerBaseBalance.isZero(), "maker base should be transferred out");
        assert.ok(makerQuoteBalance.eq(new anchor.BN(DEFAULT_QUOTE_AMOUNT)), "maker should receive quote amount");
        assert.ok(takerUsdcBalance.eq(new anchor.BN(DEFAULT_BOND_AMOUNT)), "taker should get bond back minus fee");
        assert.ok(takerBaseBalance.eq(new anchor.BN(DEFAULT_BASE_AMOUNT)), "taker should receive base amount");
        assert.ok(takerQuoteBalance.isZero(), "taker quote should be transferred out");
        assert.ok(bondsVaultBalance.isZero(), "bonds vault should be empty");
        assert.ok(baseVaultBalance.isZero(), "base vault should be empty");
        assert.ok(treasuryUsdcBalance.eq(new anchor.BN(DEFAULT_FEE_AMOUNT).add(new anchor.BN(DEFAULT_BOND_AMOUNT))), "treasury should receive fee and bonds of invalid quote");
    });



});
