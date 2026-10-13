use crate::rfq_errors::RfqError;
use crate::slashing::compute_slashed_amount;
use crate::state::rfq::{Rfq, RfqState};
use crate::state::{Config, Quote, Settlement, SlashedBondsTracker};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

/// Position of `rfq` / `settlement` in `CompleteSettlement` (0-based, in field
/// order). `fund_settlement` reads them from the next instruction to make sure
/// both halves of the settlement target the same RFQ — keep in sync with the
/// struct below.
pub const COMPLETE_SETTLEMENT_RFQ_INDEX: usize = 3;
pub const COMPLETE_SETTLEMENT_SETTLEMENT_INDEX: usize = 4;

/// Second half of the taker's settlement, run right after `fund_settlement` in
/// the same transaction: refunds both bonds, delivers the base asset from the
/// vault to the taker, seizes unrevealed bonds, and marks the RFQ settled.
#[derive(Accounts)]
pub struct CompleteSettlement<'info> {
    // index 0
    #[account(mut)]
    pub taker: Signer<'info>,

    // index 1
    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    // index 2
    #[account(
        mut,
        address = rfq.treasury_wallet,
    )]
    pub treasury_wallet: SystemAccount<'info>,

    // index 3 == COMPLETE_SETTLEMENT_RFQ_INDEX
    #[account(
        mut,
        seeds = [Rfq::SEED_PREFIX, rfq.maker.key().as_ref(), rfq.uuid.as_ref()],
        bump = rfq.bump,
    )]
    pub rfq: Box<Account<'info, Rfq>>,

    // index 4 == COMPLETE_SETTLEMENT_SETTLEMENT_INDEX
    #[account(
        mut,
        seeds = [Settlement::SEED_PREFIX, rfq.key().as_ref()],
        bump = settlement.bump,
    )]
    pub settlement: Box<Account<'info, Settlement>>,

    /// CHECK: selected Quote PDA. Validated in `load_quote` (address ==
    /// settlement.quote, program-owned, Quote discriminator, selected) rather
    /// than by Anchor constraints, to keep `try_accounts` well under the 4 KiB
    /// SBF stack frame.
    #[account(mut)]
    pub quote: UncheckedAccount<'info>,

    /// CHECK: SlashedBondsTracker PDA (["slashed_bonds_tracker", rfq]).
    /// Validated in `load_slashed_bonds_tracker` (program-owned, discriminator,
    /// PDA re-derived from the stored bump, usdc_mint / treasury_wallet match).
    #[account(mut)]
    pub slashed_bonds_tracker: UncheckedAccount<'info>,

    #[account(address = rfq.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(address = settlement.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,

    /// USDC treasury ATA – receives slashed bonds only
    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = usdc_mint,
        associated_token::authority = treasury_wallet,
    )]
    pub treasury_ata: Box<Account<'info, TokenAccount>>,

    /// USDC bonds escrow (bonds only, no fees)
    #[account(
        mut,
        address = settlement.bonds_escrow,
    )]
    pub bonds_escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = taker,
    )]
    pub taker_payment_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = settlement.maker_payment_account,
    )]
    pub maker_payment_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = settlement.vault_base_ata,
    )]
    pub vault_base_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = base_mint,
        associated_token::authority = taker,
    )]
    pub taker_base_account: Box<Account<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

/// Deserialize and validate the selected quote (see `CompleteSettlement::quote`).
#[inline(never)]
fn load_quote(info: &AccountInfo, settlement: &Settlement) -> Result<Quote> {
    require_keys_eq!(*info.key, settlement.quote, RfqError::InvalidQuote);
    require_keys_eq!(*info.owner, crate::ID, RfqError::InvalidOwner);
    // checks the Quote discriminator
    let quote = Quote::try_deserialize(&mut &info.try_borrow_data()?[..])?;
    require_keys_eq!(quote.rfq, settlement.rfq, RfqError::InvalidRfqAssociation);
    require_keys_eq!(quote.taker, settlement.taker, RfqError::InvalidTaker);
    require!(quote.selected, RfqError::InvalidQuoteState);
    Ok(quote)
}

/// Deserialize and validate the RFQ's slashed-bonds tracker
/// (see `CompleteSettlement::slashed_bonds_tracker`).
#[inline(never)]
fn load_slashed_bonds_tracker(
    info: &AccountInfo,
    rfq: &Pubkey,
    usdc_mint: &Pubkey,
    treasury_wallet: &Pubkey,
) -> Result<SlashedBondsTracker> {
    require_keys_eq!(*info.owner, crate::ID, RfqError::InvalidOwner);
    // checks the SlashedBondsTracker discriminator
    let tracker = SlashedBondsTracker::try_deserialize(&mut &info.try_borrow_data()?[..])?;
    let expected = Pubkey::create_program_address(
        &[
            SlashedBondsTracker::SEED_PREFIX,
            rfq.as_ref(),
            &[tracker.bump],
        ],
        &crate::ID,
    )
    .map_err(|_| error!(RfqError::PdaMismatch))?;
    require_keys_eq!(*info.key, expected, RfqError::PdaMismatch);
    require_keys_eq!(tracker.rfq, *rfq, RfqError::InvalidRfq);
    require_keys_eq!(tracker.usdc_mint, *usdc_mint, RfqError::InvalidParams);
    require_keys_eq!(
        tracker.treasury_wallet,
        *treasury_wallet,
        RfqError::InvalidParams
    );
    Ok(tracker)
}

