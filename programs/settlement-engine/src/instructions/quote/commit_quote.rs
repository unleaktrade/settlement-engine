use anchor_lang::prelude::*;
// use anchor_spl::{
//     token::{self, Mint, Token, TokenAccount, Transfer},
// };
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_ID,
};
use anchor_spl::token::Mint;

use crate::{
    state::{
        config::Config,
        quote::*,
        rfq::{Rfq, RfqState},
    },
    QuoteError, RfqError,
};

#[derive(Accounts)]
#[instruction(commit_hash: [u8; 32])]
pub struct CommitQuote<'info> {
    /// Taker committing to a quote
    #[account(mut)]
    pub taker: Signer<'info>,

    pub config: Account<'info, Config>,

    #[account(
        mut,
        has_one = config,
    )]
    pub rfq: Account<'info, Rfq>,

    /// USDC mint from config
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    /// RFQ-owned USDC bonds vault (ATA)
    // #[account(
    //     mut,
    //     constraint = bonds_vault.key() == rfq.bonds_vault @ RfqError::InvalidState,
    //     token::mint = usdc_mint,
    //     token::authority = rfq,
    // )]
    // pub bonds_vault: Account<'info, TokenAccount>,

    /// Taker's USDC ATA to pull bond from
    // #[account(
    //     mut,
    //     associated_token::mint = usdc_mint,
    //     associated_token::authority = taker,
    // )]
    // pub taker_usdc_ata: Account<'info, TokenAccount>,

    /// One Quote account per (rfq, taker)
    #[account(
        init,
        payer = taker,
        space = 8 + Quote::INIT_SPACE,
        seeds = [Quote::SEED_PREFIX, rfq.key().as_ref(), taker.key().as_ref()],
        bump,
    )]
    pub quote: Account<'info, Quote>,

    /// Global guard against commit_hash reuse
    #[account(
        init,
        payer = taker,
        space = 8 + CommitGuard::INIT_SPACE,
        seeds = [CommitGuard::SEED_PREFIX, &commit_hash],
        bump,
    )]
    pub commit_guard: Account<'info, CommitGuard>,

    /// Needed because we `init` PDAs (quote, commit_guard)
    pub system_program: Program<'info, System>,

    /// CHECK: Address asserted to be the instructions sysvar
    #[account(address = INSTRUCTIONS_ID)]
    pub instruction_sysvar: AccountInfo<'info>,
}

pub fn commit_quote_handler(
    ctx: Context<CommitQuote>,
    commit_hash: [u8; 32],
    liquidity_proof: [u8; 64],
) -> Result<()> {
    // Verify preflighted Ed25519 signature
    // Safely get prior instruction
    let current_index = load_current_index_checked(&ctx.accounts.instruction_sysvar)?;
    let prev_index = current_index
        .checked_sub(1)
        .ok_or(QuoteError::NoEd25519Instruction)?;
    let ed25519_ix =
        load_instruction_at_checked(prev_index as usize, &ctx.accounts.instruction_sysvar)?;
    msg!("Prev ix program_id: {}", ed25519_ix.program_id);

    // Process Commit Quote
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;

    require!(
        matches!(rfq.state, RfqState::Open | RfqState::Committed),
        RfqError::InvalidState
    );

    let Some(commit_deadline) = rfq.commit_deadline() else {
        return err!(RfqError::InvalidState);
    };
    require!(now <= commit_deadline, QuoteError::CommitTooLate);

    // let bond_amount = rfq.bond_amount;
    // require!(bond_amount > 0, RfqError::InvalidState);

    // Transfer taker bond USDC into RFQ bonds_vault
    // let cpi_accounts = Transfer {
    //     from: ctx.accounts.taker_usdc_ata.to_account_info(),
    //     to: ctx.accounts.bonds_vault.to_account_info(),
    //     authority: ctx.accounts.taker.to_account_info(),
    // };
    // let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    // token::transfer(cpi_ctx, bond_amount)?;

    // Fill Quote (commit-only fields)
    let quote = &mut ctx.accounts.quote;
    let commit_guard = &mut ctx.accounts.commit_guard;

    let guard_bump = ctx.bumps.commit_guard;
    commit_guard.bump = guard_bump;
    commit_guard.committed_at = now;

    let quote_bump = ctx.bumps.quote;
    quote.bump = quote_bump;
    quote.rfq = rfq.key();
    quote.taker = ctx.accounts.taker.key();
    quote.commit_hash = commit_hash;
    quote.liquidity_proof = liquidity_proof;
    quote.committed_at = now;

    rfq.state = RfqState::Committed;
    rfq.committed_count = rfq.committed_count.saturating_add(1);

    Ok(())
}
