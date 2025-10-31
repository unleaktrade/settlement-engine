use anchor_lang::prelude::*;
use crate::state::rfq::{Rfq, RfqState};
use crate::RfqError;

#[derive(Accounts)]
pub struct MarkRevealed<'info> {
    #[account(mut)]
    pub rfq: Account<'info, Rfq>,
}

pub fn handler(ctx: Context<MarkRevealed>) -> Result<()> {
    let rfq = &mut ctx.accounts.rfq;
    require!(matches!(rfq.state, RfqState::Committed | RfqState::Revealed), RfqError::InvalidState);
    rfq.revealed_count = rfq.revealed_count.saturating_add(1);
    if rfq.state == RfqState::Committed { rfq.state = RfqState::Revealed; }
    Ok(())
}