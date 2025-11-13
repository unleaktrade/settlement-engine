use crate::state::rfq::{Rfq, RfqState};
use crate::RfqError;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CloseExpired<'info> {
    #[account(mut)]
    pub rfq: Account<'info, Rfq>,
}

pub fn close_expired_handler(ctx: Context<CloseExpired>) -> Result<()> {
    let rfq = &mut ctx.accounts.rfq;

    // Only pre-selection/funding states can expire
    require!(
        matches!(rfq.state, RfqState::Open | RfqState::Committed),
        RfqError::InvalidState
    );

    let now = Clock::get()?.unix_timestamp;
    if rfq.committed_count == 0 {
        // no commits at all -> expire after commit_ttl
        let commit_deadline = rfq.commit_deadline().ok_or(RfqError::InvalidState)?;
        require!(now > commit_deadline, RfqError::TooEarly);
    } else {
        // had commits but no valid reveal -> expire only after the reveal window ends
        require!(rfq.revealed_count == 0, RfqError::InvalidState);
        let reveal_deadline = rfq.reveal_deadline().ok_or(RfqError::InvalidState)?;
        require!(now > reveal_deadline, RfqError::TooEarly);
    }

    //TODO: refund maker bonds + slash non virtuous taker bonds
    rfq.state = RfqState::Expired;
    Ok(())
}
