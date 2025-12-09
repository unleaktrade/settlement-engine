use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct SlashedBondsTracker {
    pub rfq: Pubkey,
    pub usdc_mint: Pubkey,
    pub treasury_usdc_owner: Pubkey,
    pub amount: Option<u64>,
    pub seized_at: Option<i64>,
    pub bump: u8,
}

impl SlashedBondsTracker {
    pub const SEED_PREFIX: &'static [u8] = b"slashed_bonds_tracker";
    
    pub fn is_resolved(&self) -> bool {
        self.amount.is_some() && self.seized_at.is_some()
    }
}
