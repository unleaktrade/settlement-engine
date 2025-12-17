use crate::{
    state::{
        config::Config,
        quote::Quote,
        rfq::{Rfq, RfqState},
    },
    RfqError,
};
use anchor_lang::prelude::*;
use solana_program::hash::hash;
#[derive(Accounts)]
pub struct RevealQuote<'info> {
    /// Taker revealing their previously committed quote
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [Rfq::SEED_PREFIX, rfq.maker.key().as_ref(), rfq.uuid.as_ref()],
        bump = rfq.bump,
        has_one = config,
        constraint = matches!(rfq.state, RfqState::Committed | RfqState::Revealed) @ RfqError::InvalidRfqState,
    )]
    pub rfq: Box<Account<'info, Rfq>>,

    #[account(
        mut,
        seeds = [Quote::SEED_PREFIX, rfq.key().as_ref(), taker.key().as_ref()],
        bump = quote.bump,
        has_one = rfq,
        has_one = taker,
        constraint = !quote.is_revealed() @ RfqError::QuoteAlreadyRevealed,
    )]
    pub quote: Account<'info, Quote>,
}

pub fn reveal_quote_handler(
    ctx: Context<RevealQuote>,
    // unique salt from the liquidity-guard response (NOT stored on-chain)
    salt: [u8; 64],
    // revealed quote amount in smallest units of rfq.quote_mint
    quote_amount: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;
    let quote = &mut ctx.accounts.quote;

    match (rfq.reveal_deadline(), rfq.commit_deadline()) {
        (Some(reveal_deadline), Some(commit_deadline)) => {
            require!(now <= reveal_deadline, RfqError::RevealTooLate);
            require!(now > commit_deadline, RfqError::RevealTooEarly);
        }
        _ => return err!(RfqError::InvalidRfqState),
    }

    // Recompute commit_hash EXACTLY the same way liquidity-guard did.
    // This must match the Rust code in:
    //   https://github.com/unleaktrade/liquidity-guard
    let mut buf: Vec<u8> = Vec::with_capacity(
        64 + // salt
        32 + // rfq pubkey
        32 + // taker pubkey
        32 + // quote mint
        8  + // quote amount
        8  + // bond amount
        8, // fee amount
    );
    buf.extend_from_slice(&salt);
    buf.extend_from_slice(rfq.key().as_ref());
    buf.extend_from_slice(ctx.accounts.taker.key().as_ref());
    buf.extend_from_slice(rfq.quote_mint.key().as_ref());
    buf.extend_from_slice(&quote_amount.to_le_bytes());
    buf.extend_from_slice(&rfq.bond_amount.to_le_bytes());
    buf.extend_from_slice(&rfq.fee_amount.to_le_bytes());

    let computed = hash(&buf).to_bytes();
    msg!("Computed commit hash: {:?}", computed);
    msg!("Stored commit hash:   {:?}", quote.commit_hash);
    require!(computed == quote.commit_hash, RfqError::Unauthorized);

    // Enforce price floor
    require!(
        quote_amount >= rfq.min_quote_amount,
        RfqError::InvalidQuoteAmount
    );

    // Mark as valid reveal
    quote.revealed_at = Some(now);
    quote.quote_amount = Some(quote_amount);

    // Update RFQ reveal counters/state
    rfq.revealed_count = rfq
        .revealed_count
        .checked_add(1)
        .ok_or(RfqError::ArithmeticOverflow)?;
    rfq.state = RfqState::Revealed;

    Ok(())
}
