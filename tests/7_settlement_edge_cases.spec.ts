import * as anchor from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import { Program } from "@coral-xyz/anchor";
import { SettlementEngine } from "../target/types/settlement_engine";
import { ComputeBudgetProgram, Ed25519Program, Keypair, PublicKey } from "@solana/web3.js";
import {
    createAccount,
    createCloseAccountInstruction,
    createMint,
    getAccount,
    getAssociatedTokenAddressSync,
    getOrCreateAssociatedTokenAccount,
    mintTo,
} from "@solana/spl-token";
import assert from "assert";
import { liquidityGuardHeaders, liquidityGuardURL } from "./utils/liquidityGuard";
import { waitForChainTime } from "./utils/time";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;
const program = anchor.workspace.SettlementEngine as Program<SettlementEngine>;

const liquidityGuard = new PublicKey("5gfPFweV3zJovznZqBra3rv5tWJ5EHVzQY1PqvNA4HGg");
const QUOTE_AMOUNT = 1_000_000_001;
const MIN_QUOTE_AMOUNT = 1_000_000_000;
const BASE_AMOUNT = 1_000_000_000;
const BOND_AMOUNT = 1_000_000;
const TAKER_FEE_BPS = 1_000;
// Mirrors Settlement::compute_total_fee / compute_facilitator_share (config default 1000 bps)
const TOTAL_FEE = Math.floor((QUOTE_AMOUNT * TAKER_FEE_BPS) / 10_000);
const FACILITATOR_SHARE = Math.floor((TOTAL_FEE * 1_000) / 10_000);
const TREASURY_SHARE = TOTAL_FEE - FACILITATOR_SHARE;
const commitTTL = 10, revealTTL = 3, selectionTTL = 3, fundingTTL = 4;

const confirm = async (signature: string) => {
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...bh });
};

const fund = async (kp: Keypair, sol = 2) =>
    confirm(await provider.connection.requestAirdrop(kp.publicKey, sol * anchor.web3.LAMPORTS_PER_SOL));

const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];

const balance = async (account: PublicKey) =>
    Number((await provider.connection.getTokenAccountBalance(account)).value.amount);

const uuid = () => Uint8Array.from(nacl.randomBytes(16));

type Ctx = {
    maker: Keypair;
    takers: Keypair[];
    quoteMint: PublicKey;
    rfqPDA: PublicKey;
    settlementPDA: PublicKey;
    slashedBondsTrackerPDA: PublicKey;
    bondsEscrow: PublicKey;
    selectedAt: number;
};

