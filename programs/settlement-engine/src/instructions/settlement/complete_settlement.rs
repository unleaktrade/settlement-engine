use crate::rfq_errors::RfqError;
use crate::state::rfq::{Rfq, RfqState};
use crate::state::{Config, Settlement};
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
    )]
    pub settlement: Box<Account<'info, Settlement>>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    #[account(address = settlement.base_mint)]
    pub base_mint: Account<'info, Mint>,

    #[account(address = settlement.quote_mint)]
    pub quote_mint: Account<'info, Mint>,

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
    )]
    pub maker_payment_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = base_mint,
        associated_token::authority = rfq,
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
    )]
    pub maker_quote_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = taker,
    )]
    pub taker_quote_account: Box<Account<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn complete_settlement_handler(ctx: Context<CompleteSettlement>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rfq = &mut ctx.accounts.rfq;
    let settlement = &mut ctx.accounts.settlement;

    //TODO : manage the fact that a valid taker could claim extra bonds
    //TODO: test accounts (move constraints in handler)
    let Some(funding_deadline) = rfq.funding_deadline() else {
        return err!(RfqError::InvalidRfqState);
    };
    require!(now <= funding_deadline, RfqError::FundingTooLate);

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

    Ok(())
}
