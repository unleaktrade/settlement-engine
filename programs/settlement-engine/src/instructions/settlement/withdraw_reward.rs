use crate::state::rfq::{Rfq, RfqState};
use crate::state::{Config, FacilitatorRewardTracker, Quote, Settlement};
use crate::RfqError;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

#[derive(Accounts)]
pub struct WithdrawReward<'info> {
    #[account(mut)]
    pub facilitator: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [Rfq::SEED_PREFIX, rfq.maker.key().as_ref(), rfq.uuid.as_ref()],
        bump = rfq.bump,
        has_one = config,
        constraint = matches!(rfq.state, RfqState::Settled) @ RfqError::InvalidRfqState,
    )]
    pub rfq: Box<Account<'info, Rfq>>,

    #[account(
        seeds = [Settlement::SEED_PREFIX, rfq.key().as_ref()],
        bump = settlement.bump,
        has_one = rfq,
        has_one = quote @ RfqError::InvalidQuote,
        constraint = settlement.is_complete() @ RfqError::InvalidRfqState,
    )]
    pub settlement: Box<Account<'info, Settlement>>,

    #[account(
        seeds = [Quote::SEED_PREFIX, rfq.key().as_ref(), settlement.taker.as_ref()],
        bump = quote.bump,
        has_one = rfq @ RfqError::InvalidRfqAssociation,
        constraint = quote.selected @ RfqError::InvalidQuoteState,
        constraint = quote.revealed_at.is_some() @ RfqError::InvalidQuoteState,
    )]
    pub quote: Box<Account<'info, Quote>>,

    #[account(address = rfq.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = rfq,
        address = settlement.bonds_fees_vault,
    )]
    pub bonds_fees_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = facilitator,
        associated_token::mint = usdc_mint,
        associated_token::authority = facilitator,
    )]
    pub facilitator_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = facilitator,
        space = 8 + FacilitatorRewardTracker::INIT_SPACE,
        seeds = [
            FacilitatorRewardTracker::SEED_PREFIX,
            rfq.key().as_ref(),
            facilitator.key().as_ref(),
        ],
        bump,
    )]
    pub facilitator_reward_tracker: Box<Account<'info, FacilitatorRewardTracker>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn withdraw_reward_handler(ctx: Context<WithdrawReward>) -> Result<()> {
    let rfq = &ctx.accounts.rfq;
    let settlement = &ctx.accounts.settlement;
    let quote = &ctx.accounts.quote;

    let facilitator_key = ctx.accounts.facilitator.key();
    require!(
        rfq.facilitator == Some(facilitator_key) && quote.facilitator == Some(facilitator_key),
        RfqError::Unauthorized
    );

    let fee_amount_u128 = settlement.fee_amount as u128;
    let bps_u128 = rfq.facilitator_fee_bps as u128;
    let facilitator_share: u64 = fee_amount_u128
        .checked_mul(bps_u128)
        .and_then(|v| v.checked_div(10_000))
        .and_then(|v| u64::try_from(v).ok())
        .ok_or(RfqError::ArithmeticOverflow)?;
    require!(facilitator_share > 0, RfqError::InvalidParams);

    let seeds_rfq: &[&[u8]] = &[
        Rfq::SEED_PREFIX,
        rfq.maker.as_ref(),
        rfq.uuid.as_ref(),
        &[rfq.bump],
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.bonds_fees_vault.to_account_info(),
                to: ctx.accounts.facilitator_ata.to_account_info(),
                authority: rfq.to_account_info(),
            },
            &[seeds_rfq],
        ),
        facilitator_share,
    )?;

    let reward_tracker = &mut ctx.accounts.facilitator_reward_tracker;
    reward_tracker.rfq = rfq.key();
    reward_tracker.facilitator = facilitator_key;
    reward_tracker.usdc_mint = ctx.accounts.usdc_mint.key();
    reward_tracker.amount = facilitator_share;
    reward_tracker.claimed_at = Clock::get()?.unix_timestamp;
    reward_tracker.bump = ctx.bumps.facilitator_reward_tracker;

    Ok(())
}
