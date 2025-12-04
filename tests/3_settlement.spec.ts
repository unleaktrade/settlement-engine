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
import { CheckResult, fetchJson } from "./2_quote.spec";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;
const program = anchor.workspace.SettlementEngine as Program<SettlementEngine>;

const liquidityGuardURL = "https://liquidity-guard-devnet-skip-c644b6411603.herokuapp.com";

const confirm = async (signature: string) => {
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...bh });
}

const fund = async (kp: Keypair, sol = 2) => {
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

const getAndLogBalance = async (label: string, owner: string, tokenAccount: PublicKey) => {
    const balance = await provider.connection.getTokenAccountBalance(tokenAccount).then(b => new anchor.BN(b.value.amount));
    console.log(`${label} - ${owner}:`, balance.toNumber().toLocaleString("en-US"));
    return balance;
}

const provideLiquidityGuardAttestation = async (taker: anchor.web3.Keypair,
    rfqPDA: anchor.web3.PublicKey,
    quoteMint: anchor.web3.PublicKey) => {
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
    } else {
        return [
            Buffer.from(response.commit_hash, "hex"),
            Buffer.from(response.liquidity_proof, "hex"),
        ];
    }

}

describe("SETTLEMENT", () => {
    let configPda: PublicKey;
    let usdcMint: PublicKey;
    let baseMint: PublicKey;
    let quoteMint: PublicKey;

    const admin = Keypair.generate();
    const treasury = Keypair.generate();
    const commitTTL = 10, revealTTL = 10, selectionTTL = 10, fundingTTL = 10;

    const liquidityGuard = new PublicKey("5gfPFweV3zJovznZqBra3rv5tWJ5EHVzQY1PqvNA4HGg");

    before(async () => {
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
        // console.log("All RFQ:", JSON.stringify((await program.account.rfq.all()),null,2));
        // console.log("All QUOTE:", JSON.stringify((await program.account.quote.all()),null,2));
        // console.log("All COMMIT GUARDS:", JSON.stringify((await program.account.commitGuard.all()),null,2));
        // console.log("All SETTLEMENT:", JSON.stringify((await program.account.settlement.all()),null,2));
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
        const taker = Keypair.generate();
        await fund(taker);
        console.log("Taker:", taker.publicKey.toBase58());

        const u = uuidBytes();
        const [rfqPDA, rfqBump] = rfqPda(maker.publicKey, u);
        //TODO: mint usdc, base and quote.
        const makerPaymentAccount = getAssociatedTokenAddressSync(usdcMint, maker.publicKey);
        const makerBaseAccount = getAssociatedTokenAddressSync(baseMint, maker.publicKey);
        const makerQuoteAccount = getAssociatedTokenAddressSync(quoteMint, maker.publicKey);
        const takerPaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker.publicKey);
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
                1_000_000 //sufficient for bonds
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
                1_000_000_000
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
                2_000_000 //sufficient for bonds + fees
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
                1_000_000_000
            )),
        ]);

        await Promise.all([
            getAndLogBalance("START", "Maker USDC", makerPaymentAccount),
            getAndLogBalance("START", "Maker Base", makerBaseAccount),
            getAndLogBalance("START", "Taker USDC", takerPaymentAccount),
            getAndLogBalance("START", "Taker Quote", takerQuoteAccount),
        ]);

        //INIT RFQ
        let failed = false;
        try {
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
        } catch (e) {
            failed = true;
            console.log("initRfq failed:", e);
        }

        await getAndLogBalance("Before opening RFQ", "RFQ Bonds Vault", bondsFeesVault);

        console.log("Rfq PDA:", rfqPDA.toBase58());

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

        const [commit_hash, liquidity_proof] = await provideLiquidityGuardAttestation(taker, rfqPDA, quoteMint);
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

        const [quotePda, bumpQuote] = PublicKey.findProgramAddressSync(
            [Buffer.from("quote"), rfqPDA.toBuffer(), taker.publicKey.toBuffer()],
            program.programId
        );
        console.log("Quote PDA:", quotePda.toBase58());

        const [commitGuardPda, bumpCommit] = PublicKey.findProgramAddressSync(
            [Buffer.from("commit-guard"), commit_hash],
            program.programId
        );
        console.log("Commit Guard PDA:", commitGuardPda.toBase58());

    });



});