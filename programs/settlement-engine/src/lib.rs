use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

pub use errors::*;

use crate::instructions::{
    close_config, init_config,
    rfq::{
        cancel_rfq, close_aborted, close_expired, close_ignored, init_rfq, mark_committed,
        mark_funded, mark_revealed, open_rfq, select_quote, settle_rfq,
    },
    update_config,
};
use instructions::{
    close_config::*,
    init_config::*,
    rfq::{
        cancel_rfq::*, close_aborted::*, close_expired::*, close_ignored::*, init_rfq::*,
        mark_committed::*, mark_funded::*, mark_revealed::*, open_rfq::*, select_quote::*,
        settle_rfq::*,
    },
    update_config::*,
};

// Program ID
declare_id!("E2amAUcnxFqJPbekUWPEAYkdahFPAnWoCFwaz2bryUJF");

#[program]
pub mod settlement_engine {
    use super::*;

    pub fn init_config(
        ctx: Context<InitConfig>,
        usdc_mint: Pubkey,
        treasury_usdc_owner: Pubkey,
    ) -> Result<()> {
        init_config::handler(ctx, usdc_mint, treasury_usdc_owner)
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_admin: Option<Pubkey>,
        new_usdc_mint: Option<Pubkey>,
        new_treasury_usdc_owner: Option<Pubkey>,
    ) -> Result<()> {
        update_config::handler(ctx, new_admin, new_usdc_mint, new_treasury_usdc_owner)
    }

    pub fn close_config(ctx: Context<CloseConfig>) -> Result<()> {
        close_config::handler(ctx)
    }

    // RFQ module
    pub fn init_rfq(
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
        init_rfq::handler(
            ctx,
            uuid,
            base_mint,
            quote_mint,
            bond_amount,
            commit_ttl_secs,
            reveal_ttl_secs,
            selection_ttl_secs,
            fund_ttl_secs,
        )
    }

    pub fn open_rfq(ctx: Context<OpenRfq>) -> Result<()> {
        open_rfq::handler(ctx)
    }
    pub fn cancel_rfq(ctx: Context<CancelRfq>) -> Result<()> {
        cancel_rfq::handler(ctx)
    }

    pub fn mark_committed(ctx: Context<MarkCommitted>) -> Result<()> {
        mark_committed::handler(ctx)
    }
    pub fn mark_revealed(ctx: Context<MarkRevealed>) -> Result<()> {
        mark_revealed::handler(ctx)
    }

    pub fn select_quote(ctx: Context<SelectQuote>, quote_key: Pubkey) -> Result<()> {
        select_quote::handler(ctx, quote_key)
    }

    pub fn mark_funded(ctx: Context<MarkFunded>, side: mark_funded::FundSide) -> Result<()> {
        mark_funded::handler(ctx, side)
    }

    pub fn settle_rfq(ctx: Context<SettleRfq>) -> Result<()> {
        settle_rfq::handler(ctx)
    }

    pub fn close_ignored(ctx: Context<CloseIgnored>) -> Result<()> {
        close_ignored::handler(ctx)
    }
    pub fn close_expired(ctx: Context<CloseExpired>) -> Result<()> {
        close_expired::handler(ctx)
    }
    pub fn close_aborted(ctx: Context<CloseAborted>) -> Result<()> {
        close_aborted::handler(ctx)
    }
}
