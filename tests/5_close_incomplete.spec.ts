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

const quotePda = (rfqPDA: PublicKey, taker: Keypair) => PublicKey.findProgramAddressSync(
    [Buffer.from("quote"), rfqPDA.toBuffer(), taker.publicKey.toBuffer()],
    program.programId
);

const settlementPda = (rfqPDA: PublicKey) => PublicKey.findProgramAddressSync(
    [Buffer.from("settlement"), rfqPDA.toBuffer()],
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

describe("CLOSE_INCOMPLETE & REFUND_QUOTE_BONDS", () => {
    let configPda: PublicKey;
    let usdcMint: PublicKey;
    let baseMint: PublicKey;
    let quoteMint: PublicKey;
    let maker: Keypair;
    let taker: Keypair;
    let taker2: Keypair;
    let taker3: Keypair;
    let taker4: Keypair;
    let rfqPDA: PublicKey;
    let rfqBump: Number;
    let settlementPDA: PublicKey;
    let bumpSettlement: number;
    let slashedBondsTrackerPDA: PublicKey;
    let bumpslashedBondsTracker: number;

    const admin = Keypair.generate();
    const treasury = Keypair.generate();
    const commitTTL = 10, revealTTL = 3, selectionTTL = 3, fundingTTL = 2;

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
        // console.log("All SLASHED_BONDS_TRAKER:", JSON.stringify((await program.account.slashedBondsTracker.all()), null, 2));
        await program.methods
            .closeConfig()
            .accounts({ admin: admin.publicKey, config: configPda })
            .signers([admin])
            .rpc();
    });

    it("should close incomplete Rfq", async () => {
        maker = Keypair.generate();
        await fund(maker);
        console.log("Maker:", maker.publicKey.toBase58());
        [taker, taker2, taker3, taker4] = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
        await Promise.all([fund(taker), fund(taker2), fund(taker3), fund(taker4)]);
        console.log("Taker:", taker.publicKey.toBase58());
        console.log("Taker2:", taker2.publicKey.toBase58());
        console.log("Taker3:", taker3.publicKey.toBase58());
        console.log("Taker4:", taker4.publicKey.toBase58());

        const u = uuidBytes();
        [rfqPDA, rfqBump] = rfqPda(maker.publicKey, u);
        [settlementPDA, bumpSettlement] = settlementPda(rfqPDA);
        [slashedBondsTrackerPDA, bumpslashedBondsTracker] = slashedBondsTrackerPda(rfqPDA);

        // create token accounts & mint usdc, base and quote.
        const makerPaymentAccount = getAssociatedTokenAddressSync(usdcMint, maker.publicKey);
        const makerBaseAccount = getAssociatedTokenAddressSync(baseMint, maker.publicKey);
        const takerPaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker.publicKey);
        const taker2PaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker2.publicKey);
        const taker3PaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker3.publicKey);
        const taker4PaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker4.publicKey);
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
            )), ,
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
            ))
            ,
            await getOrCreateAssociatedTokenAccount(
                provider.connection,
                admin,
                usdcMint,
                taker3.publicKey
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
                taker4.publicKey
            ).then(account => mintTo(
                provider.connection,
                admin,
                usdcMint,
                account.address,
                admin,
                DEFAULT_BOND_AMOUNT + DEFAULT_FEE_AMOUNT //sufficient for bonds + fees
            ))
        ]);

        await Promise.all([
            getAndLogBalance("Before Init RFQ", "Maker USDC", makerPaymentAccount),
            getAndLogBalance("Before Init RFQ", "Maker Base", makerBaseAccount),
            getAndLogBalance("Before Init RFQ", "Taker USDC", takerPaymentAccount),
            getAndLogBalance("Before Init RFQ", "Taker2 USDC", taker2PaymentAccount),
            getAndLogBalance("Before Init RFQ", "Taker3 USDC", taker3PaymentAccount),
            getAndLogBalance("Before Init RFQ", "Taker4 USDC", taker4PaymentAccount),
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
            getAndLogBalance("After opening RFQ", "Taker2 USDC", taker2PaymentAccount),
            getAndLogBalance("After opening RFQ", "Taker3 USDC", taker3PaymentAccount),
            getAndLogBalance("After opening RFQ", "Taker4 USDC", taker4PaymentAccount),
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

        const [saltQ2, commit_hashQ2, liquidity_proofQ2] = await provideLiquidityGuardAttestation(taker2, rfqPDA, quoteMint);
        await commitQuote(
            commit_hashQ2,
            liquidity_proofQ2,
            taker2,
            rfqPDA,
            usdcMint,
            configPda,
            taker2PaymentAccount);

        const [saltQ3, commit_hashQ3, liquidity_proofQ3] = await provideLiquidityGuardAttestation(taker3, rfqPDA, quoteMint, DEFAULT_QUOTE_AMOUNT / 10);
        await commitQuote(
            commit_hashQ3,
            liquidity_proofQ3,
            taker3,
            rfqPDA,
            usdcMint,
            configPda,
            taker3PaymentAccount);

        const [saltQ4, commit_hashQ4, liquidity_proofQ4] = await provideLiquidityGuardAttestation(taker4, rfqPDA, quoteMint, DEFAULT_QUOTE_AMOUNT / 10);
        await commitQuote(
            commit_hashQ4,
            liquidity_proofQ4,
            taker4,
            rfqPDA,
            usdcMint,
            configPda,
            taker4PaymentAccount);

        const [quotePDA] = quotePda(rfqPDA, taker);
        console.log("Quote PDA:", quotePDA.toBase58());

        const [commitGuardPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("commit-guard"), commit_hashQ1],
            program.programId
        );
        console.log("Commit Guard PDA:", commitGuardPda.toBase58());

        const [quote2PDA] = quotePda(rfqPDA, taker2);
        console.log("Quote2 PDA:", quote2PDA.toBase58());

        const [commitGuard2Pda] = PublicKey.findProgramAddressSync(
            [Buffer.from("commit-guard"), commit_hashQ2],
            program.programId
        );
        console.log("Commit Guard 2 PDA:", commitGuard2Pda.toBase58());

        const [quote3PDA] = quotePda(rfqPDA, taker3);
        console.log("Quote3 PDA:", quote3PDA.toBase58());

        const [commitGuard3Pda] = PublicKey.findProgramAddressSync(
            [Buffer.from("commit-guard"), commit_hashQ3],
            program.programId
        );
        console.log("Commit Guard 3 PDA:", commitGuard3Pda.toBase58());

        const [quote4PDA] = quotePda(rfqPDA, taker4);
        console.log("Quote4 PDA:", quote4PDA.toBase58());

        const [commitGuard4Pda] = PublicKey.findProgramAddressSync(
            [Buffer.from("commit-guard"), commit_hashQ4],
            program.programId
        );
        console.log("Commit Guard 4 PDA:", commitGuard4Pda.toBase58());

        await Promise.all([
            getAndLogBalance("After commiting quote", "Maker USDC", makerPaymentAccount),
            getAndLogBalance("After commiting quote", "Taker USDC", takerPaymentAccount),
            getAndLogBalance("After commiting quote", "Taker2 USDC", taker2PaymentAccount),
            getAndLogBalance("After commiting quote", "Taker3 USDC", taker3PaymentAccount),
            getAndLogBalance("After commiting quote", "Taker4 USDC", taker4PaymentAccount),
            getAndLogBalance("After commiting quote", "RFQ Bonds Vault", bondsFeesVault),
        ]);

        const rfqAfterCommit = await program.account.rfq.fetch(rfqPDA);
        const openedAt = rfqAfterCommit.openedAt?.toNumber();
        assert.ok(openedAt, "rfq openedAt should be set");
        const commitDeadline = openedAt + rfqAfterCommit.commitTtlSecs;
        const revealDeadline = commitDeadline + rfqAfterCommit.revealTtlSecs;
        const fundingDeadline = revealDeadline + rfqAfterCommit.selectionTtlSecs + rfqAfterCommit.fundTtlSecs;
        console.log("Waiting for commit deadline to pass on-chain...");
        await waitForChainTime(provider.connection, commitDeadline, "commit deadline");
        console.log("Reveal period begins (past commit deadline)...");

        await Promise.all([
            program.methods
                .revealQuote(Array.from(saltQ1), new anchor.BN(DEFAULT_QUOTE_AMOUNT))
                .accounts({ rfq: rfqPDA, quote: quotePDA, taker: taker.publicKey, config: configPda })
                .signers([taker])
                .rpc(),
            program.methods
                .revealQuote(Array.from(saltQ2), new anchor.BN(DEFAULT_QUOTE_AMOUNT))
                .accounts({ rfq: rfqPDA, quote: quote2PDA, taker: taker2.publicKey, config: configPda })
                .signers([taker2])
                .rpc()
        ]);

        console.log("Waiting for reveal deadline to pass on-chain...");
        await waitForChainTime(provider.connection, revealDeadline, "reveal deadline");
        console.log("Selection period begins (past reveal deadline)...");

        await program.methods.selectQuote()
            .accounts({
                maker: maker.publicKey,
                rfq: rfqPDA,
                quote: quotePDA,
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
            getAndLogBalance("After selecting quote", "Taker USDC", takerPaymentAccount),
            getAndLogBalance("After selecting quote", "Taker2 USDC", taker2PaymentAccount),
            getAndLogBalance("After selecting quote", "Taker3 USDC", taker3PaymentAccount),
            getAndLogBalance("After selecting quote", "Taker4 USDC", taker4PaymentAccount),
            getAndLogBalance("After selecting quote", "RFQ Bonds Vault", bondsFeesVault),
            getAndLogBalance("After selecting quote", "Maker Base", makerBaseAccount),
        ]);

        let [rfq, settlement, slashedBondsTracker, quote, quote2] = await Promise.all([
            program.account.rfq.fetch(rfqPDA),
            program.account.settlement.fetch(settlementPDA),
            program.account.slashedBondsTracker.fetch(slashedBondsTrackerPDA),
            program.account.quote.fetch(quotePDA),
            program.account.quote.fetch(quote2PDA),
        ]);

        assert.strictEqual(rfq.bump, rfqBump, "rfq bump mismatch");
        assert.ok(rfq.state.selected, "rfq state should be selected");
        assert(rfq.selectedAt!.toNumber() > 0, "rfq selectedAt should be set");
        assert(rfq.completedAt === null || rfq.completedAt === undefined, "rfq completeAt should be None");
        assert.strictEqual(settlement.bump, bumpSettlement, "settlement bump mismatch");
        assert(settlement.completedAt === null || settlement.completedAt === undefined, "settlement completeAt should be None");
        assert(slashedBondsTracker.seizedAt === null || slashedBondsTracker.seizedAt === undefined, "slashBondsTracker seizedAt should be None");
        assert(quote.bondsRefundedAt === null || quote.bondsRefundedAt === null, "quote bondsRefundedAt should be None");
        assert(quote2.bondsRefundedAt === null || quote2.bondsRefundedAt === null, "quote2 bondsRefundedAt should be None");

        console.log("Waiting for funding deadline to pass on-chain...");
        await waitForChainTime(provider.connection, fundingDeadline, "funding deadline");
        console.log("Funding deadline past...");

        await program.methods.closeIncomplete()
            .accounts({
                maker: maker.publicKey,
                config: configPda,
                rfq: rfqPDA,
                settlement: settlementPDA,
                baseMint,
                vaultBaseAta: baseVault,
                makerBaseAccount,
                usdcMint,
                bondsFeesVault,
                makerPaymentAccount,
                treasuryUsdcOwner: treasury.publicKey,
                slashBoundsTracker: slashedBondsTrackerPDA,
            })
            .signers([maker])
            .rpc();

        let settlementClosed = false;
        try { await program.account.settlement.fetch(settlementPDA); } catch { settlementClosed = true; }
        assert(settlementClosed, "settlement should be closed");

        [rfq, slashedBondsTracker, quote, quote2] = await Promise.all([
            program.account.rfq.fetch(rfqPDA),
            program.account.slashedBondsTracker.fetch(slashedBondsTrackerPDA),
            program.account.quote.fetch(quotePDA),
            program.account.quote.fetch(quote2PDA),
        ]);

        const [quote3, quote4] = await Promise.all([
            program.account.quote.fetch(quote3PDA),
            program.account.quote.fetch(quote4PDA),
        ]);

        const [
            makerPaymentAccountBalance,
            takerPaymentAccountBalance,
            taker2PaymentAccountBalance,
            taker3PaymentAccountBalance,
            taker4PaymentAccountBalance,
            bondsFeesVaultBalance,
            treasuryPaymentAccountBalance,
            makerBaseAccountBalance,
        ]
            = await Promise.all([
                getAndLogBalance("After closing incomplete Rfq", "Maker USDC", makerPaymentAccount),
                getAndLogBalance("After closing incomplete Rfq", "Taker USDC", takerPaymentAccount),
                getAndLogBalance("After closing incomplete Rfq", "Taker2 USDC", taker2PaymentAccount),
                getAndLogBalance("After closing incomplete Rfq", "Taker3 USDC", taker3PaymentAccount),
                getAndLogBalance("After closing incomplete Rfq", "Taker4 USDC", taker4PaymentAccount),
                getAndLogBalance("After closing incomplete Rfq", "RFQ Bonds Vault", bondsFeesVault),
                getAndLogBalance("After closing incomplete Rfq", "Treasury USCD", treasuryPaymentAccount),
                getAndLogBalance("After closing incomplete Rfq", "Maker Base", makerBaseAccount),
            ]);

        assert.ok(rfq.state.incomplete, "rfq state should be incomplete");
        assert(rfq.settlement === null || rfq.settlement === undefined, "rfq settlement should be None");
        assert(rfq.completedAt!.toNumber() > 0, "rfq completedAt should be set");
        assert(slashedBondsTracker.rfq.equals(rfqPDA), "RFQ mismatch in slashBoundsTracker");
        assert(slashedBondsTracker.seizedAt.eq(rfq.completedAt), "slashBondsTracker seizedAt and rfq completeAt shoud be equal");
        assert.strictEqual(slashedBondsTracker.bump, bumpslashedBondsTracker, "bump mismatch for slashedBondsTracker");
        assert(slashedBondsTracker.usdcMint.equals(usdcMint), "usdcMint mismatch in slashedBondsTracker");
        assert(slashedBondsTracker.treasuryUsdcOwner.equals(treasury.publicKey), "treasury mismatch in slashedBondsTracker");

        //no-show for valid taker + 2 invalid quotes (taker3 and taker4)
        assert(slashedBondsTracker.amount.eq(rfq.bondAmount.muln(3)), "amount should be equal to 3x Rfq bondAmount");
        assert(new anchor.BN(DEFAULT_BOND_AMOUNT).eq(makerPaymentAccountBalance), "maker balance mismatch");
        assert(new anchor.BN(DEFAULT_FEE_AMOUNT).eq(takerPaymentAccountBalance), "taker balance mismatch");
        assert(new anchor.BN(DEFAULT_FEE_AMOUNT).eq(taker2PaymentAccountBalance), "taker2 balance mismatch");
        assert(new anchor.BN(DEFAULT_FEE_AMOUNT).eq(taker3PaymentAccountBalance), "taker3 balance mismatch");
        assert(new anchor.BN(DEFAULT_FEE_AMOUNT).eq(taker4PaymentAccountBalance), "taker4 balance mismatch");
        assert(new anchor.BN(DEFAULT_BOND_AMOUNT).eq(bondsFeesVaultBalance), `bonds and fees vault should not be empty and 1x ${DEFAULT_BOND_AMOUNT}`);
        assert(treasuryPaymentAccountBalance.eq(slashedBondsTracker.amount), "treasury payment balance should be equalt to slashed bonds tracker amount");
        assert(new anchor.BN(DEFAULT_BASE_AMOUNT).eq(makerBaseAccountBalance), "maker base balance mismatch");

        const fundingHorizon = rfq.openedAt.addn(commitTTL)
            .addn(revealTTL)
            .addn(selectionTTL)
            .addn(fundingTTL);

        assert(!!quote.revealedAt, "quote revealedAt should be set");
        assert(quote.maxFundingDeadline.eq(fundingHorizon), "quote maxFundingDeadline should be fundingHorizon");
        assert(!quote.bondsRefundedAt, "quote bondsRefundedAt should be None");
        assert(quote.selected, "quote should be selected");
        assert(!!quote2.revealedAt, "quote2 revealedAt should be set");
        assert(quote2.maxFundingDeadline.eq(fundingHorizon), "quote2 maxFundingDeadline should be fundingHorizon");
        assert(!quote2.bondsRefundedAt, "quote2 bondsRefundedAt should be None");
        assert(!quote2.selected, "quote2 should not be selected");
        assert(!quote3.revealedAt, "quote3 revealedAt should be None");
        assert(quote3.maxFundingDeadline.eq(fundingHorizon), "quote3 maxFundingDeadline should be fundingHorizon");
        assert(!quote3.bondsRefundedAt, "quote3 bondsRefundedAt should be None");
        assert(!quote3.selected, "quote3 should not be selected");
        assert(!quote4.revealedAt, "quote4 revealedAt should be None");
        assert(quote4.maxFundingDeadline.eq(fundingHorizon), "quote4 maxFundingDeadline should be fundingHorizon");
        assert(!quote4.bondsRefundedAt, "quote4 bondsRefundedAt should be None");
        assert(!quote4.selected, "quote4 should not be selected");
    });

    it("should refund quote bonds", async () => {
        console.log("Taker:", taker.publicKey.toBase58());
        console.log("Taker2:", taker2.publicKey.toBase58());
        console.log("Taker3:", taker3.publicKey.toBase58());
        console.log("Taker4:", taker4.publicKey.toBase58());

        console.log("Rfq PDA:", rfqPDA.toBase58());
        console.log("Slashed Bonds Tracker PDA", slashedBondsTrackerPDA.toBase58());

        const [quotePDA] = quotePda(rfqPDA, taker);
        console.log("Quote PDA:", quotePDA.toBase58());
        const [quote2PDA] = quotePda(rfqPDA, taker2);
        console.log("Quote2 PDA:", quote2PDA.toBase58());
        const [quote3PDA] = quotePda(rfqPDA, taker3);
        console.log("Quote3 PDA:", quote3PDA.toBase58());
        const [quote4PDA] = quotePda(rfqPDA, taker4);
        console.log("Quote4 PDA:", quote4PDA.toBase58());

        const bondsFeesVault = getAssociatedTokenAddressSync(usdcMint, rfqPDA, true);
        const takerPaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker.publicKey);
        const taker2PaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker2.publicKey);
        const taker3PaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker3.publicKey);
        const taker4PaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker4.publicKey);
        const treasuryPaymentAccount = getAssociatedTokenAddressSync(usdcMint, treasury.publicKey);

        let failed = false;
        try {
            await program.methods.refundQuoteBonds()
                .accounts({
                    taker: taker.publicKey,
                    config: configPda,
                    rfq: rfqPDA,
                    usdcMint,
                    bondsFeesVault,
                    takerPaymentAccount,
                    treasuryUsdcOwner: treasury.publicKey,
                    slashBoundsTracker: slashedBondsTrackerPDA,
                })
                .signers([taker])
                .rpc();
        } catch {
            failed = true;
        }
        assert(failed, "refundQuoteBonds() should fail for taker: selected quote not refundable");

        await program.methods.refundQuoteBonds()
            .accounts({
                taker: taker2.publicKey,
                config: configPda,
                rfq: rfqPDA,
                usdcMint,
                bondsFeesVault,
                takerPaymentAccount: taker2PaymentAccount,
                treasuryUsdcOwner: treasury.publicKey,
                slashBoundsTracker: slashedBondsTrackerPDA,
            })
            .signers([taker2])
            .rpc();

        failed = false;
        try {
            await program.methods.refundQuoteBonds()
                .accounts({
                    taker: taker3.publicKey,
                    config: configPda,
                    rfq: rfqPDA,
                    usdcMint,
                    bondsFeesVault,
                    takerPaymentAccount: taker3PaymentAccount,
                    treasuryUsdcOwner: treasury.publicKey,
                    slashBoundsTracker: slashedBondsTrackerPDA,
                })
                .signers([taker3])
                .rpc();
        } catch {
            failed = true;
        }
        assert(failed, "refundQuoteBonds() should fail for taker3: unrevealed quote not refundable");

        failed = false;
        try {
            await program.methods.refundQuoteBonds()
                .accounts({
                    taker: taker4.publicKey,
                    config: configPda,
                    rfq: rfqPDA,
                    usdcMint,
                    bondsFeesVault,
                    takerPaymentAccount: taker4PaymentAccount,
                    treasuryUsdcOwner: treasury.publicKey,
                    slashBoundsTracker: slashedBondsTrackerPDA,
                })
                .signers([taker4])
                .rpc();
        } catch {
            failed = true;
        }
        assert(failed, "refundQuoteBonds() should fail for taker4: unrevealed quote not refundable");

        const [rfq, slashedBondsTracker, quote, quote2, quote3, quote4] = await Promise.all([
            program.account.rfq.fetch(rfqPDA),
            program.account.slashedBondsTracker.fetch(slashedBondsTrackerPDA),
            program.account.quote.fetch(quotePDA),
            program.account.quote.fetch(quote2PDA),
            program.account.quote.fetch(quote3PDA),
            program.account.quote.fetch(quote4PDA),
        ]);

        const [
            takerPaymentAccountBalance,
            taker2PaymentAccountBalance,
            taker3PaymentAccountBalance,
            taker4PaymentAccountBalance,
            bondsFeesVaultBalance,
            treasuryPaymentAccountBalance,
        ] = await Promise.all([
            getAndLogBalance("After refunding quote bonds", "Taker USDC", takerPaymentAccount),
            getAndLogBalance("After refunding quote bonds", "Taker2 USDC", taker2PaymentAccount),
            getAndLogBalance("After refunding quote bonds", "Taker3 USDC", taker3PaymentAccount),
            getAndLogBalance("After refunding quote bonds", "Taker4 USDC", taker4PaymentAccount),
            getAndLogBalance("After refunding quote bonds", "RFQ Bonds Vault", bondsFeesVault),
            getAndLogBalance("After refunding quote bonds", "Treasury USCD", treasuryPaymentAccount),
        ]);

        assert.ok(rfq.state.incomplete, "rfq state should be incomplete");
        assert(!!rfq.completedAt, "rfq completedAt should be set");
        assert(slashedBondsTracker.seizedAt.eq(rfq.completedAt), "slashBondsTracker seizedAt and rfq completeAt shoud be equal");
        assert(!quote.bondsRefundedAt, "quote bondsRefundedAt should be None"); // no-show
        assert(!!quote2.bondsRefundedAt, "quote2 bondsRefundedAt should be set");
        assert(!quote3.bondsRefundedAt, "quote3 bondsRefundedAt should be None");// invalid quote
        assert(!quote4.bondsRefundedAt, "quote4 bondsRefundedAt should be None");// invalid quote
        assert(new anchor.BN(DEFAULT_FEE_AMOUNT).eq(takerPaymentAccountBalance), "taker balance mismatch");
        assert(taker2PaymentAccountBalance.eq(new anchor.BN(DEFAULT_FEE_AMOUNT).addn(DEFAULT_BOND_AMOUNT)), "taker2 balance mismatch");
        assert(new anchor.BN(DEFAULT_FEE_AMOUNT).eq(taker3PaymentAccountBalance), "taker3 balance mismatch");
        assert(new anchor.BN(DEFAULT_FEE_AMOUNT).eq(taker4PaymentAccountBalance), "taker4 balance mismatch");
        assert(bondsFeesVaultBalance.isZero(), `bonds and fees vault should be 0`);
        assert(treasuryPaymentAccountBalance.eq(slashedBondsTracker.amount), "treasury payment balance should be equalt to slashed bonds tracker amount");
    });
});
