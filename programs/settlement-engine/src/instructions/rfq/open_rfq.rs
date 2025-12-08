use crate::state::rfq::{Rfq, RfqState};
use crate::{state::Config, state::SlashedBondsTracker, RfqError};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct OpenRfq<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        mut,
        seeds = [Rfq::SEED_PREFIX, maker.key().as_ref(), rfq.uuid.as_ref()],
        bump = rfq.bump,
        has_one = maker,
        has_one = config,
        constraint = matches!(rfq.state, RfqState::Draft) @ RfqError::InvalidRfqState,)]
    pub rfq: Box<Account<'info, Rfq>>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    // Must be an account field (not just a Pubkey) for `associated_token::mint`
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = rfq,
    )]
    pub bonds_fees_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = maker,
        constraint = rfq.maker_payment_account == maker_payment_account.key() @ RfqError::UnauthorizedMakerPaymentAccount,
    )]
    pub maker_payment_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = maker,
        space = 8 + SlashedBondsTracker::INIT_SPACE,
        seeds = [SlashedBondsTracker::SEED_PREFIX, rfq.key().as_ref()],
        bump,
    )]
    pub slashed_bonds_tracker: Account<'info, SlashedBondsTracker>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn open_rfq_handler(ctx: Context<OpenRfq>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;
    let slashed_bonds_tracker = &mut ctx.accounts.slashed_bonds_tracker;

    // last-moment sanity (already enforced on init/update, but double-check)
    require!(rfq.bond_amount > 0, RfqError::InvalidParams);
    require!(rfq.base_amount > 0, RfqError::InvalidParams);
    require!(rfq.min_quote_amount > 0, RfqError::InvalidParams);
    require!(rfq.fee_amount > 0, RfqError::InvalidParams);
    require!(rfq.commit_ttl_secs > 0, RfqError::InvalidParams);
    require!(rfq.reveal_ttl_secs > 0, RfqError::InvalidParams);
    require!(rfq.selection_ttl_secs > 0, RfqError::InvalidParams);
    require!(rfq.fund_ttl_secs > 0, RfqError::InvalidParams);

    // Transfer maker bond USDC into RFQ's vault
    let cpi_accounts = Transfer {
        from: ctx.accounts.maker_payment_account.to_account_info(),
        to: ctx.accounts.bonds_fees_vault.to_account_info(),
        authority: ctx.accounts.maker.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    token::transfer(cpi_ctx, rfq.bond_amount)?;

    //update RFQ
    rfq.opened_at = Some(now);
    rfq.state = RfqState::Open;
    //init slashed bonds tracker
    slashed_bonds_tracker.rfq = rfq.key();
    slashed_bonds_tracker.usdc_mint = ctx.accounts.config.usdc_mint;
    slashed_bonds_tracker.treasury_usdc_owner = ctx.accounts.config.treasury_usdc_owner;
    slashed_bonds_tracker.amount = None;
    slashed_bonds_tracker.seized_at = None;
    slashed_bonds_tracker.bump = ctx.bumps.slashed_bonds_tracker;

    Ok(())
}
