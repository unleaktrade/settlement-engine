use crate::state::rfq::{Rfq, RfqState};
use crate::RfqError;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CancelRfq<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        mut,
        close = maker,
        seeds = [Rfq::SEED_PREFIX, maker.key().as_ref(), rfq.uuid.as_ref()],
        bump = rfq.bump,
        has_one = maker,
        constraint = matches!(rfq.state, RfqState::Draft) @ RfqError::InvalidRfqState,)]
    pub rfq: Account<'info, Rfq>,
}

pub fn cancel_rfq_handler(ctx: Context<CancelRfq>) -> Result<()> {
    #[cfg(feature = "debug-logs")]
    msg!(
        "RFQ {} cancelled by maker {}",
        ctx.accounts.rfq.key().to_string(),
        ctx.accounts.maker.key()
    );

    // Account will be closed automatically, transferring lamports to maker
    Ok(())
}
