use anchor_lang::prelude::*;
use crate::state::rfq::{Rfq, RfqState};
use crate::RfqError;

#[derive(Accounts)]
pub struct CloseExpired<'info> {
    #[account(mut)]
    pub rfq: Account<'info, Rfq>,
}

pub fn handler(ctx: Context<CloseExpired>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;

    // Only pre-selection/funding states can expire
    require!(
        matches!(rfq.state, RfqState::Open | RfqState::Committed | RfqState::Revealed),
        RfqError::InvalidState
    );

    if rfq.committed_count == 0 {
        // no commits at all -> expire after commit_ttl
        let commit_deadline = rfq.created_at + rfq.commit_ttl_secs as i64;
        require!(now > commit_deadline, RfqError::TooEarly);
    } else {
        // had commits -> expire only after the selection window ends
        let selection_deadline = rfq.selection_deadline();
        require!(now > selection_deadline, RfqError::TooEarly);
    }

    rfq.state = RfqState::Expired;
    Ok(())
}