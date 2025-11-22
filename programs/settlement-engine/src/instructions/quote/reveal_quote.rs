use crate::{
    quote_errors::QuoteError,
    state::{
        config::Config,
        quote::Quote,
        rfq::{Rfq, RfqState},
    },
    RfqError,
};
use anchor_lang::prelude::*;
#[derive(Accounts)]
pub struct RevealQuote<'info> {
    /// Taker revealing their previously committed quote
    #[account(mut)]
    pub taker: Signer<'info>,

    pub config: Account<'info, Config>,

    #[account(
        mut,
        has_one = config,
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

pub fn handler(
    ctx: Context<RevealQuote>,
    // unique salt from the liquidity-guard response (NOT stored on-chain)
    salt: [u8; 64],
    // revealed quote amount in smallest units of rfq.quote_mint
    quote_amount: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;
    let quote = &mut ctx.accounts.quote;

    // RFQ must be in reveal-capable state
    require!(
        matches!(rfq.state, RfqState::Committed | RfqState::Revealed),
        RfqError::InvalidState
    );

    match (rfq.reveal_deadline(), rfq.commit_deadline()) {
        (Some(reveal_deadline), Some(commit_deadline)) => {
            require!(now <= reveal_deadline, QuoteError::RevealTooLate);
            require!(now >= commit_deadline, QuoteError::RevealTooEarly);
        }
        _ => return err!(RfqError::InvalidState),
    }

    // Enforce price floor
    require!(
        quote_amount >= rfq.min_quote_amount,
        QuoteError::InvalidQuoteAmount
    );

    // Can only reveal once
    // require!(!quote.revealed_valid, RfqError::InvalidState);

    // Recompute commit_hash EXACTLY the same way liquidity-guard did.
    // This must match the Rust code in:
    //   https://github.com/unleaktrade/liquidity-guard
    // let expected_hash = compute_commit_hash(
    //     &salt,
    //     &rfq,
    //     &ctx.accounts.taker.key(),
    //     quote_amount,
    //     rfq.bond_amount,
    //     fee_amount_usdc,
    //     &rfq.base_mint,
    //     &rfq.quote_mint,
    //     &ctx.accounts.config.usdc_mint,
    // );

    // require!(expected_hash == quote.commit_hash, RfqError::Unauthorized);

    // Mark as valid reveal
    // quote.revealed_valid = true;
    // quote.revealed_at = Some(now);
    // quote.quote_amount = quote_amount;

    // Update RFQ reveal counters/state
    rfq.revealed_count = rfq.revealed_count.saturating_add(1);
    rfq.state = RfqState::Revealed;

    Ok(())
}
