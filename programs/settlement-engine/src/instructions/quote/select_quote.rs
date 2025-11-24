use crate::state::rfq::{Rfq, RfqState};
use crate::state::Quote;
use crate::state::Settlement;
use crate::{state::config::Config, RfqError, QuoteError};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SelectQuote<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    pub config: Account<'info, Config>,

    #[account(
        mut, 
        has_one = maker, 
        has_one = config,
        constraint = matches!(rfq.state, RfqState::Revealed) @ RfqError::InvalidState,)]
    pub rfq: Account<'info, Rfq>,

    #[account(
        mut,
        has_one = rfq,
        constraint = quote.is_revealed() @ QuoteError::InvalidState,)]
    pub quote: Account<'info, Quote>,

    #[account(
        init,
        payer = maker,
        space = 8 + Settlement::INIT_SPACE,
        seeds = [Settlement::SEED_PREFIX, rfq.key().as_ref()],
        bump,
    )]
    pub settlement: Account<'info, Settlement>,

    pub system_program: Program<'info, System>,
}

pub fn select_quote_handler(ctx: Context<SelectQuote>, quote_key: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;
    let selection_deadline = rfq.selection_deadline().ok_or(RfqError::InvalidState)?;
    require!(now <= selection_deadline, RfqError::TooLate);
    require!(rfq.selected_quote.is_none(), RfqError::AlreadySelected);

    rfq.selected_quote = Some(quote_key);
    rfq.state = RfqState::Selected;
    rfq.selected_at = Some(now);
    Ok(())
}
