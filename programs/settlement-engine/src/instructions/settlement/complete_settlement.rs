use crate::rfq_errors::RfqError;
use crate::state::rfq::{Rfq, RfqState};
use crate::state::{Config, FeesTracker, Settlement};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

#[derive(Accounts)]
pub struct CompleteSettlement<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        address = config.treasury_usdc_owner,
    )]
    pub treasury_usdc_owner: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [Rfq::SEED_PREFIX, rfq.maker.key().as_ref(), rfq.uuid.as_ref()],
        bump = rfq.bump,
        has_one = config,
    )]
    pub rfq: Box<Account<'info, Rfq>>,

    #[account(
        mut,
        seeds = [Settlement::SEED_PREFIX, rfq.key().as_ref()],
        bump,
        has_one = rfq,
        has_one = taker,
    )]
    pub settlement: Box<Account<'info, Settlement>>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(address = settlement.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,

    #[account(address = settlement.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = usdc_mint,
        associated_token::authority = treasury_usdc_owner,
    )]
    pub treasury_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = rfq,
        address = settlement.bonds_fees_vault,
    )]
    pub bonds_fees_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = taker,
    )]
    pub taker_payment_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = settlement.maker,
        address = settlement.maker_payment_account,
    )]
    pub maker_payment_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = base_mint,
        associated_token::authority = rfq,
        address = settlement.vault_base_ata,
    )]
    pub vault_base_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = base_mint,
        associated_token::authority = taker,
    )]
    pub taker_base_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = quote_mint,
        associated_token::authority = settlement.maker,
        address = settlement.maker_quote_account,
    )]
    pub maker_quote_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = taker,
    )]
    pub taker_quote_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = taker,
        space = 8 + FeesTracker::INIT_SPACE,
        seeds = [FeesTracker::SEED_PREFIX, rfq.key().as_ref()],
        bump,
    )]
    pub fees_tracker: Box<Account<'info, FeesTracker>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn complete_settlement_handler(ctx: Context<CompleteSettlement>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;
    let settlement = &mut ctx.accounts.settlement;
    let fees_tracker = &mut ctx.accounts.fees_tracker;

    let Some(funding_deadline) = rfq.funding_deadline() else {
        return err!(RfqError::InvalidRfqState);
    };
    require!(now <= funding_deadline, RfqError::FundingTooLate);
    require!(
        matches!(rfq.state, RfqState::Selected),
        RfqError::InvalidRfqState
    );

    // Refund maker's bond
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
                to: ctx.accounts.maker_payment_account.to_account_info(),
                authority: rfq.to_account_info(),
            },
            &[seeds_rfq],
        ),
        settlement.bond_amount,
    )?;

    // Refund taker's bond
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.bonds_fees_vault.to_account_info(),
                to: ctx.accounts.taker_payment_account.to_account_info(),
                authority: rfq.to_account_info(),
            },
            &[seeds_rfq],
        ),
        settlement.bond_amount,
    )?;

    // Collect taker fees to treasury
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.taker_payment_account.to_account_info(),
                to: ctx.accounts.treasury_ata.to_account_info(),
                authority: ctx.accounts.taker.to_account_info(),
            },
        ),
        settlement.fee_amount,
    )?;

    // Deliver base asset from vault to taker
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_base_ata.to_account_info(),
                to: ctx.accounts.taker_base_account.to_account_info(),
                authority: rfq.to_account_info(),
            },
            &[seeds_rfq],
        ),
        settlement.base_amount,
    )?;

    // Deliver quote asset from taker to maker
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.taker_quote_account.to_account_info(),
                to: ctx.accounts.maker_quote_account.to_account_info(),
                authority: ctx.accounts.taker.to_account_info(),
            },
        ),
        settlement.quote_amount,
    )?;

    // update rfq
    rfq.state = RfqState::Settled;
    rfq.completed_at = Some(now);
    //update settlement
    settlement.completed_at = Some(now);
    settlement.taker_funded_at = Some(now);
    settlement.taker_base_account = Some(ctx.accounts.taker_base_account.key());
    settlement.taker_quote_account = Some(ctx.accounts.taker_quote_account.key());
    // fill fees tracker
    fees_tracker.rfq = settlement.rfq;
    fees_tracker.taker = settlement.taker;
    fees_tracker.usdc_mint = ctx.accounts.config.usdc_mint;
    fees_tracker.treasury_usdc_owner = ctx.accounts.config.treasury_usdc_owner;
    fees_tracker.amount = settlement.fee_amount;
    fees_tracker.payed_at = now;
    fees_tracker.bump = ctx.bumps.fees_tracker;

    Ok(())
}
