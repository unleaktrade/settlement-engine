use crate::state::rfq::{Rfq, RfqState};
use crate::RfqError;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RefundQuoteBonds<'info> {
    #[account(mut)]
    pub rfq: Account<'info, Rfq>,
}

pub fn refund_quote_bonds_handler(ctx: Context<RefundQuoteBonds>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;

    require!(rfq.state == RfqState::Revealed, RfqError::InvalidRfqState);
    require!(rfq.revealed_count > 0, RfqError::InvalidRfqState);

    let selection_deadline = rfq.selection_deadline().ok_or(RfqError::InvalidRfqState)?;
    require!(now > selection_deadline, RfqError::TooEarly);

    rfq.state = RfqState::Ignored;
    Ok(())
}
