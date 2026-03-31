use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct FacilitatorRewardTracker {
    pub rfq: Pubkey,
    pub facilitator: Pubkey,
    pub quote_mint: Pubkey,
    pub amount: u64, // in quote_mint tokens
    pub claimed_at: i64,
    pub bump: u8,
}

impl FacilitatorRewardTracker {
    pub const SEED_PREFIX: &'static [u8] = b"facilitator_reward";
}
