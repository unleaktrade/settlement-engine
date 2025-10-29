use anchor_lang::prelude::*;
use crate::state::rfq::{Rfq, RfqState};
use crate::RfqError;

#[derive(Accounts)]
pub struct CloseAborted<'info> {
    #[account(mut)]
    pub rfq: Account<'info, Rfq>,
}

pub fn handler(ctx: Context<CloseAborted>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;
    require!(matches!(rfq.state, RfqState::Selected | RfqState::Funded), RfqError::InvalidState);

    let Some(deadline) = rfq.funding_deadline() else { return err!(RfqError::InvalidState); };
    require!(now > deadline, RfqError::TooEarly);

    rfq.state = RfqState::Aborted;
    Ok(())
}