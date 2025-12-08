use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct SlashedBondsTracker {
    pub rfq: Pubkey,
    pub usdc_mint: Pubkey,
    pub treasury_usdc_owner: Pubkey,
    pub amount: Option<u64>,
    pub payed_at: Option<i64>,
    pub bump: u8,
}

impl SlashedBondsTracker {
    pub const SEED_PREFIX: &'static [u8] = b"slashed_bonds_tracker";
}
