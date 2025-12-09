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
import { v4 as uuidv4, parse as uuidParse } from "uuid";
import assert from "assert";
import { waitForChainTime } from "./utils/time";
import { uuidBytes } from "./1_rfq.spec";

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

const liquidityGuardURL = "https://liquidity-guard-devnet-skip-c644b6411603.herokuapp.com";
const toNum = (v: any) => (typeof v === "number" ? v : new anchor.BN(v).toNumber());

async function getAndLogBalance(
    label: string,
    owner: string,
    tokenAccount: PublicKey,) {
    const balance = await provider.connection.getTokenAccountBalance(tokenAccount).then(b => new anchor.BN(b.value.amount));
    console.log(`${label} - ${owner}:`, balance.toNumber().toLocaleString("en-US"));
    return balance;
}

// --- tests (ONLY initRfq) --------------------------------------------------

describe("QUOTE", () => {
    let configPda: PublicKey;
    let usdcMint: PublicKey;
    let baseMint: PublicKey;
    let quoteMint: PublicKey;
    let rfqPDA: PublicKey;
    let rfqBump: number;
    let validTaker: Keypair;
    let bondsFeesVault: PublicKey;
    let makerPaymentAccount: PublicKey;
    let makerPaymentBalance: anchor.BN;
    let vaultPaymentBalance: anchor.BN;
    let takerPaymentBalance: anchor.BN;

    const admin = Keypair.generate();
    const maker = Keypair.generate();

    const commitTTL = 10, revealTTL = 10, selectionTTL = 10, fundingTTL = 10;

    const liquidityGuard = new PublicKey("5gfPFweV3zJovznZqBra3rv5tWJ5EHVzQY1PqvNA4HGg");


    before(async () => {
        await waitForLiquidityGuardReady();
        await fund(admin);
        await fund(maker);

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
            await program.methods
                .initConfig(usdcMint, treasury, liquidityGuard)
                .accounts({ admin: admin.publicKey })
                .signers([admin])
                .rpc();
        }

        const u = uuidBytes();
        [rfqPDA, rfqBump] = rfqPda(maker.publicKey, u);

        needInit = false;
        try {
            await program.account.rfq.fetch(rfqPDA);
        } catch { needInit = true; }
        if (needInit) {
            bondsFeesVault = getAssociatedTokenAddressSync(usdcMint, rfqPDA, true);
            makerPaymentAccount = getAssociatedTokenAddressSync(usdcMint, maker.publicKey);

            // mint the bonds to maker's payment ATA
            const makerPaymentAccountInfo = await getOrCreateAssociatedTokenAccount(
                provider.connection,
                admin,
                usdcMint,
                maker.publicKey
            );
            assert(
                makerPaymentAccountInfo.address.equals(makerPaymentAccount),
                "maker payment ATA mismatch"
            );
            await mintTo(
                provider.connection,
                admin,
                usdcMint,
                makerPaymentAccount,
                admin,
                1_000_000 //sufficient for bond
            );

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
                    usdcMint,
                    bondsFeesVault,
                    makerPaymentAccount,
                    systemProgram: SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                })
                .signers([maker])
                .rpc();
        }

        [makerPaymentBalance, vaultPaymentBalance] = await Promise.all([
            getAndLogBalance("Before opening RFQ", "Maker USDC", makerPaymentAccount),
            getAndLogBalance("Before opening RFQ", "RFQ Bonds Vault", bondsFeesVault),
        ]);

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

        [makerPaymentBalance, vaultPaymentBalance] = await Promise.all([
            getAndLogBalance("After opening RFQ", "Maker USDC", makerPaymentAccount),
            getAndLogBalance("After opening RFQ", "RFQ Bonds Vault", bondsFeesVault),
        ]);

        const rfq = await program.account.rfq.fetch(rfqPDA);

        assert(vaultPaymentBalance.eq(rfq.bondAmount), "RFQ bond vault balance mismatch after open");
        assert(makerPaymentBalance.eq(new anchor.BN(0)), "Maker payment account balance should be zero after open");
    });

    after(async () => {
        await program.methods
            .closeConfig()
            .accounts({ admin: admin.publicKey, config: configPda })
            .signers([admin])
            .rpc();
    });

    it("should check a quote from liquidity guard", async () => {
        const taker = Keypair.generate();
        await fund(taker);
        console.log("Taker:", taker.publicKey.toBase58());

        // sign RFQ id
        const rfqAddr = Buffer.from(rfqPDA.toBytes());
        const salt = nacl.sign.detached(rfqAddr, taker.secretKey);
        console.log("salt:", Buffer.from(salt).toString("hex"));
        const isValid = nacl.sign.detached.verify(
            rfqAddr,
            salt,
            taker.publicKey.toBytes()
        );
        assert(isValid, "signature failed to verify");

        const payload = {
            rfq: rfqPDA.toBase58(),
            taker: taker.publicKey.toBase58(),
            salt: Buffer.from(salt).toString("hex"),
            quote_mint: quoteMint.toBase58(),
            quote_amount: new anchor.BN(1_000_000_001).toString(),
            bond_amount_usdc: new anchor.BN(1_000_000).toString(),
            fee_amount_usdc: new anchor.BN(1_000).toString(),
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
            assert(response.rfq === rfqPDA.toBase58(), `unexpected rfq ${response.rfq}`);
            assert(response.salt === Buffer.from(salt).toString("hex"), `unexpected salt ${response.salt}`);
            assert(response.taker === taker.publicKey.toBase58(), `unexpected taker ${response.taker}`);
            assert(response.quote_mint === quoteMint.toBase58(), `unexpected quote mint ${response.quote_mint}`);
            assert(response.quote_amount === "1000000001", `unexpected quote amount ${response.quote_amount}`);
            assert(response.bond_amount_usdc === "1000000", `unexpected bond amount ${response.bond_amount_usdc}`);
            assert(response.fee_amount_usdc === "1000", `unexpected fee amount ${response.fee_amount_usdc}`);
            assert(response.service_pubkey === liquidityGuard.toBase58(), `unexpected service pubkey ${response.service_pubkey}`);
            assert(response.commit_hash.length > 0, `empty commit_hash`);
            assert(response.liquidity_proof.length > 0, `empty liquidity_proof`);
            assert(response.network === 'Devnet', `unexpected network: ${response.network}`);
            assert(response.skip_fund_checks === true, `unexpected skip_fund_checks: ${response.skip_fund_checks}`);
            assert(response.timestamp > 0, `invalid timestamp: ${response.timestamp}`);
        }
    });

    it("should commit a quote", async () => {
        const taker = Keypair.generate();
        await fund(taker);
        console.log("Taker:", taker.publicKey.toBase58());

        // sign RFQ id
        const rfqAddr = Buffer.from(rfqPDA.toBytes());
        const salt = nacl.sign.detached(rfqAddr, taker.secretKey);
        console.log("salt:", Buffer.from(salt).toString("hex"));
        const isValid = nacl.sign.detached.verify(
            rfqAddr,
            salt,
            taker.publicKey.toBytes()
        );
        assert(isValid, "signature failed to verify");

        const payload = {
            rfq: rfqPDA.toBase58(),
            taker: taker.publicKey.toBase58(),
            salt: Buffer.from(salt).toString("hex"),
            quote_mint: quoteMint.toBase58(),
            quote_amount: new anchor.BN(1_000_000_001).toString(),
            bond_amount_usdc: new anchor.BN(1_000_000).toString(),
            fee_amount_usdc: new anchor.BN(1_000).toString(),
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
            console.log("Liquidity Guard response:", response);
            assert(response.rfq === rfqPDA.toBase58(), `unexpected rfq ${response.rfq}`);
            assert(response.salt === Buffer.from(salt).toString("hex"), `unexpected salt ${response.salt}`);
            assert(response.taker === taker.publicKey.toBase58(), `unexpected taker ${response.taker}`);
            assert(response.commit_hash.length > 0, `empty commit_hash`);
            assert(response.liquidity_proof.length > 0, `empty liquidity_proof`);
        }

        let rfq = await program.account.rfq.fetch(rfqPDA);
        assert.ok(rfq.state.open);

        const takerPaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker.publicKey);

        // mint the bonds to taker's payment ATA
        const takerPaymentAccountInfo = await getOrCreateAssociatedTokenAccount(
            provider.connection,
            admin,
            usdcMint,
            taker.publicKey
        );
        assert(
            takerPaymentAccountInfo.address.equals(takerPaymentAccount),
            "taker payment ATA mismatch"
        );
        await mintTo(
            provider.connection,
            admin,
            usdcMint,
            takerPaymentAccount,
            admin,
            1_000_000 //sufficient for bond
        );

        const commit_hash = Buffer.from(response.commit_hash, "hex");
        const liquidity_proof = Buffer.from(response.liquidity_proof, "hex");
        if (commit_hash.length !== 32) throw new Error("commit_hash must be 32 bytes");
        if (liquidity_proof.length !== 64) throw new Error("liquidity_proof sig must be 64 bytes");

        // Create Ed25519 verification instruction using the helper
        const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
            publicKey: liquidityGuard.toBytes(),
            message: commit_hash,
            signature: liquidity_proof,
        });

        // Peek at the data to confirm offsets (little‑endian u16 fields)
        const data = ed25519Ix.data;
        const sigOffset = data.readUInt16LE(2);
        const pubkeyOffset = data.readUInt16LE(6);
        const msgOffset = data.readUInt16LE(10);
        const msgSize = data.readUInt16LE(12);
        console.log('OFFSETS:', { sigOffset, pubkeyOffset, msgOffset, msgSize });

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

        const commited_rfq = await program.account.rfq.fetch(rfqPDA);
        assert.ok(commited_rfq.state.committed);

        const [quotePda, bumpQuote] = PublicKey.findProgramAddressSync(
            [Buffer.from("quote"), rfqPDA.toBuffer(), taker.publicKey.toBuffer()],
            program.programId
        );
        console.log("Quote PDA:", quotePda.toBase58());

        const quote = await program.account.quote.fetch(quotePda);
        assert(quote.taker.equals(taker.publicKey));
        assert(quote.rfq.equals(rfqPDA));
        assert.deepStrictEqual(quote.commitHash, Array.from(commit_hash));
        assert.deepStrictEqual(quote.liquidityProof, Array.from(liquidity_proof));
        assert.ok(quote.committedAt.toNumber() > 0);
        assert(quote.revealedAt === null || quote.revealedAt === undefined, "revealedAt should be None before reveal");
        assert(quote.quoteAmount === null || quote.quoteAmount === null, "quoteAmount should be None before reveal");
        assert.strictEqual(quote.bump, bumpQuote, "quote bump mismatch");
        assert(quote.takerPaymentAccount.equals(takerPaymentAccount), "taker payment account mismatch");

        rfq = await program.account.rfq.fetch(rfqPDA);
        assert.strictEqual(rfq.committedCount, 1, "rfq revealedCount should be 1");

        const [commitGuardPda, bumpCommit] = PublicKey.findProgramAddressSync(
            [Buffer.from("commit-guard"), commit_hash],
            program.programId
        );
        console.log("Commit Guard PDA:", commitGuardPda.toBase58());

        const commitGuard = await program.account.commitGuard.fetch(commitGuardPda);
        assert.strictEqual(commitGuard.bump, bumpCommit, "commit guard bump mismatch");
        assert.ok(commitGuard.committedAt.eq(quote.committedAt), "committedAt mismatch");
        assert(commitGuard.quote.equals(quotePda), "commitGuard's quote mismatch");

        // save valid taker for reveal test
        validTaker = taker;

        [makerPaymentBalance, vaultPaymentBalance, takerPaymentBalance] = await Promise.all([
            getAndLogBalance("After commiting quote", "Maker USDC", makerPaymentAccount),
            getAndLogBalance("After commiting quote", "RFQ Bonds Vault", bondsFeesVault),
            getAndLogBalance("After commiting quote", "Taker USDC", takerPaymentAccount),
        ]);

        assert(vaultPaymentBalance.eq(rfq.bondAmount.muln(2)), "RFQ bond vault balance mismatch after open");
        assert(makerPaymentBalance.eq(new anchor.BN(0)), "Maker payment account balance should be zero after open");
        assert(takerPaymentBalance.eq(new anchor.BN(0)), "Taker payment account balance should be zero after commit");

        // test commit guard prevents re-use of hash
        console.log("Testing that different taker cannot commit same hash...");
        const taker2 = Keypair.generate();
        await fund(taker2);
        console.log("Taker2:", taker2.publicKey.toBase58());

        const taker2PaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker2.publicKey);

        // mint the bonds to taker's payment ATA
        const taker2PaymentAccountInfo = await getOrCreateAssociatedTokenAccount(
            provider.connection,
            admin,
            usdcMint,
            taker2.publicKey
        );
        assert(
            taker2PaymentAccountInfo.address.equals(taker2PaymentAccount),
            "taker2 payment ATA mismatch"
        );
        await mintTo(
            provider.connection,
            admin,
            usdcMint,
            taker2PaymentAccount,
            admin,
            1_000_000 //sufficient for bond
        );

        const commitQuoteIx2 = await program.methods
            .commitQuote(Array.from(commit_hash), Array.from(liquidity_proof))
            .accounts({
                taker: taker2.publicKey,
                config: configPda,
                rfq: rfqPDA,
                usdcMint: usdcMint,
                instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
                takerPaymentAccount: taker2PaymentAccount,
            }).instruction();

        const tx2 = new anchor.web3.Transaction();
        tx2.add(ed25519Ix);
        tx2.add(commitQuoteIx2);
        let failed = false;
        try {
            await provider.sendAndConfirm(tx2, [taker2], { skipPreflight: false });
        } catch {
            failed = true;
        }
        assert(failed, "commit-guard / commit quote with same hash should fail");

        console.log("Testing that same taker cannot commit twice...");
        failed = false;
        const commitQuoteIx3 = await program.methods
            .commitQuote(Array.from(commit_hash), Array.from(liquidity_proof))
            .accounts({
                taker: taker.publicKey,
                config: configPda,
                rfq: rfqPDA,
                usdcMint: usdcMint,
                instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
                takerPaymentAccount: takerPaymentAccount,
            }).instruction();

        const tx3 = new anchor.web3.Transaction();
        tx3.add(ed25519Ix);
        tx3.add(commitQuoteIx3);
        try {
            await provider.sendAndConfirm(tx3, [taker], { skipPreflight: false });
        } catch {
            failed = true;
        }
        assert(failed, "same taker should not commit quote twice");
    });

    it("should fail committing quote with invalid liquidity proof (invalid ED25519 signature)", async () => {
        const taker = Keypair.generate();
        await fund(taker);
        console.log("Taker:", taker.publicKey.toBase58());
        // sign RFQ id
        const rfqAddr = Buffer.from(rfqPDA.toBytes());
        const salt = nacl.sign.detached(rfqAddr, taker.secretKey);
        console.log("salt:", Buffer.from(salt).toString("hex"));

        const payload = {
            rfq: rfqPDA.toBase58(),
            taker: taker.publicKey.toBase58(),
            salt: Buffer.from(salt).toString("hex"),
            quote_mint: quoteMint.toBase58(),
            quote_amount: new anchor.BN(1_000_000_001).toString(),
            bond_amount_usdc: new anchor.BN(1_000_000).toString(),
            fee_amount_usdc: new anchor.BN(1_000).toString(),
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
        }

        const rfq = await program.account.rfq.fetch(rfqPDA);
        assert.ok(rfq.state.committed); // it was committed in previous test

        const takerPaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker.publicKey);

        // mint the bonds to taker's payment ATA
        const takerPaymentAccountInfo = await getOrCreateAssociatedTokenAccount(
            provider.connection,
            admin,
            usdcMint,
            taker.publicKey
        );
        assert(
            takerPaymentAccountInfo.address.equals(takerPaymentAccount),
            "taker payment ATA mismatch"
        );
        await mintTo(
            provider.connection,
            admin,
            usdcMint,
            takerPaymentAccount,
            admin,
            1_000_000 //sufficient for bond
        );

        const commit_hash = Buffer.from(response.commit_hash, "hex");
        const liquidity_proof = Buffer.from(response.liquidity_proof, "hex");
        if (commit_hash.length !== 32) throw new Error("commit_hash must be 32 bytes");
        if (liquidity_proof.length !== 64) throw new Error("liquidity_proof sig must be 64 bytes");
        liquidity_proof[0] ^= 0xFF; // invalidate proof
        liquidity_proof[1] ^= 0xFF; // invalidate proof

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
                config: configPda,
                rfq: rfqPDA,
                usdcMint: usdcMint,
                instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
                takerPaymentAccount,
            })
            .instruction();

        const tx = new anchor.web3.Transaction();
        tx.add(ed25519Ix);
        tx.add(commitQuoteIx1);

        let failed = false;
        try {
            await provider.sendAndConfirm(tx, [taker], { skipPreflight: false });
        } catch {
            failed = true;
        }
        assert(failed, "commitQuote with invalid liquidity proof should fail");
    });

    it("should reveal a quote", async () => {
        const taker = validTaker;
        const [quotePda, bumpQuote] = PublicKey.findProgramAddressSync(
            [Buffer.from("quote"), rfqPDA.toBuffer(), taker.publicKey.toBuffer()],
            program.programId
        );
        console.log("Quote PDA:", quotePda.toBase58());

        const rfqAddr = Buffer.from(rfqPDA.toBytes());
        const salt = nacl.sign.detached(rfqAddr, taker.secretKey);
        console.log("salt:", Buffer.from(salt).toString("hex"));
        const isValid = nacl.sign.detached.verify(
            rfqAddr,
            salt,
            taker.publicKey.toBytes()
        );
        assert(isValid, "signature failed to verify");

        let failed = false;
        try {
            await program.methods
                .revealQuote(Array.from(salt), new anchor.BN(1_000_000_001))
                .accounts({ rfq: rfqPDA, quote: quotePda, taker: taker.publicKey, config: configPda })
                .signers([taker])
                .rpc();
        } catch {
            failed = true;
        }
        assert(failed, "revealQuote should fail before commit deadline");

        failed = false;
        try {
            const fakeSalt = salt.slice();
            fakeSalt[0] ^= 0xFF; // invalidate salt
            await program.methods
                .revealQuote(Array.from(fakeSalt), new anchor.BN(1_000_000_001))
                .accounts({ rfq: rfqPDA, quote: quotePda, taker: taker.publicKey, config: configPda })
                .signers([taker])
                .rpc();
        } catch {
            failed = true;
        }
        assert(failed, "revealQuote should fail with wrong salt");

        const rfqAfterCommit = await program.account.rfq.fetch(rfqPDA);
        const openedAt = rfqAfterCommit.openedAt?.toNumber();
        assert.ok(openedAt, "rfq openedAt should be set");
        const commitDeadline = openedAt + toNum(rfqAfterCommit.commitTtlSecs);

        console.log("Waiting for commit deadline to pass on-chain...");
        await waitForChainTime(provider.connection, commitDeadline, "commit deadline");
        console.log("Reveal period begins (past commit deadline)...");

        await program.methods
            .revealQuote(Array.from(salt), new anchor.BN(1_000_000_001))
            .accounts({ rfq: rfqPDA, quote: quotePda, taker: taker.publicKey, config: configPda })
            .signers([taker])
            .rpc();

        const [quote, rfq] = await Promise.all([
            program.account.quote.fetch(quotePda),
            program.account.rfq.fetch(rfqPDA),
        ]);
        assert(quote.taker.equals(taker.publicKey));
        assert(quote.rfq.equals(rfqPDA));
        assert.strictEqual(quote.bump, bumpQuote, "quote bump mismatch");
        assert.ok(quote.revealedAt.toNumber() > 0, "revealedAt should be set after reveal");
        assert.ok(quote.quoteAmount.eq(new anchor.BN(1_000_000_001)), "quoteAmount mismatch");
        assert.ok(rfq.state.revealed);
        assert.strictEqual(rfq.revealedCount, 1, "rfq revealedCount should be 1");

        failed = false;
        try {
            await program.methods
                .revealQuote(Array.from(salt), new anchor.BN(1_000_000_001))
                .accounts({ rfq: rfqPDA, quote: quotePda, taker: taker.publicKey, config: configPda })
                .signers([taker])
                .rpc();
        } catch {
            failed = true;
        }
        assert(failed, "revealQuote should fail because already revealed");
    });

    it("should select a quote and create settlement account", async () => {
        const taker = validTaker;
        const [quotePda, bumpQuote] = PublicKey.findProgramAddressSync(
            [Buffer.from("quote"), rfqPDA.toBuffer(), taker.publicKey.toBuffer()],
            program.programId
        );
        const [settlementPda, bumpSettlement] = PublicKey.findProgramAddressSync(
            [Buffer.from("settlement"), rfqPDA.toBuffer()],
            program.programId
        );

        const baseAmount = 1_000_000_000;
        const vaultBaseATA = getAssociatedTokenAddressSync(baseMint, rfqPDA, true);
        const makerBaseAccount = getAssociatedTokenAddressSync(baseMint, maker.publicKey);
        const makerBaseAccountInfo = await getOrCreateAssociatedTokenAccount(
            provider.connection,
            admin,
            baseMint,
            maker.publicKey
        );
        assert(
            makerBaseAccountInfo.address.equals(makerBaseAccount),
            "maker base ATA mismatch"
        );
        await mintTo(
            provider.connection,
            admin,
            baseMint,
            makerBaseAccount,
            admin,
            baseAmount // as needed for settlement and set in RFQ
        );
        console.log("Minted base tokens to maker's base ATA:", makerBaseAccount.toBase58());

        let failed = false;
        try {
            await program.methods.selectQuote()
                .accounts({
                    maker: maker.publicKey,
                    rfq: rfqPDA,
                    quote: quotePda,
                    baseMint,
                    quoteMint,
                    vaultBaseAta: vaultBaseATA,
                    makerBaseAccount,
                })
                .signers([maker])
                .rpc();
        } catch {
            failed = true;
        }
        assert(failed, "selectQuote should fail because too early");

        const rfqAfterReveal = await program.account.rfq.fetch(rfqPDA);
        const openedAt = rfqAfterReveal.openedAt?.toNumber();
        assert.ok(openedAt, "rfq openedAt should be set");
        const revealDeadline =
            openedAt + toNum(rfqAfterReveal.commitTtlSecs) + toNum(rfqAfterReveal.revealTtlSecs);

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
                vaultBaseAta: vaultBaseATA,
                makerBaseAccount,
                config: configPda,
            })
            .signers([maker])
            .rpc();

        let [makerBaseBalance, vaultBaseBalance] = await Promise.all([
            getAndLogBalance("After selecting quote", "Base Amount for Maker", makerBaseAccount),
            getAndLogBalance("After selecting quote", "Base Amount in RFQ Vault", vaultBaseATA),
        ]);
        const makerQuoteAccount = getAssociatedTokenAddressSync(quoteMint, maker.publicKey);

        console.log("Quote PDA:", quotePda.toBase58());
        console.log("Rfq PFA:", rfqPDA.toBase58());
        console.log("Settlement PDA:", settlementPda.toBase58());

        const [quote, rfq] = await Promise.all([
            program.account.quote.fetch(quotePda),
            program.account.rfq.fetch(rfqPDA),
        ]);

        const settlement = await program.account.settlement.fetch(settlementPda);

        assert.ok(rfq.state.selected, "rfq state should be selected");
        assert.ok(rfq.selectedAt!.toNumber() > 0, "rfq selectedAt should be set");
        assert.strictEqual(quote.bump, bumpQuote, "quote bump mismatch");
        assert.ok(rfq.selectedQuote!.equals(quotePda), "rfq selectedQuote mismatch");
        assert.ok(rfq.settlement!.equals(settlementPda), "rfq settlement mismatch");

        assert(settlement.rfq.equals(rfqPDA), "settlement rfq mismatch");
        assert.strictEqual(settlement.bump, bumpSettlement, "settlement bump mismatch");
        assert(settlement.baseMint.equals(rfq.baseMint), "settlement baseMint mismatch");
        assert(settlement.quoteMint.equals(rfq.quoteMint), "settlement quoteMint mismatch");
        assert(settlement.baseAmount.eq(rfq.baseAmount), "settlement baseAmount mismatch");
        assert(settlement.quoteAmount!.eq(quote.quoteAmount!), "settlement quoteAmount mismatch");
        assert(settlement.bondAmount.eq(rfq.bondAmount), "settlement bondAmount mismatch");
        assert(settlement.feeAmount.eq(rfq.feeAmount), "settlement feeAmount mismatch");
        assert.ok(settlement.createdAt!.toNumber() > 0, "settlement createdAt should be set");
        assert.strictEqual(settlement.completedAt, null, "settlement completedAt should be None");
        assert(settlement.makerFundedAt.toNumber() > 0, "settlement makerFundedAt should be set");
        assert.strictEqual(settlement.takerFundedAt, null, "settlement takerFundedAt should be None");
        assert(settlement.maker.equals(maker.publicKey), "settlement maker mismatch");
        assert(settlement.taker.equals(taker.publicKey), "settlement taker mismatch");
        assert(settlement.makerPaymentAccount.equals(makerPaymentAccount), "settlement makerPaymentAccount mismatch");
        assert(settlement.takerPaymentAccount.equals(quote.takerPaymentAccount), "settlement takerPaymentAccount mismatch");
        assert(settlement.bondsFeesVault.equals(bondsFeesVault), "settlement bondsFeesVault mismatch");
        assert(settlement.makerBaseAccount.equals(makerBaseAccount), "settlement makerBaseAccount mismatch");
        assert.strictEqual(settlement.takerBaseAccount, null, "settlement takerBaseAccount should be None");
        assert(settlement.vaultBaseAta.equals(vaultBaseATA), "settlement vaultBaseAta mismatch");
        assert(makerBaseBalance.eq(new anchor.BN(0)), "Maker base account should be zero after selection");
        assert(vaultBaseBalance.eq(rfq.baseAmount), "RFQ vault base account balance mismatch after selection");
        assert(settlement.makerQuoteAccount.equals(makerQuoteAccount), "settlement makerQuoteAccount mismatch");
        assert(settlement.takerQuoteAccount === null, "settlement takerQuoteAccount should be None");

        failed = false;
        try {
            await program.methods.selectQuote()
                .accounts({
                    maker: maker.publicKey,
                    rfq: rfqPDA,
                    quote: quotePda,
                    baseMint,
                    quoteMint,
                    vaultBaseAta: vaultBaseATA,
                    makerBaseAccount,
                })
                .signers([maker])
                .rpc();
        } catch {
            failed = true;
        }
        assert(failed, "selectQuote should fail because already selected and settlement already created");
    });
});

