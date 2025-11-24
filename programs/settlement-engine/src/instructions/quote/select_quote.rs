use crate::state::rfq::{Rfq, RfqState};
use crate::{state::config::Config, RfqError};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SelectQuote<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(mut, has_one = maker, has_one = config)]
    pub rfq: Account<'info, Rfq>,
    pub config: Account<'info, Config>,
}

pub fn select_quote_handler(ctx: Context<SelectQuote>, quote_key: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;
    require!(rfq.state == RfqState::Revealed, RfqError::InvalidState);
    let selection_deadline = rfq.selection_deadline().ok_or(RfqError::InvalidState)?;
    require!(now <= selection_deadline, RfqError::TooLate);
    require!(rfq.selected_quote.is_none(), RfqError::AlreadySelected);

    rfq.selected_quote = Some(quote_key);
    rfq.state = RfqState::Selected;
    rfq.selected_at = Some(now);
    Ok(())
}
