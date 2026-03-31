use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct FeesTracker {
    pub rfq: Pubkey,
    pub taker: Pubkey,
    pub quote_mint: Pubkey,
    pub treasury_usdc_owner: Pubkey,
    pub amount: u64, // in quote_mint tokens
    pub payed_at: i64,
    pub bump: u8,
}

impl FeesTracker {
    pub const SEED_PREFIX: &'static [u8] = b"fees_tracker";
}
