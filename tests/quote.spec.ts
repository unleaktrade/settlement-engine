import * as anchor from "@coral-xyz/anchor";
import nacl from "tweetnacl";
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

    const commitTTL = 3, revealTTL = 3, selectionTTL = 3, fundingTTL = 3;

    const liquidityGuard = new PublicKey("5gfPFweV3zJovznZqBra3rv5tWJ5EHVzQY1PqvNA4HGg");

    let configPda: PublicKey;
    let usdcMint: PublicKey;
    let rfqPDA: PublicKey;
    let rfqBump: number;

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

        console.log("RFQ PDA:", rfqPDA.toBase58());

    });

    after(async () => {
        await program.methods
            .closeConfig()
            .accounts({ admin: admin.publicKey, config: configPda })
            .signers([admin])
            .rpc();
    });

    it("should check a quote", async () => {
        const taker = Keypair.generate();
        await fund(taker);
        console.log("Taker:", taker.publicKey.toBase58());

        // sign RFQ id
        const rfq = Buffer.from(rfqPDA.toBytes());
        const salt = nacl.sign.detached(rfq, taker.secretKey);
        console.log("salt:", Buffer.from(salt).toString("hex"));
        const isValid = nacl.sign.detached.verify(
            rfq,
            salt,
            taker.publicKey.toBytes()
        );
        assert(isValid, "signature failed to verify");

        const payload = {
            rfq: rfqPDA.toBase58(),
            taker: taker.publicKey.toBase58(),
            salt: Buffer.from(salt).toString("hex"),
            quote_mint: quoteMint.toBase58(),
            quote_amount: new anchor.BN(1_000_000_000).toString(),
            bond_amount_usdc: new anchor.BN(1_000_000).toString(),
            fee_amount_usdc: new anchor.BN(1_000).toString(),
        };

        const response = await fetchJson<CheckResponse>(`${liquidityGuardURL}/check`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        console.log("Liquidity Guard response:", response);
        assert(response.rfq === rfqPDA.toBase58(), `unexpected rfq ${response.rfq}`);
        assert(response.salt === Buffer.from(salt).toString("hex"), `unexpected salt ${response.salt}`);
        assert(response.taker === taker.publicKey.toBase58(), `unexpected taker ${response.taker}`);
        assert(response.quote_mint === quoteMint.toBase58(), `unexpected quote mint ${response.quote_mint}`);
        assert(response.quote_amount === "1000000000", `unexpected quote amount ${response.quote_amount}`);
        assert(response.bond_amount_usdc === "1000000", `unexpected bond amount ${response.bond_amount_usdc}`);
        assert(response.fee_amount_usdc === "1000", `unexpected fee amount ${response.fee_amount_usdc}`);
        assert(response.service_pubkey === liquidityGuard.toBase58(), `unexpected service pubkey ${response.service_pubkey}`);
        assert(response.commit_hash.length > 0, `empty commit_hash`);
        assert(response.service_signature.length > 0, `empty service_signature`);
        assert(response.network === 'Devnet', `unexpected network: ${response.network}`);
        assert(response.skip_fund_checks === true, `unexpected skip_fund_checks: ${response.skip_fund_checks}`);
        assert(response.timestamp > 0, `invalid timestamp: ${response.timestamp}`);
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
    service_signature: string;
    network: string;
    skip_fund_checks: boolean;
    timestamp: number;
}

export interface ErrorResponse {
    error: string;
}


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