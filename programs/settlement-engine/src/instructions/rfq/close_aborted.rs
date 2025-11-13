use crate::state::rfq::{Rfq, RfqState};
use crate::RfqError;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CloseAborted<'info> {
    #[account(mut)]
    pub rfq: Account<'info, Rfq>,
}

pub fn handler(ctx: Context<CloseAborted>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;
    require!(
        matches!(rfq.state, RfqState::Selected | RfqState::Funded),
        RfqError::InvalidState
    );

    let deadline = rfq.funding_deadline().ok_or(RfqError::InvalidState)?;
    require!(now > deadline, RfqError::TooEarly);

    rfq.state = RfqState::Aborted;
    Ok(())
}
