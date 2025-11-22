use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Quote {
    /// RFQ this quote belongs to
    pub rfq: Pubkey,
    /// Taker who owns this quote
    pub taker: Pubkey,

    // --- COMMIT PHASE ---
    /// 32-byte commit hash and 64-byte liquidity_proof from liquidity-guard
    pub commit_hash: [u8; 32],
    pub liquidity_proof: [u8; 64],
    pub committed_at: i64,
    pub revealed_at: Option<i64>,
    pub is_valid: bool,

    pub bump: u8,
}

impl Quote {
    pub const SEED_PREFIX: &'static [u8] = b"quote";
}

/// Tiny PDA keyed by commit_hash to forbid reuse of the same hash.
#[account]
#[derive(InitSpace)]
pub struct CommitGuard {
    pub committed_at: i64,
    pub bump: u8,
}

impl CommitGuard {
    pub const SEED_PREFIX: &'static [u8] = b"commit-guard";
}
