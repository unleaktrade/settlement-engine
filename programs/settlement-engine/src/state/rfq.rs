use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Rfq {
    pub config: Pubkey,             // reference to Config
    pub maker: Pubkey,              // RFQ owner
    pub uuid: [u8; 16],             // RFQ UUID (16 bytes)
    pub state: RfqState,            // current RFQ status
    pub base_mint: Pubkey,          // token offered by maker
    pub quote_mint: Pubkey,         // token expected by maker
    pub bond_amount: u64,           // bond in smallest USDC units
    pub fund_ttl_secs: u32,         // funding TTL
    pub commit_ttl_secs: u32,       // commit phase TTL
    pub reveal_ttl_secs: u32,       // reveal phase TTL
    pub selection_ttl_secs: u32,    // selection phase TTL
    pub created_at: i64,            // unix timestamp
    pub expires_at: i64,            // coarse max horizon (helper for cleaners)
    pub selected_at: Option<i64>,   // set on select
    pub bump: u8,

    // activity counters
    pub committed_count: u16,
    pub revealed_count: u16,

    // selection & funding flags
    pub selected_quote: Option<Pubkey>,
    pub maker_funded: bool,
    pub taker_funded: bool,

    // escrow references (to be wired later)
    pub bonds_vault: Pubkey,        // PDA of USDC escrow for maker bond
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum RfqState {
    Draft,
    Open,
    Committed,
    Revealed,
    Selected,
    Funded,
    Settled,
    Ignored,
    Expired,
    Aborted,
}

impl Rfq {
    pub const SEED_PREFIX: &'static [u8] = b"rfq";

    pub fn can_cancel(&self) -> bool {
        matches!(self.state, RfqState::Draft)
    }

    pub fn selection_deadline(&self) -> i64 {
        self.created_at
            + (self.commit_ttl_secs + self.reveal_ttl_secs + self.selection_ttl_secs) as i64
    }

    pub fn funding_deadline(&self) -> Option<i64> {
        self.selected_at.map(|t| t + self.fund_ttl_secs as i64)
    }
}