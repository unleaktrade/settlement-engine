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
    require!(rfq.state == RfqState::Revealed, RfqError::InvalidState);
    require!(now > rfq.selection_deadline(), RfqError::TooEarly);
    require!(rfq.revealed_count > 0, RfqError::NothingToClose);

    rfq.state = RfqState::Ignored;
    Ok(())
}
