use crate::state::rfq::{Rfq, RfqState};
use crate::RfqError;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CancelRfq<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(mut, close = maker, has_one = maker)]
    pub rfq: Account<'info, Rfq>,
}

pub fn cancel_rfq_handler(ctx: Context<CancelRfq>) -> Result<()> {
    let rfq = &ctx.accounts.rfq;
    require!(rfq.state == RfqState::Draft, RfqError::InvalidState);
    Ok(())
}
