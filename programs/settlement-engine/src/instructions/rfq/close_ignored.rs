// programs/settlement-engine/src/instructions/rfq/close_ignored.rs
use crate::state::rfq::{Rfq, RfqState};
use crate::RfqError;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CloseIgnored<'info> {
    #[account(mut)]
    pub rfq: Account<'info, Rfq>,
}

pub fn handler(ctx: Context<CloseIgnored>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;

    // IGNORED requires at least one valid reveal and no selection by deadline
    require!(rfq.state == RfqState::Revealed, RfqError::InvalidState);
    require!(rfq.revealed_count > 0, RfqError::InvalidState);

    let selection_deadline = rfq.selection_deadline().ok_or(RfqError::InvalidState)?;
    require!(now > selection_deadline, RfqError::TooEarly);

    // TODO: slash maker bond per policy; distribute to treasury/virtuous takers
    rfq.state = RfqState::Ignored;
    Ok(())
}
