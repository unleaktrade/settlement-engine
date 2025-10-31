use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{AssociatedToken, get_associated_token_address},
    token::{Mint, Token, TokenAccount},
};
use crate::state::{config::Config, rfq::{Rfq, RfqState}};
use crate::RfqError::InvalidBondVault;

#[derive(Accounts)]
#[instruction(uuid: [u8; 16])]
pub struct InitRfq<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

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

    // Create RFQ-owned USDC ATA
    #[account(
        init_if_needed,
        payer = maker,
        associated_token::mint = usdc_mint,       // <-- now an account field
        associated_token::authority = rfq,
    )]
    pub bonds_vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>, // for token account initialization
    pub associated_token_program: Program<'info, AssociatedToken>, // for ATA initialization
}

pub fn handler(
    ctx: Context<InitRfq>,
    uuid: [u8; 16],
    base_mint: Pubkey,
    quote_mint: Pubkey,
    bond_amount: u64,
    commit_ttl_secs: u32,
    reveal_ttl_secs: u32,
    selection_ttl_secs: u32,
    fund_ttl_secs: u32,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bump = ctx.bumps.rfq;

    // --- Optional runtime check (defense-in-depth) -------------------------
    // Ensure the passed `bonds_vault` really is the ATA(owner=rfq, mint=USDC).
    // This is redundant with the account constraint but makes intent explicit.
    let expected_vault =
        get_associated_token_address(&ctx.accounts.rfq.key(), &ctx.accounts.config.usdc_mint);
    require_keys_eq!(
        ctx.accounts.bonds_vault.key(),
        expected_vault,
        InvalidBondVault
    );

    // --- Initialize RFQ -----------------------------------------------------
    let rfq = &mut ctx.accounts.rfq;
    rfq.config = ctx.accounts.config.key();
    rfq.maker = ctx.accounts.maker.key();
    rfq.uuid = uuid;
    rfq.state = RfqState::Draft;

    rfq.base_mint = base_mint;
    rfq.quote_mint = quote_mint;
    rfq.bond_amount = bond_amount;

    rfq.commit_ttl_secs = commit_ttl_secs;
    rfq.reveal_ttl_secs = reveal_ttl_secs;
    rfq.selection_ttl_secs = selection_ttl_secs;
    rfq.fund_ttl_secs = fund_ttl_secs;

    rfq.created_at = now;
    rfq.expires_at =
        now + (commit_ttl_secs + reveal_ttl_secs + selection_ttl_secs + fund_ttl_secs) as i64;
    rfq.selected_at = None;
    rfq.bump = bump;

    rfq.committed_count = 0;
    rfq.revealed_count = 0;
    rfq.selected_quote = None;
    rfq.maker_funded = false;
    rfq.taker_funded = false;

    rfq.bonds_vault = ctx.accounts.bonds_vault.key();

    Ok(())
}
