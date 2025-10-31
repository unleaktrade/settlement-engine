use anchor_lang::prelude::*;
use crate::state::rfq::{Rfq, RfqState};
use crate::{RfqError, state::config::Config};

#[derive(Accounts)]
pub struct SelectQuote<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(mut, has_one = maker, has_one = config)]
    pub rfq: Account<'info, Rfq>,
    pub config: Account<'info, Config>,
}

pub fn handler(ctx: Context<SelectQuote>, quote_key: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;
    require!(rfq.state == RfqState::Revealed, RfqError::InvalidState);
    require!(now <= rfq.selection_deadline(), RfqError::TooLate);
    require!(rfq.selected_quote.is_none(), RfqError::AlreadySelected);

    rfq.selected_quote = Some(quote_key);
    rfq.state = RfqState::Selected;
    rfq.selected_at = Some(now);
    Ok(())
}