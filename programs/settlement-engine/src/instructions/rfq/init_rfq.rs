use anchor_lang::prelude::*;
use crate::state::{config::Config, rfq::{Rfq, RfqState}};

#[derive(Accounts)]
pub struct InitRfq<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = maker,
        space = 8 + Rfq::INIT_SPACE,
        seeds = [Rfq::SEED_PREFIX, maker.key().as_ref()],
        bump,
    )]
    pub rfq: Account<'info, Rfq>,

    /// CHECK: placeholder; SPL escrow wired later
    pub bonds_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitRfq>,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    bond_amount: u64,
    commit_ttl_secs: u32,
    reveal_ttl_secs: u32,
    selection_ttl_secs: u32,
    fund_ttl_secs: u32,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bump = ctx.bumps.rfq;

    let rfq = &mut ctx.accounts.rfq;
    rfq.config = ctx.accounts.config.key();
    rfq.maker = ctx.accounts.maker.key();
    rfq.state = RfqState::Draft;
    rfq.base_mint = base_mint;
    rfq.quote_mint = quote_mint;
    rfq.bond_amount = bond_amount;
    rfq.commit_ttl_secs = commit_ttl_secs;
    rfq.reveal_ttl_secs = reveal_ttl_secs;
    rfq.selection_ttl_secs = selection_ttl_secs;
    rfq.fund_ttl_secs = fund_ttl_secs;
    rfq.created_at = now;
    rfq.expires_at = now + (commit_ttl_secs + reveal_ttl_secs + selection_ttl_secs + fund_ttl_secs) as i64;
    rfq.selected_at = None;
    rfq.bump = bump;
    rfq.committed_count = 0;
    rfq.revealed_count = 0;
    rfq.selected_quote = None;
    rfq.maker_funded = false;
    rfq.taker_funded = false;
    rfq.bonds_vault = ctx.accounts.bonds_vault.key();

    Ok(())
}