describe("SETTLEMENT EDGE CASES", () => {
    let configPda: PublicKey;
    let usdcMint: PublicKey;
    let baseMint: PublicKey;
    let otherQuoteMint: PublicKey;

    const admin = Keypair.generate();
    const treasury = Keypair.generate();

    const mintToAta = async (mint: PublicKey, owner: PublicKey, amount: number) => {
        const ata = await getOrCreateAssociatedTokenAccount(provider.connection, admin, mint, owner);
        if (amount > 0) await mintTo(provider.connection, admin, mint, ata.address, admin, amount);
        return ata.address;
    };

    const commitQuote = async (taker: Keypair, rfqPDA: PublicKey, quoteMint: PublicKey, facilitator: PublicKey | null) => {
        const salt = nacl.sign.detached(rfqPDA.toBytes(), taker.secretKey);
        const res = await fetch(`${liquidityGuardURL}/check`, {
            method: "POST",
            headers: liquidityGuardHeaders(),
            body: JSON.stringify({
                rfq: rfqPDA.toBase58(),
                taker: taker.publicKey.toBase58(),
                salt: Buffer.from(salt).toString("hex"),
                quote_mint: quoteMint.toBase58(),
                quote_amount: QUOTE_AMOUNT.toString(),
                bond_amount_usdc: BOND_AMOUNT.toString(),
                taker_fee_bps: TAKER_FEE_BPS.toString(),
            }),
        });
        assert.ok(res.ok, `liquidity-guard /check failed: HTTP ${res.status}`);
        const body = await res.json() as { commit_hash: string; liquidity_proof: string };
        const commitHash = Buffer.from(body.commit_hash, "hex");
        const liquidityProof = Buffer.from(body.liquidity_proof, "hex");

        const commitIx = await program.methods
            .commitQuote(Array.from(commitHash), Array.from(liquidityProof), facilitator)
            .accounts({
                taker: taker.publicKey,
                rfq: rfqPDA,
                usdcMint,
                config: configPda,
                instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
                takerPaymentAccount: getAssociatedTokenAddressSync(usdcMint, taker.publicKey),
            })
            .instruction();
        const tx = new anchor.web3.Transaction()
            .add(Ed25519Program.createInstructionWithPublicKey({
                publicKey: liquidityGuard.toBytes(),
                message: commitHash,
                signature: liquidityProof,
            }))
            .add(commitIx);
        await provider.sendAndConfirm(tx, [taker]);
        return salt;
    };

    /** Open an RFQ, commit + reveal one quote per taker, and let the maker select takers[0]. */
    const runToSelection = async (quoteMint: PublicKey, takerCount: number, facilitator: PublicKey | null): Promise<Ctx> => {
        const maker = Keypair.generate();
        const takers = Array.from({ length: takerCount }, () => Keypair.generate());
        await Promise.all([maker, ...takers].map(kp => fund(kp)));

        const quoteIsUsdc = quoteMint.equals(usdcMint);
        // the maker holds exactly the bond, so its USDC ATA is empty (closable) once the RFQ is open
        await mintToAta(usdcMint, maker.publicKey, BOND_AMOUNT);
        await mintToAta(baseMint, maker.publicKey, BASE_AMOUNT);
        for (const [i, taker] of takers.entries()) {
            const settles = i === 0;
            await mintToAta(usdcMint, taker.publicKey, BOND_AMOUNT + (settles && quoteIsUsdc ? QUOTE_AMOUNT + TOTAL_FEE : 0));
            if (settles && !quoteIsUsdc) await mintToAta(quoteMint, taker.publicKey, QUOTE_AMOUNT + TOTAL_FEE);
        }

        const u = uuid();
        const rfqPDA = pda(Buffer.from("rfq"), maker.publicKey.toBuffer(), Buffer.from(u));
        const bondsEscrow = getAssociatedTokenAddressSync(usdcMint, rfqPDA, true);
        const makerPaymentAccount = getAssociatedTokenAddressSync(usdcMint, maker.publicKey);

        await program.methods
            .initRfq(Array.from(u), baseMint, quoteMint, new anchor.BN(BOND_AMOUNT), new anchor.BN(BASE_AMOUNT),
                new anchor.BN(MIN_QUOTE_AMOUNT), TAKER_FEE_BPS, commitTTL, revealTTL, selectionTTL, fundingTTL, facilitator)
            .accounts({ maker: maker.publicKey, config: configPda, usdcMint, bondsEscrow, makerPaymentAccount })
            .signers([maker])
            .rpc();
        await program.methods.openRfq()
            .accounts({ maker: maker.publicKey, rfq: rfqPDA, config: configPda, bondsEscrow, makerPaymentAccount, usdcMint })
            .signers([maker])
            .rpc();

        const salts: Uint8Array[] = [];
        for (const [i, taker] of takers.entries()) {
            salts.push(await commitQuote(taker, rfqPDA, quoteMint, i === 0 ? facilitator : null));
        }

        const rfq = await program.account.rfq.fetch(rfqPDA);
        const commitDeadline = rfq.openedAt!.toNumber() + commitTTL;
        await waitForChainTime(provider.connection, commitDeadline, "commit deadline");
        for (const [i, taker] of takers.entries()) {
            await program.methods.revealQuote(Array.from(salts[i]), new anchor.BN(QUOTE_AMOUNT))
                .accounts({ rfq: rfqPDA, quote: pda(Buffer.from("quote"), rfqPDA.toBuffer(), taker.publicKey.toBuffer()), taker: taker.publicKey, config: configPda })
                .signers([taker])
                .rpc();
        }
        await waitForChainTime(provider.connection, commitDeadline + revealTTL, "reveal deadline");

        await program.methods.selectQuote()
            .accounts({
                maker: maker.publicKey,
                rfq: rfqPDA,
                quote: pda(Buffer.from("quote"), rfqPDA.toBuffer(), takers[0].publicKey.toBuffer()),
                baseMint,
                quoteMint,
                vaultBaseAta: getAssociatedTokenAddressSync(baseMint, rfqPDA, true),
                makerBaseAccount: getAssociatedTokenAddressSync(baseMint, maker.publicKey),
                config: configPda,
            })
            .signers([maker])
            .rpc();
        const selected = await program.account.rfq.fetch(rfqPDA);

        return {
            maker,
            takers,
            quoteMint,
            rfqPDA,
            settlementPDA: pda(Buffer.from("settlement"), rfqPDA.toBuffer()),
            slashedBondsTrackerPDA: pda(Buffer.from("slashed_bonds_tracker"), rfqPDA.toBuffer()),
            bondsEscrow,
            selectedAt: selected.selectedAt!.toNumber(),
        };
    };

    const completeSettlement = async (ctx: Ctx) => {
        const taker = ctx.takers[0];
        const ix = await program.methods.completeSettlement()
            .accounts({
                taker: taker.publicKey,
                config: configPda,
                treasuryWallet: treasury.publicKey,
                rfq: ctx.rfqPDA,
                settlement: ctx.settlementPDA,
                maker: ctx.maker.publicKey,
                usdcMint,
                baseMint,
                quoteMint: ctx.quoteMint,
                takerPaymentAccount: getAssociatedTokenAddressSync(usdcMint, taker.publicKey),
                makerPaymentAccount: getAssociatedTokenAddressSync(usdcMint, ctx.maker.publicKey),
                vaultBaseAta: getAssociatedTokenAddressSync(baseMint, ctx.rfqPDA, true),
                takerBaseAccount: getAssociatedTokenAddressSync(baseMint, taker.publicKey),
                makerQuoteAccount: getAssociatedTokenAddressSync(ctx.quoteMint, ctx.maker.publicKey),
                takerQuoteAccount: getAssociatedTokenAddressSync(ctx.quoteMint, taker.publicKey),
                feesTracker: pda(Buffer.from("fees_tracker"), ctx.rfqPDA.toBuffer()),
                treasuryAta: getAssociatedTokenAddressSync(usdcMint, treasury.publicKey),
                treasuryQuoteAta: getAssociatedTokenAddressSync(ctx.quoteMint, treasury.publicKey),
                feeEscrow: getAssociatedTokenAddressSync(ctx.quoteMint, ctx.rfqPDA, true),
                bondsEscrow: ctx.bondsEscrow,
            })
            .remainingAccounts([
                { pubkey: pda(Buffer.from("quote"), ctx.rfqPDA.toBuffer(), taker.publicKey.toBuffer()), isSigner: false, isWritable: true },
                { pubkey: ctx.slashedBondsTrackerPDA, isSigner: false, isWritable: true },
            ])
            .instruction();
        const tx = new anchor.web3.Transaction()
            .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
            .add(ix);
        await provider.sendAndConfirm(tx, [taker]);
    };

    before(async () => {
        const health = await fetch(`${liquidityGuardURL}/health`);
        assert.ok(health.ok, "liquidity-guard should be reachable");
        await fund(admin);
        [usdcMint, baseMint, otherQuoteMint] = await Promise.all(
            [6, 9, 9].map(d => createMint(provider.connection, admin, admin.publicKey, null, d))
        );
        configPda = pda(Buffer.from("config"));
        await program.methods
            .initConfig(usdcMint, treasury.publicKey, liquidityGuard, null)
            .accounts({ admin: admin.publicKey })
            .signers([admin])
            .rpc();
    });

    after(async () => {
        await program.methods
            .closeConfig()
            .accounts({ admin: admin.publicKey, config: configPda })
            .signers([admin])
            .rpc();
    });

    it("settles end-to-end when quote_mint == usdc_mint (fee escrow is the bonds escrow)", async () => {
        const facilitator = Keypair.generate();
        await fund(facilitator);
        const ctx = await runToSelection(usdcMint, 2, facilitator.publicKey);
        const [taker, taker2] = ctx.takers;
        const takerUsdc = getAssociatedTokenAddressSync(usdcMint, taker.publicKey);
        const taker2Usdc = getAssociatedTokenAddressSync(usdcMint, taker2.publicKey);
        const makerUsdc = getAssociatedTokenAddressSync(usdcMint, ctx.maker.publicKey);
        const treasuryUsdc = getAssociatedTokenAddressSync(usdcMint, treasury.publicKey);

        // escrow = maker bond + 2 taker bonds
        assert.strictEqual(await balance(ctx.bondsEscrow), 3 * BOND_AMOUNT);

        await completeSettlement(ctx);

        // taker2's bond + the facilitator's share now share the same USDC escrow
        assert.strictEqual(await balance(ctx.bondsEscrow), BOND_AMOUNT + FACILITATOR_SHARE);
        assert.strictEqual(await balance(makerUsdc), BOND_AMOUNT + QUOTE_AMOUNT);
        assert.strictEqual(await balance(takerUsdc), BOND_AMOUNT);
        assert.strictEqual(await balance(treasuryUsdc), TREASURY_SHARE, "no unrevealed bonds, so treasury only gets its fee share");

        await program.methods.withdrawReward()
            .accounts({
                facilitator: facilitator.publicKey,
                config: configPda,
                rfq: ctx.rfqPDA,
                settlement: ctx.settlementPDA,
                quote: pda(Buffer.from("quote"), ctx.rfqPDA.toBuffer(), taker.publicKey.toBuffer()),
                quoteMint: usdcMint,
                feeEscrow: ctx.bondsEscrow,
            })
            .signers([facilitator])
            .rpc();
        assert.strictEqual(await balance(getAssociatedTokenAddressSync(usdcMint, facilitator.publicKey)), FACILITATOR_SHARE);
        assert.strictEqual(await balance(ctx.bondsEscrow), BOND_AMOUNT);

        await waitForChainTime(provider.connection, ctx.selectedAt + fundingTTL, "funding deadline");
        await program.methods.refundQuoteBonds()
            .accounts({
                taker: taker2.publicKey,
                config: configPda,
                rfq: ctx.rfqPDA,
                usdcMint,
                bondsEscrow: ctx.bondsEscrow,
                takerPaymentAccount: taker2Usdc,
                treasuryWallet: treasury.publicKey,
            })
            .signers([taker2])
            .rpc();

        assert.strictEqual(await balance(taker2Usdc), BOND_AMOUNT);
        assert.strictEqual(await balance(ctx.bondsEscrow), 0, "every bond and fee leaves the shared escrow");
    });

    it("rejects a maker payment account that is not the maker's USDC ATA", async () => {
        const maker = Keypair.generate();
        await fund(maker);
        const nonAta = await createAccount(provider.connection, admin, usdcMint, maker.publicKey, Keypair.generate());
        const u = uuid();
        const rfqPDA = pda(Buffer.from("rfq"), maker.publicKey.toBuffer(), Buffer.from(u));

        let failed = false;
        try {
            await program.methods
                .initRfq(Array.from(u), baseMint, otherQuoteMint, new anchor.BN(BOND_AMOUNT), new anchor.BN(BASE_AMOUNT),
                    new anchor.BN(MIN_QUOTE_AMOUNT), TAKER_FEE_BPS, commitTTL, revealTTL, selectionTTL, fundingTTL, null)
                .accounts({
                    maker: maker.publicKey,
                    config: configPda,
                    usdcMint,
                    bondsEscrow: getAssociatedTokenAddressSync(usdcMint, rfqPDA, true),
                    makerPaymentAccount: nonAta,
                })
                .signers([maker])
                .rpc();
        } catch {
            failed = true;
        }
        assert(failed, "initRfq should require the maker's USDC ATA (it must be re-creatable at settlement)");
    });

    it("lets the taker settle after the maker closed both payout ATAs", async () => {
        const ctx = await runToSelection(otherQuoteMint, 1, null);
        const makerUsdc = getAssociatedTokenAddressSync(usdcMint, ctx.maker.publicKey);
        const makerQuote = getAssociatedTokenAddressSync(otherQuoteMint, ctx.maker.publicKey);

        // Griefing attempt: both accounts are empty, so the maker can close them before the taker funds
        await provider.sendAndConfirm(
            new anchor.web3.Transaction()
                .add(createCloseAccountInstruction(makerUsdc, ctx.maker.publicKey, ctx.maker.publicKey))
                .add(createCloseAccountInstruction(makerQuote, ctx.maker.publicKey, ctx.maker.publicKey)),
            [ctx.maker]
        );
        assert.strictEqual(await provider.connection.getAccountInfo(makerQuote), null);

        await completeSettlement(ctx);

        const [rfq, makerUsdcAccount, makerQuoteAccount] = await Promise.all([
            program.account.rfq.fetch(ctx.rfqPDA),
            getAccount(provider.connection, makerUsdc),
            getAccount(provider.connection, makerQuote),
        ]);
        assert.ok(rfq.state.settled, "rfq should be settled despite the maker closing its accounts");
        assert.strictEqual(Number(makerUsdcAccount.amount), BOND_AMOUNT, "maker bond refunded to re-created ATA");
        assert.strictEqual(Number(makerQuoteAccount.amount), QUOTE_AMOUNT, "quote proceeds delivered to re-created ATA");
        assert.ok(makerQuoteAccount.owner.equals(ctx.maker.publicKey));
    });
});