export interface CheckResponse {
    rfq: string;
    salt: string;
    taker: string;
    usdc_mint: string;
    quote_mint: string;
    quote_amount: string;
    bond_amount_usdc: string;
    fee_amount_usdc: string;
    service_pubkey: string;
    commit_hash: string;
    liquidity_proof: string;
    network: string;
    skip_fund_checks: boolean;
    timestamp: number;
}

export interface ErrorResponse {
    error: string;
}

export type CheckResult = CheckResponse | ErrorResponse;

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);

    if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(
            `HTTP ${res.status}: ${JSON.stringify(errBody, null, 2)}`
        );
    }

    return res.json() as Promise<T>;
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForLiquidityGuardReady(maxWaitMs = 10_000, pollMs = 500) {
    const start = Date.now();
    let lastError: unknown;
    console.log(`Waiting for Liquidity Guard to be reachable (timeout ${maxWaitMs}ms)...`);

    while (Date.now() - start < maxWaitMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(pollMs, 2_000));
        try {
            const res = await fetch(`${liquidityGuardURL}/health`, { signal: controller.signal });
            if (res.ok || res.status === 404) {
                console.log("Liquidity Guard is reachable");
                return;
            }
            lastError = new Error(`HTTP ${res.status}`);
        } catch (err) {
            lastError = err;
        } finally {
            clearTimeout(timer);
        }
        await sleep(pollMs);
    }

    const suffix = lastError ? ` (last error: ${String(lastError)})` : "";
    throw new Error(`Liquidity Guard not ready after ${maxWaitMs}ms${suffix}`);
}
