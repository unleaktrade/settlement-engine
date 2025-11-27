use crate::state::rfq::{Rfq, RfqState};
use crate::state::Quote;
use crate::state::Settlement;
use crate::{state::config::Config, QuoteError, RfqError};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token},
};

#[derive(Accounts)]
pub struct SelectQuote<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    pub config: Account<'info, Config>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [Rfq::SEED_PREFIX, maker.key().as_ref(), rfq.uuid.as_ref()],
        bump = rfq.bump,
        has_one = maker,
        has_one = config,
        constraint = matches!(rfq.state, RfqState::Revealed) @ RfqError::InvalidState,
        constraint = !rfq.has_selection() @ RfqError::AlreadySelected,
    )]
    pub rfq: Account<'info, Rfq>,

    #[account(
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

    // pub maker_base_ata: Account<'info, TokenAccount>,
    // pub taker_base_ata: Account<'info, TokenAccount>,
    // pub maker_quote_ata: Account<'info, TokenAccount>,
    // pub taker_quote_ata: Account<'info, TokenAccount>,
    // pub vault_base_ata: Account<'info, TokenAccount>,
    // pub vault_quote_ata: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,

    pub token_program: Program<'info, Token>, // for token account initialization
    pub associated_token_program: Program<'info, AssociatedToken>, // for ATA initialization
}

pub fn select_quote_handler(ctx: Context<SelectQuote>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;
    let quote = &mut ctx.accounts.quote;
    let settlement = &mut ctx.accounts.settlement;
    let maker = &ctx.accounts.maker;

    match (rfq.reveal_deadline(), rfq.selection_deadline()) {
        (Some(reveal_deadline), Some(selection_deadline)) => {
            require!(now > reveal_deadline, RfqError::SelectionTooEarly);
            require!(now <= selection_deadline, RfqError::SelectionTooLate);
        }
        _ => return err!(RfqError::InvalidState),
    }

    // update rfq
    rfq.state = RfqState::Selected;
    rfq.selected_at = Some(now);
    rfq.selected_quote = Some(quote.key());
    rfq.settlement = Some(settlement.key());

    // fill settlement
    settlement.rfq = rfq.key();
    settlement.quote = quote.key();
    settlement.maker = maker.key();
    settlement.taker = quote.taker;
    settlement.base_mint = rfq.base_mint;
    settlement.quote_mint = rfq.quote_mint;
    settlement.base_amount = rfq.base_amount;
    settlement.quote_amount = quote.quote_amount.ok_or_else(|| QuoteError::InvalidState)?;
    settlement.bond_amount = rfq.bond_amount;
    settlement.fee_amount = rfq.fee_amount;
    settlement.created_at = now;
    settlement.settled_at = None;
    settlement.maker_funded_at = None;
    settlement.taker_funded_at = None;
    settlement.bump = ctx.bumps.settlement;

    Ok(())
}
