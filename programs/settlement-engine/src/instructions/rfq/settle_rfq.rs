use crate::state::rfq::{Rfq, RfqState};
use crate::RfqError;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SettleRfq<'info> {
    #[account(mut)]
    pub rfq: Account<'info, Rfq>,
}

pub fn handler(ctx: Context<SettleRfq>) -> Result<()> {
    let rfq = &mut ctx.accounts.rfq;
    require!(rfq.state == RfqState::Funded, RfqError::InvalidState);
    require!(rfq.maker_funded && rfq.taker_funded, RfqError::InvalidState);
    // Token movements will be added in the settlement stage.
    rfq.state = RfqState::Settled;
    Ok(())
}
