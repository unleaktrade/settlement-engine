use crate::state::rfq::{Rfq, RfqState};
use crate::RfqError;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpdateRfq<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        mut,
        seeds = [Rfq::SEED_PREFIX, maker.key().as_ref(), rfq.uuid.as_ref()],
        bump = rfq.bump,
        has_one = maker,
        constraint = matches!(rfq.state, RfqState::Draft) @ RfqError::InvalidRfqState,)]
    pub rfq: Account<'info, Rfq>,
}

pub fn update_rfq_handler(
    ctx: Context<UpdateRfq>,
    // Option<>s so the maker can patch specific fields
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
    let rfq = &mut ctx.accounts.rfq;

    if let Some(v) = new_base_mint {
        rfq.base_mint = v;
    }
    if let Some(v) = new_quote_mint {
        rfq.quote_mint = v;
    }

    if let Some(v) = new_bond_amount {
        require!(v > 0, RfqError::InvalidBondAmount);
        rfq.bond_amount = v;
    }
    if let Some(v) = new_base_amount {
        require!(v > 0, RfqError::InvalidBaseAmount);
        rfq.base_amount = v;
    }
    if let Some(v) = new_min_quote_amount {
        require!(v > 0, RfqError::InvalidMinQuoteAmount);
        rfq.min_quote_amount = v;
    }
    if let Some(v) = new_taker_fee_usdc {
        // fee_amount can be zero
        // require!(v > 0, RfqError::InvalidFeeAmount);
        rfq.fee_amount = v;
    }

    if let Some(v) = new_commit_ttl_secs {
        require!(v > 0, RfqError::InvalidCommitTTL);
        rfq.commit_ttl_secs = v;
    }
    if let Some(v) = new_reveal_ttl_secs {
        require!(v > 0, RfqError::InvalidRevealTTL);
        rfq.reveal_ttl_secs = v;
    }
    if let Some(v) = new_selection_ttl_secs {
        require!(v > 0, RfqError::InvalidSelectionTTL);
        rfq.selection_ttl_secs = v;
    }
    if let Some(v) = new_fund_ttl_secs {
        require!(v > 0, RfqError::InvalidFundingTTL);
        rfq.fund_ttl_secs = v;
    }

    Ok(())
}
