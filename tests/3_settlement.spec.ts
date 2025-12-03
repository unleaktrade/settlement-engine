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

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;
const program = anchor.workspace.SettlementEngine as Program<SettlementEngine>;

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

async function getAndLogBalance(
    label: string,
    owner: string,
    tokenAccount: PublicKey,) {
    const balance = await provider.connection.getTokenAccountBalance(tokenAccount).then(b => new anchor.BN(b.value.amount));
    console.log(`${label} - ${owner}:`, balance.toNumber().toLocaleString("en-US"));
    return balance;
}

describe("SETTLEMENT", () => {
    let configPda: PublicKey;
    let usdcMint: PublicKey;
    let baseMint: PublicKey;
    let quoteMint: PublicKey;

    const admin = Keypair.generate();
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
            const treasury = Keypair.generate().publicKey;
            await program.methods
                .initConfig(usdcMint, treasury, liquidityGuard)
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
        const bondsFeesVault = getAssociatedTokenAddressSync(usdcMint, rfqPDA, true);
        const makerPaymentAccount = getAssociatedTokenAddressSync(usdcMint, maker.publicKey);
        const takerPaymentAccount = getAssociatedTokenAddressSync(usdcMint, taker.publicKey);
        const makerBaseAccount = getAssociatedTokenAddressSync(baseMint, maker.publicKey);
        const takerBaseAccount = getAssociatedTokenAddressSync(baseMint, taker.publicKey);
        const makerQuoteAccount = getAssociatedTokenAddressSync(quoteMint, maker.publicKey);
        const takerQuoteAccount = getAssociatedTokenAddressSync(quoteMint, taker.publicKey);

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
        await Promise.all([
            getAndLogBalance("Before opening RFQ", "Maker USDC", makerPaymentAccount),
            getAndLogBalance("Before opening RFQ", "Taker USDC", takerPaymentAccount),
            getAndLogBalance("Before opening RFQ", "RFQ Bonds Vault", bondsFeesVault),
        ]);
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

    });

    after(async () => {
        await program.methods
            .closeConfig()
            .accounts({ admin: admin.publicKey, config: configPda })
            .signers([admin])
            .rpc();
    });

});