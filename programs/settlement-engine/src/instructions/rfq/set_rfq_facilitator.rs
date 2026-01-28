use crate::state::rfq::{FacilitatorUpdate, Rfq, RfqState};
use crate::RfqError;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetRfqFacilitator<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        mut,
        seeds = [Rfq::SEED_PREFIX, maker.key().as_ref(), rfq.uuid.as_ref()],
        bump = rfq.bump,
        has_one = maker,
        constraint = matches!(
            rfq.state,
            RfqState::Draft
                | RfqState::Open
                | RfqState::Committed
                | RfqState::Revealed
                | RfqState::Selected
        ) @ RfqError::InvalidRfqState,
    )]
    pub rfq: Account<'info, Rfq>,
}

pub fn set_rfq_facilitator_handler(
    ctx: Context<SetRfqFacilitator>,
    update: FacilitatorUpdate,
) -> Result<()> {
    let rfq = &mut ctx.accounts.rfq;
    match update {
        FacilitatorUpdate::Clear => rfq.facilitator = None,
        FacilitatorUpdate::Set(key) => rfq.facilitator = Some(key),
    }
    Ok(())
}
