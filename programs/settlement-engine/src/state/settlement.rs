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

    /// Token Accounts
    // USDC
    pub maker_payment_account: Pubkey,
    pub taker_payment_account: Pubkey,
    pub bonds_fees_vault: Pubkey,
    // base mint
    pub maker_base_account: Pubkey,
    pub taker_base_account: Pubkey,
    pub vault_base_ata: Pubkey,
    // quote mint
    pub maker_quote_account: Pubkey,
    pub taker_quote_account: Pubkey,
    pub vault_quote_ata: Pubkey,

    // timeline
    pub created_at: i64,
    pub settled_at: Option<i64>,

    // funding timestamps
    pub maker_funded_at: Option<i64>,
    pub taker_funded_at: Option<i64>,

    pub bump: u8,
}

impl Settlement {
    pub const SEED_PREFIX: &'static [u8] = b"settlement";

    pub fn is_complete(&self) -> bool {
        self.maker_funded() && self.taker_funded() && self.settled_at.is_some()
    }

    pub fn maker_funded(&self) -> bool {
        self.maker_funded_at.is_some()
    }

    pub fn taker_funded(&self) -> bool {
        self.taker_funded_at.is_some()
    }
}
