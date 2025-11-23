import * as anchor from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import { Program } from "@coral-xyz/anchor";
import { SettlementEngine } from "../target/types/settlement_engine";
import { Ed25519Program, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
    createMint,
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { v4 as uuidv4, parse as uuidParse } from "uuid";
import assert from "assert";

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
    const baseMint = Keypair.generate().publicKey;
    const quoteMint = Keypair.generate().publicKey;

    const commitTTL = 5, revealTTL = 5, selectionTTL = 5, fundingTTL = 5;

    const liquidityGuard = new PublicKey("5gfPFweV3zJovznZqBra3rv5tWJ5EHVzQY1PqvNA4HGg");

    let configPda: PublicKey;
    let usdcMint: PublicKey;
    let rfqPDA: PublicKey;
    let rfqBump: number;
    let validTaker: Keypair;

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
            // bonds_vault = ATA(owner = rfq PDA, mint = usdcMint)
            const bondsVault = getAssociatedTokenAddressSync(usdcMint, rfqPDA, true);

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

        await program.methods.openRfq()
            .accounts({
                maker: maker.publicKey,
                rfq: rfqPDA,
                config: configPda,
            })
            .signers([maker])
            .rpc();

        console.log("RFQ PDA:", rfqPDA.toBase58());

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
            console.log("Liquidity Guard response:", response);
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

        const rfq = await program.account.rfq.fetch(rfqPDA);
        assert.ok(rfq.state.open);

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
                config: configPda,
                rfq: rfqPDA,
                usdcMint: usdcMint,
                instruction_sysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
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
        assert(quote.isValid === false, "quote should not be valid before reveal");
        assert(quote.revealedAt === null, "revealedAt should be None before reveal");
        assert(quote.quoteAmount === null, "quoteAmount should be None before reveal");
        assert.strictEqual(quote.bump, bumpQuote, "quote bump mismatch");

        const [commitGuardPda, bumpCommit] = PublicKey.findProgramAddressSync(
            [Buffer.from("commit-guard"), commit_hash],
            program.programId
        );
        console.log("Commit Guard PDA:", commitGuardPda.toBase58());

        const commitGuard = await program.account.commitGuard.fetch(commitGuardPda);
        assert.strictEqual(commitGuard.bump, bumpCommit, "commit guard bump mismatch");
        assert.ok(commitGuard.committedAt.eq(quote.committedAt), "committedAt mismatch");
        // save valid taker for reveal test
        validTaker = taker;

        // test commit guard prevents re-use of hash
        const taker2 = Keypair.generate();
        await fund(taker2);
        console.log("Taker2:", taker2.publicKey.toBase58());
        const commitQuoteIx2 = await program.methods
            .commitQuote(Array.from(commit_hash), Array.from(liquidity_proof))
            .accounts({
                taker: taker2.publicKey,
                config: configPda,
                rfq: rfqPDA,
                usdcMint: usdcMint,
                instruction_sysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
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

        failed = false;
        const commitQuoteIx3 = await program.methods
            .commitQuote(Array.from(commit_hash), Array.from(liquidity_proof))
            .accounts({
                taker: taker.publicKey,
                config: configPda,
                rfq: rfqPDA,
                usdcMint: usdcMint,
                instruction_sysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
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
                instruction_sysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
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
        assert.ok(quote.isValid, "quote should be valid after reveal");
        assert.ok(quote.revealedAt.toNumber() > 0, "revealedAt should be set after reveal");
        assert.ok(quote.quoteAmount.eq(new anchor.BN(1_000_000_001)), "quoteAmount mismatch");
        assert.ok(rfq.state.revealed);
        assert.strictEqual(rfq.revealedCount, 1, "rfq revealedCount should be 1");
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

type CheckResult = CheckResponse | ErrorResponse;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);

    if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(
            `HTTP ${res.status}: ${JSON.stringify(errBody, null, 2)}`
        );
    }

    return res.json() as Promise<T>;
}