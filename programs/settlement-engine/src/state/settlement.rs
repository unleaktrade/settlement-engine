use anchor_lang::prelude::*;

/// Captures the immutable settlement snapshot once a quote is selected.
#[account]
#[derive(InitSpace)]
pub struct Settlement {
    pub rfq: Pubkey,
    pub quote: Pubkey,

    // participants
    pub maker: Pubkey,
    pub taker: Pubkey,

    // assets and economics
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_amount: u64,
    pub quote_amount: u64,
    pub bond_amount: u64,
    pub fee_amount: u64,

    // timeline
    pub created_at: i64,
    pub settled_at: Option<i64>,

    // funding flags
    pub maker_funded: bool,
    pub taker_funded: bool,

    pub bump: u8,
}

impl Settlement {
    pub const SEED_PREFIX: &'static [u8] = b"settlement";
}
