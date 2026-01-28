use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct FacilitatorRewardTracker {
    pub rfq: Pubkey,
    pub facilitator: Pubkey,
    pub usdc_mint: Pubkey,
    pub amount: u64,
    pub claimed_at: i64,
    pub bump: u8,
}

impl FacilitatorRewardTracker {
    pub const SEED_PREFIX: &'static [u8] = b"facilitator_reward";
}
