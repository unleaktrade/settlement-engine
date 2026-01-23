use crate::state::{
    config::Config,
    rfq::{Rfq, RfqState},
};
use crate::RfqError;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

#[derive(Accounts)]
#[instruction(uuid: [u8; 16])]
pub struct InitRfq<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    // Must be an account field (not just a Pubkey) for `associated_token::mint`
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = maker,
        space = 8 + Rfq::INIT_SPACE,
        seeds = [Rfq::SEED_PREFIX, maker.key().as_ref(), uuid.as_ref()],
        bump,
    )]
    pub rfq: Account<'info, Rfq>,

    /// Create RFQ-owned USDC ATA
    #[account(
        init_if_needed,
        payer = maker,
        associated_token::mint = usdc_mint,
        associated_token::authority = rfq,
    )]
    pub bonds_fees_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = maker,
        constraint =!maker_payment_account.is_frozen() @ RfqError::MakerPaymentAccountClosed,
    )]
    pub maker_payment_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn init_rfq_handler(
    ctx: Context<InitRfq>,
    uuid: [u8; 16],
    base_mint: Pubkey,
    quote_mint: Pubkey,
    bond_amount: u64,
    base_amount: u64,
    min_quote_amount: u64,
    taker_fee_usdc: u64,
    commit_ttl_secs: u32,
    reveal_ttl_secs: u32,
    selection_ttl_secs: u32,
    fund_ttl_secs: u32,
    facilitator: Option<Pubkey>,
) -> Result<()> {
    let bump = ctx.bumps.rfq;

    require!(bond_amount > 0, RfqError::InvalidBondAmount);
    require!(taker_fee_usdc > 0, RfqError::InvalidFeeAmount);
    require!(base_amount > 0, RfqError::InvalidBaseAmount);
    require!(min_quote_amount > 0, RfqError::InvalidMinQuoteAmount);

    // Lifetime invariants
    require!(commit_ttl_secs > 0, RfqError::InvalidCommitTTL);
    require!(reveal_ttl_secs > 0, RfqError::InvalidRevealTTL);
    require!(selection_ttl_secs > 0, RfqError::InvalidSelectionTTL);
    require!(fund_ttl_secs > 0, RfqError::InvalidFundingTTL);

    // --- Initialize RFQ -----------------------------------------------------
    let rfq = &mut ctx.accounts.rfq;
    rfq.config = ctx.accounts.config.key();
    rfq.maker = ctx.accounts.maker.key();
    rfq.uuid = uuid;
    rfq.state = RfqState::Draft;

    // assets & economics
    rfq.base_mint = base_mint;
    rfq.quote_mint = quote_mint;
    rfq.bond_amount = bond_amount;
    rfq.base_amount = base_amount;
    rfq.min_quote_amount = min_quote_amount;
    rfq.fee_amount = taker_fee_usdc;

    // ttls
    rfq.commit_ttl_secs = commit_ttl_secs;
    rfq.reveal_ttl_secs = reveal_ttl_secs;
    rfq.selection_ttl_secs = selection_ttl_secs;
    rfq.fund_ttl_secs = fund_ttl_secs;

    let now = Clock::get()?.unix_timestamp;
    // clocks
    rfq.created_at = now;
    rfq.opened_at = None;
    rfq.selected_at = None;
    rfq.completed_at = None;

    rfq.bump = bump;

    rfq.committed_count = 0;
    rfq.revealed_count = 0;
    rfq.selected_quote = None;
    rfq.settlement = None;

    rfq.bonds_fees_vault = ctx.accounts.bonds_fees_vault.key();
    rfq.maker_payment_account = ctx.accounts.maker_payment_account.key();
    rfq.facilitator = facilitator;

    Ok(())
}
