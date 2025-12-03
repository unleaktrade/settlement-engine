use crate::state::rfq::{Rfq, RfqState};
use crate::state::{Config, Settlement};
use crate::RfqError;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

#[derive(Accounts)]
pub struct CompleteSettlement<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(
        mut,
        seeds = [Rfq::SEED_PREFIX, rfq.maker.key().as_ref(), rfq.uuid.as_ref()],
        bump = rfq.bump,
    )]
    pub rfq: Box<Account<'info, Rfq>>,

    #[account(
        mut,
        seeds = [Settlement::SEED_PREFIX, rfq.key().as_ref()],
        bump,
        has_one = rfq,
    )]
    pub settlement: Box<Account<'info, Settlement>>,

    pub config: Account<'info, Config>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    #[account()]
    pub base_mint: Account<'info, Mint>,

    #[account()]
    pub quote_mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = config.treasury_usdc_owner,
    )]
    pub treasury: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn complete_settlement_handler(ctx: Context<CompleteSettlement>) -> Result<()> {
    let _now = Clock::get()?.unix_timestamp;
    let _rfq = &mut ctx.accounts.rfq;
    let _settlement = &mut ctx.accounts.settlement;

    Ok(())
}
