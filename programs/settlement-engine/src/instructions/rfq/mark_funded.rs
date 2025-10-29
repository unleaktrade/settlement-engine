use anchor_lang::prelude::*;
use crate::state::rfq::{Rfq, RfqState};
use crate::RfqError;

#[derive(Accounts)]
pub struct MarkFunded<'info> {
    #[account(mut)]
    pub rfq: Account<'info, Rfq>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum FundSide { Maker, Taker }

pub fn handler(ctx: Context<MarkFunded>, side: FundSide) -> Result<()> {
    let rfq = &mut ctx.accounts.rfq;
    require!(matches!(rfq.state, RfqState::Selected | RfqState::Funded), RfqError::InvalidState);

    match side {
        FundSide::Maker => rfq.maker_funded = true,
        FundSide::Taker => rfq.taker_funded = true,
    }

    if rfq.maker_funded && rfq.taker_funded { rfq.state = RfqState::Funded; }
    Ok(())
}