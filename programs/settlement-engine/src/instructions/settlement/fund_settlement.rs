use crate::rfq_errors::RfqError;
use crate::state::rfq::{Rfq, RfqState};
use crate::state::{FeesTracker, Quote, Settlement};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT};
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_ID,
};
use anchor_lang::Discriminator;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

use super::complete_settlement::{
    COMPLETE_SETTLEMENT_RFQ_INDEX, COMPLETE_SETTLEMENT_SETTLEMENT_INDEX,
};

/// First half of the taker's settlement: everything paid in the quote mint.
///
/// - quote amount: taker → maker
/// - treasury share of the taker fee: taker → treasury quote ATA
/// - facilitator share of the taker fee: taker → fee escrow (claimed later via
///   `withdraw_reward`)
/// - creates the `FeesTracker` and sets `settlement.taker_funded_at` (the
///   funding proof that `complete_settlement` checks)
///
/// It must be a top-level instruction (no CPI) immediately followed, in the
/// same transaction, by `complete_settlement` for the same RFQ (enforced via
/// the instructions sysvar). Funding and completion are therefore atomic and
/// adjacent: the taker can never pay without the base asset being delivered
/// and the bonds released, and no other instruction can run in between.
#[derive(Accounts)]
pub struct FundSettlement<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(
        seeds = [Rfq::SEED_PREFIX, rfq.maker.key().as_ref(), rfq.uuid.as_ref()],
        bump = rfq.bump,
        constraint = matches!(rfq.state, RfqState::Selected) @ RfqError::InvalidRfqState,
    )]
    pub rfq: Box<Account<'info, Rfq>>,

    #[account(
        mut,
        seeds = [Settlement::SEED_PREFIX, rfq.key().as_ref()],
        bump = settlement.bump,
        has_one = rfq @ RfqError::InvalidRfq,
        has_one = taker @ RfqError::InvalidTaker,
        constraint = settlement.taker_funded_at.is_none() @ RfqError::InvalidRfqState,
    )]
    pub settlement: Box<Account<'info, Settlement>>,

    /// Selected quote — only read, to decide whether the facilitator gets a
    /// share. `settlement.quote` was recorded by `select_quote` from the
    /// seed-checked Quote PDA, so the address check is equivalent to the seeds.
    #[account(
        address = settlement.quote @ RfqError::InvalidQuote,
        constraint = quote.selected @ RfqError::InvalidQuoteState,
    )]
    pub quote: Box<Account<'info, Quote>>,

    #[account(address = settlement.quote_mint @ RfqError::InvalidQuoteMint)]
    pub quote_mint: Box<Account<'info, Mint>>,

    #[account(address = rfq.treasury_wallet)]
    pub treasury_wallet: SystemAccount<'info>,

    /// Quote-mint treasury ATA – receives the treasury's share of the taker fee
    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = quote_mint,
        associated_token::authority = treasury_wallet,
    )]
    pub treasury_quote_ata: Box<Account<'info, TokenAccount>>,

    /// Quote-mint fee escrow – holds the facilitator share until withdraw_reward
    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = quote_mint,
        associated_token::authority = rfq,
    )]
    pub fee_escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = settlement.maker_quote_account,
    )]
    pub maker_quote_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = taker,
    )]
    pub taker_quote_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = taker,
        space = 8 + FeesTracker::INIT_SPACE,
        seeds = [FeesTracker::SEED_PREFIX, rfq.key().as_ref()],
        bump,
    )]
    pub fees_tracker: Box<Account<'info, FeesTracker>>,

    /// CHECK: Address asserted to be the instructions sysvar
    #[account(address = INSTRUCTIONS_ID)]
    pub instruction_sysvar: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn fund_settlement_handler(ctx: Context<FundSettlement>) -> Result<()> {
    let rfq = &ctx.accounts.rfq;

    let funding_deadline = rfq.funding_deadline().ok_or(RfqError::InvalidRfqState)?;
    let now = Clock::get()?.unix_timestamp;
    require!(now <= funding_deadline, RfqError::FundingTooLate);

    require_complete_settlement_next(
        &ctx.accounts.instruction_sysvar,
        &rfq.key(),
        &ctx.accounts.settlement.key(),
    )?;

    // --- Fee split (paid in quote_mint tokens, on top of the quote amount) ---
    let settlement = &mut ctx.accounts.settlement;
    let total_fee = settlement.compute_total_fee()?;
    let facilitator_share: u64 =
        if rfq.facilitator.is_some() && rfq.facilitator == ctx.accounts.quote.facilitator {
            settlement.compute_facilitator_share(total_fee, rfq.facilitator_fee_bps)?
        } else {
            0
        };
    let treasury_share = total_fee
        .checked_sub(facilitator_share)
        .ok_or(RfqError::ArithmeticOverflow)?;

    // Treasury share → treasury_quote_ata
    if treasury_share > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.taker_quote_account.to_account_info(),
                    to: ctx.accounts.treasury_quote_ata.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                },
            ),
            treasury_share,
        )?;
    }
    // Facilitator share → fee_escrow (claimed via withdraw_reward)
    if facilitator_share > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.taker_quote_account.to_account_info(),
                    to: ctx.accounts.fee_escrow.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                },
            ),
            facilitator_share,
        )?;
    }

    // Deliver quote asset from taker to maker
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.taker_quote_account.to_account_info(),
                to: ctx.accounts.maker_quote_account.to_account_info(),
                authority: ctx.accounts.taker.to_account_info(),
            },
        ),
        settlement.quote_amount,
    )?;

    settlement.taker_funded_at = Some(now);
    settlement.taker_quote_account = Some(ctx.accounts.taker_quote_account.key());

    let fees_tracker = &mut ctx.accounts.fees_tracker;
    fees_tracker.rfq = settlement.rfq;
    fees_tracker.taker = settlement.taker;
    fees_tracker.quote_mint = rfq.quote_mint;
    fees_tracker.treasury_wallet = rfq.treasury_wallet;
    fees_tracker.amount = treasury_share;
    fees_tracker.payed_at = now;
    fees_tracker.bump = ctx.bumps.fees_tracker;

    Ok(())
}

