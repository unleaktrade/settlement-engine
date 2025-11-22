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

    // Must be native Ed25519
    let expected = Pubkey::from_str_const("Ed25519SigVerify111111111111111111111111111");
    require_keys_eq!(
        ed25519_ix.program_id,
        expected,
        QuoteError::InvalidEd25519Program
    );

    // Parse Ed25519 instruction
    let data = &ed25519_ix.data;
    require!(data.len() >= 112, QuoteError::InvalidEd25519Data);
    require!(data[0] == 1, QuoteError::InvalidSignatureCount);

    let sig_offset = u16::from_le_bytes([data[2], data[3]]) as usize;
    let sig_ix_index = u16::from_le_bytes([data[4], data[5]]);
    let pubkey_offset = u16::from_le_bytes([data[6], data[7]]) as usize;
    let pubkey_ix_index = u16::from_le_bytes([data[8], data[9]]);
    let msg_offset = u16::from_le_bytes([data[10], data[11]]) as usize;
    let msg_size = u16::from_le_bytes([data[12], data[13]]) as usize;
    let msg_ix_index = u16::from_le_bytes([data[14], data[15]]);

    msg!("sig_ix_index={}", sig_ix_index);
    msg!("pubkey_ix_index={}", pubkey_ix_index);
    msg!("msg_ix_index={}", msg_ix_index);
    msg!("sig_offset={}", sig_offset);
    msg!("pubkey_offset={}", pubkey_offset);
    msg!("msg_offset={}", msg_offset);
    msg!("msg_size={}", msg_size);

    // Enforce same-instruction sourcing (prevents cross-instruction substitution)
    require!(sig_ix_index == 0xFFFF, QuoteError::InvalidOffset);
    require!(pubkey_ix_index == 0xFFFF, QuoteError::InvalidOffset);
    require!(msg_ix_index == 0xFFFF, QuoteError::InvalidOffset);
    require!(msg_size == 32, QuoteError::InvalidMessageSize);

    // Bounds
    require!(
        data.len().saturating_sub(sig_offset) >= 64,
        QuoteError::InvalidEd25519Data
    );
    require!(
        data.len().saturating_sub(pubkey_offset) >= 32,
        QuoteError::InvalidEd25519Data
    );
    require!(
        data.len().saturating_sub(msg_offset) >= 32,
        QuoteError::InvalidEd25519Data
    );

    // Authorized Liquidity Guard signer check
    let pubkey_bytes = &data[pubkey_offset..pubkey_offset + 32];
    require!(
        pubkey_bytes == ctx.accounts.config.liquidity_guard.as_ref(),
        QuoteError::UnauthorizedSigner
    );

    // Bind exact 32-byte message
    let verified_hash_slice = &data[msg_offset..msg_offset + 32];
    require!(
        verified_hash_slice == &commit_hash,
        QuoteError::CommitHashMismatch
    );

    // Bind exact 64-byte signature (liquidity_proof)
    let verified_signature_slice = &data[sig_offset..sig_offset + 64];
    require!(
        verified_signature_slice == &liquidity_proof,
        QuoteError::LiquidityProofSignatureMismatch
    );

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
    quote.revealed_at = None;
    quote.is_valid = false;

    rfq.state = RfqState::Committed;
    rfq.committed_count = rfq.committed_count.saturating_add(1);

    Ok(())
}
