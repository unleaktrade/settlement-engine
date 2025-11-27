use crate::state::rfq::{Rfq, RfqState};
use crate::{state::config::Config, RfqError};
use anchor_lang::prelude::*;
use anchor_spl::
    token::{self, Transfer, Mint, Token, TokenAccount}
;

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
        constraint = matches!(rfq.state, RfqState::Draft) @ RfqError::InvalidState,)]
    pub rfq: Account<'info, Rfq>,

    pub config: Account<'info, Config>,

    // Must be an account field (not just a Pubkey) for `associated_token::mint`
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    /// Create RFQ-owned USDC ATA
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = rfq,
    )]
    pub bonds_fees_vault: Account<'info, TokenAccount>,

    /// Create Maker-owned USDC ATA (for bonds)
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = maker,
    )]
    pub maker_payment_ata: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn open_rfq_handler(ctx: Context<OpenRfq>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;

    // last-moment sanity (already enforced on init/update, but double-check)
    require!(rfq.bond_amount > 0, RfqError::InvalidParams);
    require!(rfq.base_amount > 0, RfqError::InvalidParams);
    require!(rfq.min_quote_amount > 0, RfqError::InvalidParams);
    require!(rfq.fee_amount > 0, RfqError::InvalidParams);
    require!(rfq.commit_ttl_secs > 0, RfqError::InvalidParams);
    require!(rfq.reveal_ttl_secs > 0, RfqError::InvalidParams);
    require!(rfq.selection_ttl_secs > 0, RfqError::InvalidParams);
    require!(rfq.fund_ttl_secs > 0, RfqError::InvalidParams);

    let cpi_accounts = Transfer {
        from: ctx.accounts.maker_payment_ata.to_account_info(),
        to: ctx.accounts.bonds_fees_vault.to_account_info(),
        authority: ctx.accounts.maker.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    token::transfer(cpi_ctx, rfq.bond_amount)?;

    rfq.opened_at = Some(now);
    rfq.state = RfqState::Open;

    //TODO: deposit bond into bonds_vault ATA
    Ok(())
}
