use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Rfq {
    // identity & linkage
    pub config: Pubkey,
    pub maker: Pubkey,
    pub uuid: [u8; 16],
    pub state: RfqState,

    // assets
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub usdc_mint: Pubkey,           // snapshot of config.usdc_mint at init
    pub treasury_usdc_owner: Pubkey, // snapshot of config.treasury_usdc_owner at init
    pub liquidity_guard: Pubkey,     // snapshot of config.liquidity_guard at init

    // economics (u64 in smallest units)
    pub bond_amount: u64,         // maker bond in USDC
    pub base_amount: u64,         // exact base tokens maker will deliver
    pub min_quote_amount: u64,    // minimum quote taker must deliver
    pub fee_amount: u64,          // fixed fee taker pays (USDC)
    pub facilitator_fee_bps: u16, // snapshot of config.facilitator_fee_bps at init

    // TTLs (seconds) – ALL relative to opened_at (not created_at)
    pub commit_ttl_secs: u32,
    pub reveal_ttl_secs: u32,
    pub selection_ttl_secs: u32,
    pub fund_ttl_secs: u32,

    // timeline
    pub created_at: i64,           // set at init (draft)
    pub opened_at: Option<i64>,    // set when moving to Open
    pub selected_at: Option<i64>,  // set on selection
    pub completed_at: Option<i64>, // set on settlement completion

    // activity counters
    pub committed_count: u16,
    pub revealed_count: u16,

    // selection & funding flags
    pub selected_quote: Option<Pubkey>,
    pub settlement: Option<Pubkey>,

    // escrow & maker references
    pub bonds_fees_vault: Pubkey, // ATA(owner = rfq PDA, mint = rfq.usdc_mint)
    pub maker_payment_account: Pubkey,

    //facilitator
    pub facilitator: Option<Pubkey>,

    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum RfqState {
    Draft,      // initial state, when RFQ is being created
    Open,       // RFQ is open for takers to commit
    Committed,  // at least one taker has committed
    Revealed,   // at least one taker has revealed
    Selected,   // maker has selected a taker and initiated settlement
    Settled,    // settlement has been completed by taker
    Ignored,    // maker did not select a valid quote in time
    Expired,    // RFQ expired without any valid commitments (no commits at all or no valid reveals)
    Incomplete, // taker did not fund in time after being selected
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum FacilitatorUpdate {
    Clear,
    Set(Pubkey),
}

impl Rfq {
    pub const SEED_PREFIX: &'static [u8] = b"rfq";

    pub fn is_draft(&self) -> bool {
        matches!(self.state, RfqState::Draft)
    }

    pub fn has_selection(&self) -> bool {
        self.selected_at.is_some()
    }

    pub fn opened(&self) -> Option<i64> {
        self.opened_at
    }

    /// Commit deadline = opened_at + commit_ttl
    pub fn commit_deadline(&self) -> Option<i64> {
        self.opened_at.map(|t| t + self.commit_ttl_secs as i64)
    }

    /// Reveal deadline = opened_at + commit_ttl + reveal_ttl
    pub fn reveal_deadline(&self) -> Option<i64> {
        self.opened_at
            .map(|t| t + (self.commit_ttl_secs + self.reveal_ttl_secs) as i64)
    }

    /// Selection deadline = opened_at + commit + reveal + selection
    pub fn selection_deadline(&self) -> Option<i64> {
        self.opened_at.map(|t| {
            t + (self.commit_ttl_secs + self.reveal_ttl_secs + self.selection_ttl_secs) as i64
        })
    }

    /// Funding deadline policy (selection-driven):
    /// - If selected: deadline = selected_at + fund_ttl (taker gets full fund_ttl after selection)
    /// - If opened but not yet selected: deadline = opened_at + (commit + reveal + selection + fund_ttl)
    /// - If not opened yet: return a preview horizon from created_at
    pub fn funding_deadline(&self) -> Option<i64> {
        match (self.opened_at, self.selected_at) {
            (Some(_o), Some(s)) => Some(s + self.fund_ttl_secs as i64),
            (Some(o), None) => Some(
                o + (self.commit_ttl_secs
                    + self.reveal_ttl_secs
                    + self.selection_ttl_secs
                    + self.fund_ttl_secs) as i64,
            ),
            (None, _) => Some(
                self.created_at
                    + (self.commit_ttl_secs
                        + self.reveal_ttl_secs
                        + self.selection_ttl_secs
                        + self.fund_ttl_secs) as i64,
            ),
        }
    }
}
