use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct FeesTracker {
    pub rfq: Pubkey,
    pub taker: Pubkey,
    pub usdc_mint: Pubkey,
    pub treasury_usdc_owner: Pubkey,
    pub amount: i64,
    pub payed_at: i64,
    pub bump: u8,
}

impl FeesTracker {
    pub const SEED_PREFIX: &'static [u8] = b"fees_tracker";
}
