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
    takerPaymentAccount: PublicKey) => {
    // Create Ed25519 verification instruction using the helper
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
        publicKey: liquidityGuard.toBytes(),
        message: commit_hash,
        signature: liquidity_proof,
    });
    const commitQuoteIx1 = await program.methods
        .commitQuote(Array.from(commit_hash), Array.from(liquidity_proof))
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

describe("CLOSE_EXPIRED_RFQ", () => {
    let configPda: PublicKey;
    let usdcMint: PublicKey;
    let baseMint: PublicKey;
    let quoteMint: PublicKey;

    const admin = Keypair.generate();
    const treasury = Keypair.generate();
    const commitTTL = 10, revealTTL = 3, selectionTTL = 10, fundingTTL = 20;

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
                .initConfig(usdcMint, treasury.publicKey, liquidityGuard)
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
        console.log("All CONFIG:", JSON.stringify((await program.account.config.all()), null, 2));
        console.log("All RFQ:", JSON.stringify((await program.account.rfq.all()), null, 2));
        console.log("All QUOTE:", JSON.stringify((await program.account.quote.all()), null, 2));
        console.log("All COMMIT GUARDS:", JSON.stringify((await program.account.commitGuard.all()), null, 2));
        console.log("All SLASHED_BONDS_TRAKER:", JSON.stringify((await program.account.slashedBondsTracker.all()), null, 2));
        await program.methods
            .closeConfig()
            .accounts({ admin: admin.publicKey, config: configPda })
            .signers([admin])
            .rpc();
    });

    it("should close expired Rfq", async () => {
        const maker = Keypair.generate();
        await fund(maker);
        console.log("Maker:", maker.publicKey.toBase58());
        const [taker, taker2, taker3, taker4] = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
        await Promise.all([fund(taker), fund(taker2), fund(taker3), fund(taker4)]);
        console.log("Taker:", taker.publicKey.toBase58());
        console.log("Taker2:", taker2.publicKey.toBase58());
        console.log("Taker3:", taker3.publicKey.toBase58());
        console.log("Taker4:", taker4.publicKey.toBase58());

        const u = uuidBytes();
        const [rfqPDA, rfqBump] = rfqPda(maker.publicKey, u);
        const [slashedBondsTrackerPDA, bumpslashedBondsTracker] = slashedBondsTrackerPda(rfqPDA);

        // create token accounts & mint usdc, base and quote.
        const makerPaymentAccount = getAssociatedTokenAddressSync(usdcMint, maker.publicKey);
        const takerPaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker.publicKey);
        const taker2PaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker2.publicKey);
        const taker3PaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker3.publicKey);
        const taker4PaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker4.publicKey);
        const bondsFeesVault = getAssociatedTokenAddressSync(usdcMint, rfqPDA, true);
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
                    fundingTTL
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

        // taker will commit a valid quote but won't reveal
        const [_saltQ1, commit_hashQ1, liquidity_proofQ1] = await provideLiquidityGuardAttestation(taker, rfqPDA, quoteMint);
        await commitQuote(
            commit_hashQ1,
            liquidity_proofQ1,
            taker,
            rfqPDA,
            usdcMint,
            configPda,
            takerPaymentAccount);

        // taker2 will commit an invalid quote (smaller quote amount)
        const [_saltQ2, commit_hashQ2, liquidity_proofQ2] = await provideLiquidityGuardAttestation(taker2, rfqPDA, quoteMint, DEFAULT_QUOTE_AMOUNT / 10);
        await commitQuote(
            commit_hashQ2,
            liquidity_proofQ2,
            taker2,
            rfqPDA,
            usdcMint,
            configPda,
            taker2PaymentAccount);

        // taker3 will commit a valid quote but won't reveal
        const [_saltQ3, commit_hashQ3, liquidity_proofQ3] = await provideLiquidityGuardAttestation(taker3, rfqPDA, quoteMint);
        await commitQuote(
            commit_hashQ3,
            liquidity_proofQ3,
            taker3,
            rfqPDA,
            usdcMint,
            configPda,
            taker3PaymentAccount);

        // taker4 will commit an invalid quote (smaller quote amount)
        const [_saltQ4, commit_hashQ4, liquidity_proofQ4] = await provideLiquidityGuardAttestation(taker4, rfqPDA, quoteMint, DEFAULT_QUOTE_AMOUNT / 10);
        await commitQuote(
            commit_hashQ4,
            liquidity_proofQ4,
            taker4,
            rfqPDA,
            usdcMint,
            configPda,
            taker4PaymentAccount);

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

        console.log("Waiting for commit/reveal deadline to pass on-chain...");
        await waitForChainTime(provider.connection, revealDeadline, "reveal deadline");
        console.log("Selection period begins (past reveal deadline)...");

        await program.methods.closeExpired()
            .accounts({
                maker: maker.publicKey,
                rfq: rfqPDA,
                config: configPda,
                usdcMint,
                bondsFeesVault,
                treasuryUsdcOwner: treasury.publicKey,
                makerPaymentAccount,
            })
            .signers([maker])
            .rpc();

        const [
            makerPaymentAccountBalance,
            takerPaymentAccountBalance,
            taker2PaymentAccountBalance,
            taker3PaymentAccountBalance,
            taker4PaymentAccountBalance,
            bondsFeesVaultBalance,
            treasuryPaymentAccountBalance
        ]
            = await Promise.all([
                getAndLogBalance("After Rfq Expiration", "Maker USDC", makerPaymentAccount),
                getAndLogBalance("After Rfq Expiration", "Taker USDC", takerPaymentAccount),
                getAndLogBalance("After Rfq Expiration", "Taker2 USDC", taker2PaymentAccount),
                getAndLogBalance("After Rfq Expiration", "Taker3 USDC", taker3PaymentAccount),
                getAndLogBalance("After Rfq Expiration", "Taker4 USDC", taker4PaymentAccount),
                getAndLogBalance("After Rfq Expiration", "RFQ Bonds Vault", bondsFeesVault),
                getAndLogBalance("After Rfq Expiration", "Treasury USCD", treasuryPaymentAccount),
            ]);

        const [rfq, slashedBondsTracker] = await Promise.all([
            program.account.rfq.fetch(rfqPDA),
            program.account.slashedBondsTracker.fetch(slashedBondsTrackerPDA),
        ]);
        assert.strictEqual(rfq.bump, rfqBump, "rfq bump mismatch");
        assert.ok(rfq.state.expired, "rfq state should be expired");
        assert.ok(rfq.completedAt!.toNumber() > 0, "rfq completedAt should be set");
        assert(slashedBondsTracker.rfq.equals(rfqPDA), "RFQ mismatch in slashBoundsTracker");
        assert.strictEqual(slashedBondsTracker.bump, bumpslashedBondsTracker, "bump mismatch for slashedBondsTracker");
        assert(slashedBondsTracker.seizedAt.eq(rfq.completedAt), "seizedAt in slashedBondsTracker and completedAt in Rfq should be equal");
        assert(slashedBondsTracker.amount.eq(rfq.bondAmount.muln(4)), "amount should be equal to 4x Rfq bondAmount");
        assert(slashedBondsTracker.usdcMint.equals(usdcMint), "usdcMint mismatch in slashedBondsTracker");
        assert(slashedBondsTracker.treasuryUsdcOwner.equals(treasury.publicKey), "treasury mismatch in slashedBondsTracker");
        assert(new anchor.BN(DEFAULT_BOND_AMOUNT).eq(makerPaymentAccountBalance), "maker balance mismatch");
        assert(new anchor.BN(DEFAULT_FEE_AMOUNT).eq(takerPaymentAccountBalance), "taker balance mismatch");
        assert(new anchor.BN(DEFAULT_FEE_AMOUNT).eq(taker2PaymentAccountBalance), "taker2 balance mismatch");
        assert(new anchor.BN(DEFAULT_FEE_AMOUNT).eq(taker3PaymentAccountBalance), "taker3 balance mismatch");
        assert(new anchor.BN(DEFAULT_FEE_AMOUNT).eq(taker4PaymentAccountBalance), "taker4 balance mismatch");
        assert(bondsFeesVaultBalance.isZero(), "bonds and fees vault should be empty");
        assert(treasuryPaymentAccountBalance.eq(slashedBondsTracker.amount), "treasury payment balance should be equalt to slashed bonds tracker amount");
    });



});