/// This instruction must be top-level and the next one must be
/// `complete_settlement` of this program for the same RFQ and settlement. A
/// transaction either runs both or neither, back to back, so the taker can
/// never fund without the settlement completing.
#[inline(never)]
fn require_complete_settlement_next(
    instruction_sysvar: &AccountInfo,
    rfq: &Pubkey,
    settlement: &Pubkey,
) -> Result<()> {
    // The instructions sysvar only describes top-level instructions. Invoked
    // through CPI, the caller could keep running after this returns and before
    // the top-level complete_settlement (e.g. clear the quote's facilitator,
    // stranding the facilitator share in fee_escrow). Top-level only.
    require_eq!(
        get_stack_height(),
        TRANSACTION_LEVEL_STACK_HEIGHT,
        RfqError::CompleteSettlementMustFollow
    );
    let current = load_current_index_checked(instruction_sysvar)? as usize;
    let next = load_instruction_at_checked(current + 1, instruction_sysvar)
        .map_err(|_| error!(RfqError::CompleteSettlementMustFollow))?;

    require_keys_eq!(
        next.program_id,
        crate::ID,
        RfqError::CompleteSettlementMustFollow
    );
    require!(
        next.data.get(..8) == Some(crate::instruction::CompleteSettlement::DISCRIMINATOR),
        RfqError::CompleteSettlementMustFollow
    );
    let account_at = |i: usize| next.accounts.get(i).map(|meta| meta.pubkey);
    require!(
        account_at(COMPLETE_SETTLEMENT_RFQ_INDEX) == Some(*rfq),
        RfqError::CompleteSettlementMustFollow
    );
    require!(
        account_at(COMPLETE_SETTLEMENT_SETTLEMENT_INDEX) == Some(*settlement),
        RfqError::CompleteSettlementMustFollow
    );
    Ok(())
}
