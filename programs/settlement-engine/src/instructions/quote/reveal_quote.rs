use anchor_lang::prelude::*;
use crate::{
    state::{
        config::Config,
        rfq::{Rfq, RfqState},
        quote::Quote,
    },
    RfqError,
};

// sha2 can be changed if liquidity-guard uses something else;
// we just mirror whatever that crate does.
use sha2::{Digest, Sha256};

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
    // unique salt from the liquidity-guard preflight response (NOT stored on-chain)
    salt: [u8; 16],
    // revealed quote amount in smallest units of rfq.quote_mint
    quote_amount: u64,
    // if fee is also part of the hash, pass it too
    fee_amount_usdc: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;
    let quote = &mut ctx.accounts.quote;

    // RFQ must be in reveal-capable state
    require!(
        matches!(rfq.state, RfqState::Committed | RfqState::Revealed),
        RfqError::InvalidState
    );

    let Some(reveal_deadline) = rfq.reveal_deadline() else {
        return err!(RfqError::InvalidState);
    };
    require!(now <= reveal_deadline, RfqError::TooLate);

    // Can only reveal once
    require!(!quote.revealed_valid, RfqError::InvalidState);

    // Recompute commit_hash EXACTLY the same way liquidity-guard did.
    // This must match the Rust code in:
    //   https://github.com/unleaktrade/liquidity-guard
    let expected_hash = compute_commit_hash(
        &salt,
        &rfq,
        &ctx.accounts.taker.key(),
        quote_amount,
        rfq.bond_amount,
        fee_amount_usdc,
        &rfq.base_mint,
        &rfq.quote_mint,
        &ctx.accounts.config.usdc_mint,
    );

    require!(expected_hash == quote.commit_hash, RfqError::Unauthorized);

    // Enforce price floor
    require!(quote_amount >= rfq.min_quote_amount, RfqError::InvalidState);

    // Mark as valid reveal
    quote.revealed_valid = true;
    quote.revealed_at = Some(now);
    quote.quote_amount = quote_amount;

    // Update RFQ reveal counters/state
    rfq.revealed_count = rfq.revealed_count.saturating_add(1);
    if rfq.state == RfqState::Committed {
        rfq.state = RfqState::Revealed;
    }

    Ok(())
}

/// This MUST mirror `liquidity-guard` hashing exactly.
/// Adjust the fields/order once you finalize the spec there.
fn compute_commit_hash(
    salt: &[u8; 16],
    rfq: &Rfq,
    taker: &Pubkey,
    quote_amount: u64,
    bond_amount_usdc: u64,
    fee_amount_usdc: u64,
    base_mint: &Pubkey,
    quote_mint: &Pubkey,
    usdc_mint: &Pubkey,
) -> [u8; 32] {
    let mut hasher = Sha256::new();

    // Example layout (you'll sync this with liquidity-guard)
    hasher.update(salt);
    hasher.update(rfq.key().as_ref());
    hasher.update(taker.as_ref());
    hasher.update(base_mint.as_ref());
    hasher.update(quote_mint.as_ref());
    hasher.update(usdc_mint.as_ref());
    hasher.update(bond_amount_usdc.to_le_bytes());
    hasher.update(fee_amount_usdc.to_le_bytes());
    hasher.update(quote_amount.to_le_bytes());

    let out = hasher.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out);
    arr
}
