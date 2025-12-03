use anchor_lang::prelude::*;
use instructions::*;
use rfq_errors::*;

pub mod instructions;
pub mod rfq_errors;
pub mod state;

// Program ID
declare_id!("E2amAUcnxFqJPbekUWPEAYkdahFPAnWoCFwaz2bryUJF");

#[program]
pub mod settlement_engine {
    use super::*;

    pub fn init_config(
        ctx: Context<InitConfig>,
        usdc_mint: Pubkey,
        treasury_usdc_owner: Pubkey,
        liquidity_guard: Pubkey,
    ) -> Result<()> {
        init_config::init_config_handler(ctx, usdc_mint, treasury_usdc_owner, liquidity_guard)
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_admin: Option<Pubkey>,
        new_usdc_mint: Option<Pubkey>,
        new_treasury_usdc_owner: Option<Pubkey>,
        new_liquidity_guard: Option<Pubkey>,
    ) -> Result<()> {
        update_config::update_config_handler(
            ctx,
            new_admin,
            new_usdc_mint,
            new_treasury_usdc_owner,
            new_liquidity_guard,
        )
    }

    pub fn close_config(ctx: Context<CloseConfig>) -> Result<()> {
        close_config::close_config_handler(ctx)
    }

    // RFQ module
    pub fn init_rfq(
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
    ) -> Result<()> {
        init_rfq::init_rfq_handler(
            ctx,
            uuid,
            base_mint,
            quote_mint,
            bond_amount,
            base_amount,
            min_quote_amount,
            taker_fee_usdc,
            commit_ttl_secs,
            reveal_ttl_secs,
            selection_ttl_secs,
            fund_ttl_secs,
        )
    }

    pub fn update_rfq(
        ctx: Context<UpdateRfq>,
        new_base_mint: Option<Pubkey>,
        new_quote_mint: Option<Pubkey>,
        new_bond_amount: Option<u64>,
        new_base_amount: Option<u64>,
        new_min_quote_amount: Option<u64>,
        new_taker_fee_usdc: Option<u64>,
        new_commit_ttl_secs: Option<u32>,
        new_reveal_ttl_secs: Option<u32>,
        new_selection_ttl_secs: Option<u32>,
        new_fund_ttl_secs: Option<u32>,
    ) -> Result<()> {
        update_rfq::update_rfq_handler(
            ctx,
            new_base_mint,
            new_quote_mint,
            new_bond_amount,
            new_base_amount,
            new_min_quote_amount,
            new_taker_fee_usdc,
            new_commit_ttl_secs,
            new_reveal_ttl_secs,
            new_selection_ttl_secs,
            new_fund_ttl_secs,
        )
    }

    pub fn open_rfq(ctx: Context<OpenRfq>) -> Result<()> {
        open_rfq::open_rfq_handler(ctx)
    }
    pub fn cancel_rfq(ctx: Context<CancelRfq>) -> Result<()> {
        cancel_rfq::cancel_rfq_handler(ctx)
    }

    pub fn commit_quote(
        ctx: Context<CommitQuote>,
        commit_hash: [u8; 32],
        liquidity_proof: [u8; 64],
    ) -> Result<()> {
        commit_quote::commit_quote_handler(ctx, commit_hash, liquidity_proof)
    }

    pub fn reveal_quote(
        ctx: Context<RevealQuote>,
        salt: [u8; 64],
        quote_amount: u64,
    ) -> Result<()> {
        reveal_quote::reveal_quote_handler(ctx, salt, quote_amount)
    }

    pub fn select_quote(ctx: Context<SelectQuote>) -> Result<()> {
        select_quote::select_quote_handler(ctx)
    }

    // pub fn close_ignored(ctx: Context<CloseIgnored>) -> Result<()> {
    //     close_ignored::close_ignored_handler(ctx)
    // }
    // pub fn close_expired(ctx: Context<CloseExpired>) -> Result<()> {
    //     close_expired::close_expired_handler(ctx)
    // }
    // pub fn close_aborted(ctx: Context<CloseAborted>) -> Result<()> {
    //     close_aborted::close_aborted_handler(ctx)
    // }
}
