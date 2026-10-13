/**
 * Client-side helpers for the two-instruction settlement:
 *
 *   [compute budget] → fund_settlement → complete_settlement
 *
 * fund_settlement (quote amount + fees, paid by the taker) must be immediately
 * followed by complete_settlement (bond refunds, base delivery, slashing,
 * state) for the same RFQ in the same transaction — the program enforces it.
 */
import { Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import assert from "assert";
import { SettlementEngine } from "../../target/types/settlement_engine";

export interface SettlementAccounts {
  taker: PublicKey;
  config: PublicKey;
  treasuryWallet: PublicKey;
  rfq: PublicKey;
  settlement: PublicKey;
  quote: PublicKey;
  slashedBondsTracker: PublicKey;
  feesTracker: PublicKey;
  usdcMint: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  takerPaymentAccount: PublicKey;
  makerPaymentAccount: PublicKey;
  vaultBaseAta: PublicKey;
  takerBaseAccount: PublicKey;
  makerQuoteAccount: PublicKey;
  takerQuoteAccount: PublicKey;
  treasuryAta: PublicKey;
  treasuryQuoteAta: PublicKey;
  feeEscrow: PublicKey;
  bondsEscrow: PublicKey;
}

/** Same CU budget the single complete_settlement used to request. */
export const SETTLEMENT_CU_LIMIT = 400_000;

export const fundSettlementIx = (
  program: Program<SettlementEngine>,
  a: SettlementAccounts
): Promise<TransactionInstruction> =>
  program.methods
    .fundSettlement()
    .accountsPartial({
      taker: a.taker,
      rfq: a.rfq,
      settlement: a.settlement,
      quote: a.quote,
      quoteMint: a.quoteMint,
      treasuryWallet: a.treasuryWallet,
      treasuryQuoteAta: a.treasuryQuoteAta,
      feeEscrow: a.feeEscrow,
      makerQuoteAccount: a.makerQuoteAccount,
      takerQuoteAccount: a.takerQuoteAccount,
      feesTracker: a.feesTracker,
      instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();

export const completeSettlementIx = (
  program: Program<SettlementEngine>,
  a: SettlementAccounts
): Promise<TransactionInstruction> =>
  program.methods
    .completeSettlement()
    .accountsPartial({
      taker: a.taker,
      config: a.config,
      treasuryWallet: a.treasuryWallet,
      rfq: a.rfq,
      settlement: a.settlement,
      quote: a.quote,
      slashedBondsTracker: a.slashedBondsTracker,
      usdcMint: a.usdcMint,
      baseMint: a.baseMint,
      treasuryAta: a.treasuryAta,
      bondsEscrow: a.bondsEscrow,
      takerPaymentAccount: a.takerPaymentAccount,
      makerPaymentAccount: a.makerPaymentAccount,
      vaultBaseAta: a.vaultBaseAta,
      takerBaseAccount: a.takerBaseAccount,
    })
    .instruction();

/** The only valid way to settle: CU limit, fund_settlement, complete_settlement. */
export const settlementTx = async (
  program: Program<SettlementEngine>,
  a: SettlementAccounts
): Promise<Transaction> =>
  new Transaction()
    .add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: SETTLEMENT_CU_LIMIT })
    )
    .add(await fundSettlementIx(program, a))
    .add(await completeSettlementIx(program, a));

/** Await a transaction that must fail with the given Anchor error name. */
export async function expectProgramError(
  pending: Promise<unknown>,
  errorName: string
): Promise<void> {
  try {
    await pending;
  } catch (err) {
    const e = err as { logs?: string[]; transactionLogs?: string[] };
    const logs = e.logs ?? e.transactionLogs ?? [];
    const text = `${String(err)}\n${logs.join("\n")}`;
    assert.ok(text.includes(errorName), `expected ${errorName}, got:\n${text}`);
    return;
  }
  assert.fail(`expected ${errorName}, but the transaction succeeded`);
}