/// Write a handler-managed account back (discriminator + Borsh), like Anchor's
/// `Account::exit` does for typed accounts.
#[inline(never)]
fn store<T: AccountSerialize>(info: &AccountInfo, value: &T) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let mut writer: &mut [u8] = &mut data;
    value.try_serialize(&mut writer)
}

pub fn complete_settlement_handler(ctx: Context<CompleteSettlement>) -> Result<()> {
    let mut quote = load_quote(&ctx.accounts.quote, &ctx.accounts.settlement)?;
    let mut slashed_bonds_tracker = load_slashed_bonds_tracker(
        &ctx.accounts.slashed_bonds_tracker,
        &ctx.accounts.rfq.key(),
        &ctx.accounts.usdc_mint.key(),
        &ctx.accounts.treasury_wallet.key(),
    )?;

    let rfq = &mut ctx.accounts.rfq;
    let settlement = &mut ctx.accounts.settlement;

    let Some(funding_deadline) = rfq.funding_deadline() else {
        return err!(RfqError::InvalidRfqState);
    };
    let now = Clock::get()?.unix_timestamp;
    require!(now <= funding_deadline, RfqError::FundingTooLate);
    require!(
        matches!(rfq.state, RfqState::Selected),
        RfqError::InvalidRfqState
    );
    require!(
        rfq.config == ctx.accounts.config.key(),
        RfqError::InvalidConfig
    );
    require!(settlement.rfq == rfq.key(), RfqError::InvalidRfq);
    require!(
        settlement.taker == ctx.accounts.taker.key(),
        RfqError::InvalidTaker
    );
    require!(
        settlement.taker_payment_account == ctx.accounts.taker_payment_account.key(),
        RfqError::InvalidTakerPaymentAccount
    );
    // Only fund_settlement sets taker_funded_at, and it requires this
    // instruction to follow it in the same transaction: Some(_) here means the
    // quote amount and fees were paid moments ago, atomically with this call.
    require!(
        settlement.taker_funded_at.is_some(),
        RfqError::SettlementNotFunded
    );

    let seeds_rfq: &[&[u8]] = &[
        Rfq::SEED_PREFIX,
        rfq.maker.as_ref(),
        rfq.uuid.as_ref(),
        &[rfq.bump],
    ];

    // Refund maker's bond (USDC)
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.bonds_escrow.to_account_info(),
                to: ctx.accounts.maker_payment_account.to_account_info(),
                authority: rfq.to_account_info(),
            },
            &[seeds_rfq],
        ),
        settlement.bond_amount,
    )?;

    // Refund taker's bond (USDC)
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.bonds_escrow.to_account_info(),
                to: ctx.accounts.taker_payment_account.to_account_info(),
                authority: rfq.to_account_info(),
            },
            &[seeds_rfq],
        ),
        settlement.bond_amount,
    )?;

    // Deliver base asset from vault to taker
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_base_ata.to_account_info(),
                to: ctx.accounts.taker_base_account.to_account_info(),
                authority: rfq.to_account_info(),
            },
            &[seeds_rfq],
        ),
        settlement.base_amount,
    )?;

    if !slashed_bonds_tracker.is_resolved() {
        // Seize only unrevealed bonds (USDC) and send them to the treasury
        let seized_amount = compute_slashed_amount(rfq, false)?;

        if seized_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.bonds_escrow.to_account_info(),
                        to: ctx.accounts.treasury_ata.to_account_info(),
                        authority: rfq.to_account_info(),
                    },
                    &[seeds_rfq],
                ),
                seized_amount,
            )?;
        }

        slashed_bonds_tracker.amount = Some(seized_amount);
        slashed_bonds_tracker.seized_at = Some(now);
        store(&ctx.accounts.slashed_bonds_tracker, &slashed_bonds_tracker)?;
    }

    // update rfq
    rfq.state = RfqState::Settled;
    rfq.completed_at = Some(now);
    // update settlement (taker_funded_at / taker_quote_account set by fund_settlement)
    settlement.completed_at = Some(now);
    settlement.taker_base_account = Some(ctx.accounts.taker_base_account.key());

    quote.bonds_refunded_at = Some(now);
    store(&ctx.accounts.quote, &quote)?;

    Ok(())
}
