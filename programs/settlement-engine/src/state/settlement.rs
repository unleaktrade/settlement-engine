use anchor_lang::prelude::*;
use crate::rfq_errors::RfqError;

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
    pub taker_fee_bps: u16,

    /// Token Accounts
    // USDC
    pub maker_payment_account: Pubkey,
    pub taker_payment_account: Pubkey,
    pub bonds_escrow: Pubkey,
    // base mint
    pub maker_base_account: Pubkey,
    pub taker_base_account: Option<Pubkey>,
    pub vault_base_ata: Pubkey,
    // quote mint
    pub maker_quote_account: Pubkey,
    pub taker_quote_account: Option<Pubkey>,
    // pub vault_quote_ata: Pubkey, // Facultative vault assuming the quote transfer occurs directly between the taker and the maker.

    // timeline
    pub created_at: i64,
    pub completed_at: Option<i64>,

    // funding timestamps
    pub maker_funded_at: Option<i64>,
    pub taker_funded_at: Option<i64>,

    pub bump: u8,
}

impl Settlement {
    pub const SEED_PREFIX: &'static [u8] = b"settlement";

    pub fn is_complete(&self) -> bool {
        self.completed_at.is_some()
    }

    pub fn maker_funded(&self) -> bool {
        self.maker_funded_at.is_some()
    }

    pub fn taker_funded(&self) -> bool {
        self.taker_funded_at.is_some()
    }

    /// Floor division, but guarantee at least 1 when taker_fee_bps > 0.
    pub fn compute_total_fee(&self) -> Result<u64> {
        if self.taker_fee_bps > 0 {
            let fee = (self.quote_amount as u128)
                .checked_mul(self.taker_fee_bps as u128)
                .and_then(|v| v.checked_div(10_000))
                .and_then(|v| u64::try_from(v).ok())
                .ok_or_else(|| error!(RfqError::ArithmeticOverflow))?;
            Ok(if fee == 0 { 1 } else { fee })
        } else {
            Ok(0)
        }
    }

    /// Facilitator share = floor(total_fee * facilitator_fee_bps / 10_000).
    pub fn compute_facilitator_share(&self, total_fee: u64, facilitator_fee_bps: u16) -> Result<u64> {
        (total_fee as u128)
            .checked_mul(facilitator_fee_bps as u128)
            .and_then(|v| v.checked_div(10_000))
            .and_then(|v| u64::try_from(v).ok())
            .ok_or_else(|| error!(RfqError::ArithmeticOverflow))
    }
}
