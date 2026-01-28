use crate::{
    state::{
        quote::Quote,
        rfq::{FacilitatorUpdate, Rfq, RfqState},
    },
    RfqError,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetQuoteFacilitator<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(
        mut,
        seeds = [Rfq::SEED_PREFIX, rfq.maker.key().as_ref(), rfq.uuid.as_ref()],
        bump = rfq.bump,
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

    #[account(
        mut,
        seeds = [Quote::SEED_PREFIX, rfq.key().as_ref(), taker.key().as_ref()],
        bump = quote.bump,
        has_one = rfq,
        has_one = taker,
    )]
    pub quote: Account<'info, Quote>,
}

pub fn set_quote_facilitator_handler(
    ctx: Context<SetQuoteFacilitator>,
    update: FacilitatorUpdate,
) -> Result<()> {
    let quote = &mut ctx.accounts.quote;
    match update {
        FacilitatorUpdate::Clear => quote.facilitator = None,
        FacilitatorUpdate::Set(key) => quote.facilitator = Some(key),
    }
    Ok(())
}
