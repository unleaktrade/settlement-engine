use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_ID,
};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::{
    state::{
        config::Config,
        quote::*,
        rfq::{Rfq, RfqState},
    },
    RfqError,
};

#[derive(Accounts)]
#[instruction(commit_hash: [u8; 32])]
pub struct CommitQuote<'info> {
    /// Taker committing to a quote
    #[account(mut)]
    pub taker: Signer<'info>,

    /// Global config account
    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        has_one = config,
        constraint = matches!(rfq.state, RfqState::Open | RfqState::Committed) @ RfqError::InvalidRfqState,
    )]
    pub rfq: Box<Account<'info, Rfq>>,

    /// USDC mint from config
    #[account(address = rfq.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

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

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = rfq,
    )]
    pub bonds_fees_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = taker,
        constraint =!taker_payment_account.is_frozen() @ RfqError::TakerPaymentAccountClosed,
    )]
    pub taker_payment_account: Account<'info, TokenAccount>,

    /// Needed because we `init` PDAs (quote, commit_guard)
    pub system_program: Program<'info, System>,

    /// CHECK: Address asserted to be the instructions sysvar
    #[account(address = INSTRUCTIONS_ID)]
    pub instruction_sysvar: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn commit_quote_handler(
    ctx: Context<CommitQuote>,
    commit_hash: [u8; 32],
    liquidity_proof: [u8; 64],
    facilitator: Option<Pubkey>,
) -> Result<()> {
    // Verify preflighted Ed25519 signature
    // Safely get prior instruction
    let current_index = load_current_index_checked(&ctx.accounts.instruction_sysvar)?;
    let prev_index = current_index
        .checked_sub(1)
        .ok_or_else(|| RfqError::NoEd25519Instruction)?;
    let ed25519_ix =
        load_instruction_at_checked(prev_index as usize, &ctx.accounts.instruction_sysvar)?;
    #[cfg(feature = "debug-logs")]
    msg!("Prev ix program_id: {}", ed25519_ix.program_id);

    // Must be native Ed25519
    let expected = Pubkey::from_str_const("Ed25519SigVerify111111111111111111111111111");
    require_keys_eq!(
        ed25519_ix.program_id,
        expected,
        RfqError::InvalidEd25519Program
    );

    // Parse Ed25519 instruction
    let data = &ed25519_ix.data;
    require!(data.len() >= 112, RfqError::InvalidEd25519Data);
    require!(data[0] == 1, RfqError::InvalidSignatureCount);

    let sig_offset = u16::from_le_bytes([data[2], data[3]]) as usize;
    let sig_ix_index = u16::from_le_bytes([data[4], data[5]]);
    let pubkey_offset = u16::from_le_bytes([data[6], data[7]]) as usize;
    let pubkey_ix_index = u16::from_le_bytes([data[8], data[9]]);
    let msg_offset = u16::from_le_bytes([data[10], data[11]]) as usize;
    let msg_size = u16::from_le_bytes([data[12], data[13]]) as usize;
    let msg_ix_index = u16::from_le_bytes([data[14], data[15]]);

    #[cfg(feature = "debug-logs")]
    msg!("sig_ix_index={}", sig_ix_index);
    #[cfg(feature = "debug-logs")]
    msg!("pubkey_ix_index={}", pubkey_ix_index);
    #[cfg(feature = "debug-logs")]
    msg!("msg_ix_index={}", msg_ix_index);
    #[cfg(feature = "debug-logs")]
    msg!("sig_offset={}", sig_offset);
    #[cfg(feature = "debug-logs")]
    msg!("pubkey_offset={}", pubkey_offset);
    #[cfg(feature = "debug-logs")]
    msg!("msg_offset={}", msg_offset);
    #[cfg(feature = "debug-logs")]
    msg!("msg_size={}", msg_size);

    // Enforce same-instruction sourcing (prevents cross-instruction substitution)
    require!(sig_ix_index == 0xFFFF, RfqError::InvalidOffset);
    require!(pubkey_ix_index == 0xFFFF, RfqError::InvalidOffset);
    require!(msg_ix_index == 0xFFFF, RfqError::InvalidOffset);
    require!(msg_size == 32, RfqError::InvalidMessageSize);

    // Bounds
    require!(
        data.len().saturating_sub(sig_offset) >= 64,
        RfqError::InvalidEd25519Data
    );
    require!(
        data.len().saturating_sub(pubkey_offset) >= 32,
        RfqError::InvalidEd25519Data
    );
    require!(
        data.len().saturating_sub(msg_offset) >= 32,
        RfqError::InvalidEd25519Data
    );

    // Authorized Liquidity Guard signer check
    let pubkey_bytes = &data[pubkey_offset..pubkey_offset + 32];
    require!(
        pubkey_bytes == ctx.accounts.rfq.liquidity_guard.as_ref(),
        RfqError::UnauthorizedSigner
    );

    // Bind exact 32-byte message
    let verified_hash_slice = &data[msg_offset..msg_offset + 32];
    require!(
        verified_hash_slice == &commit_hash,
        RfqError::CommitHashMismatch
    );

    // Bind exact 64-byte signature (liquidity_proof)
    let verified_signature_slice = &data[sig_offset..sig_offset + 64];
    require!(
        verified_signature_slice == &liquidity_proof,
        RfqError::LiquidityProofSignatureMismatch
    );

    // Process Commit Quote
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;

    let Some(commit_deadline) = rfq.commit_deadline() else {
        return err!(RfqError::InvalidRfqState);
    };
    require!(now <= commit_deadline, RfqError::CommitTooLate);

    let Some(funding_deadline) = rfq.funding_deadline() else {
        return err!(RfqError::InvalidRfqState);
    };

    // Transfer taker bond USDC into RFQ's vault
    let cpi_accounts = Transfer {
        from: ctx.accounts.taker_payment_account.to_account_info(),
        to: ctx.accounts.bonds_fees_vault.to_account_info(),
        authority: ctx.accounts.taker.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    token::transfer(cpi_ctx, rfq.bond_amount)?;

    // Fill Quote (commit-only fields)
    let quote = &mut ctx.accounts.quote;
    let commit_guard = &mut ctx.accounts.commit_guard;

    let guard_bump = ctx.bumps.commit_guard;
    commit_guard.bump = guard_bump;
    commit_guard.committed_at = now;
    commit_guard.quote = quote.key();

    let quote_bump = ctx.bumps.quote;
    quote.bump = quote_bump;
    quote.rfq = rfq.key();
    quote.taker = ctx.accounts.taker.key();
    quote.commit_hash = commit_hash;
    quote.liquidity_proof = liquidity_proof;
    quote.committed_at = now;
    quote.revealed_at = None;
    quote.max_funding_deadline = funding_deadline;
    quote.selected = false;
    quote.bonds_refunded_at = None;
    quote.quote_amount = None; // to be filled on reveal
    quote.taker_payment_account = ctx.accounts.taker_payment_account.key();
    quote.facilitator = facilitator;

    rfq.state = RfqState::Committed;
    rfq.committed_count = rfq
        .committed_count
        .checked_add(1)
        .ok_or(RfqError::ArithmeticOverflow)?;

    Ok(())
}
