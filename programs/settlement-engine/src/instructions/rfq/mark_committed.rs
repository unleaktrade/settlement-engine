use anchor_lang::prelude::*;
use crate::state::rfq::{Rfq, RfqState};
use crate::RfqError;

#[derive(Accounts)]
pub struct MarkCommitted<'info> {
    #[account(mut)]
    pub rfq: Account<'info, Rfq>,
}

pub fn handler(ctx: Context<MarkCommitted>) -> Result<()> {
    let rfq = &mut ctx.accounts.rfq;
    require!(matches!(rfq.state, RfqState::Open | RfqState::Committed), RfqError::InvalidState);
    rfq.committed_count = rfq.committed_count.saturating_add(1);
    if rfq.state == RfqState::Open { rfq.state = RfqState::Committed; }
    Ok(())
}