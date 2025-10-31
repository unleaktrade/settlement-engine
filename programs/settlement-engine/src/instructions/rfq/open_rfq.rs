use crate::state::rfq::{Rfq, RfqState};
use crate::{state::config::Config, RfqError};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct OpenRfq<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(mut, has_one = maker, has_one = config)]
    pub rfq: Account<'info, Rfq>,

    pub config: Account<'info, Config>,
}

pub fn handler(ctx: Context<OpenRfq>) -> Result<()> {
    let rfq = &mut ctx.accounts.rfq;
    require!(rfq.state == RfqState::Draft, RfqError::InvalidState);
    rfq.state = RfqState::Open;
    Ok(())
}
