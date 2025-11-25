use crate::state::rfq::{Rfq, RfqState};
use crate::{state::config::Config, RfqError};
use anchor_lang::prelude::*;

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

    rfq.opened_at = Some(now);
    rfq.state = RfqState::Open;

    //TODO: deposit bond into bonds_vault ATA
    Ok(())
}
