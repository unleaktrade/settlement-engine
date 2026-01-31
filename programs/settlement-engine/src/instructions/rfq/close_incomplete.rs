use crate::state::rfq::{Rfq, RfqState};
use crate::state::{Config, Settlement, SlashedBondsTracker};
use crate::RfqError;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct CloseIncomplete<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [Rfq::SEED_PREFIX, maker.key().as_ref(), rfq.uuid.as_ref()],
        bump = rfq.bump,
        has_one = maker @ RfqError::Unauthorized,
        has_one = config,
        constraint = matches!(rfq.state, RfqState::Selected) @ RfqError::InvalidRfqState,)
    ]
    pub rfq: Box<Account<'info, Rfq>>,

    #[account(
        mut,
        close = maker,
        seeds = [Settlement::SEED_PREFIX, rfq.key().as_ref()],
        bump = settlement.bump,
        has_one = rfq,
    )]
    pub settlement: Box<Account<'info, Settlement>>,

    #[account(address = settlement.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = base_mint,
        associated_token::authority = rfq,
        address = settlement.vault_base_ata,
    )]
    pub vault_base_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = base_mint,
        token::authority = maker,
        address = settlement.maker_base_account,
    )]
    pub maker_base_account: Box<Account<'info, TokenAccount>>,

    #[account(address = rfq.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = rfq,
    )]
    pub bonds_fees_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = maker,
        constraint = rfq.maker_payment_account == maker_payment_account.key() @ RfqError::UnauthorizedMakerPaymentAccount,
    )]
    pub maker_payment_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = rfq.treasury_usdc_owner,
    )]
    pub treasury_usdc_owner: SystemAccount<'info>,

    #[account(
        init_if_needed,
        payer = maker,
        associated_token::mint = usdc_mint,
        associated_token::authority = treasury_usdc_owner,
    )]
    pub treasury_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [SlashedBondsTracker::SEED_PREFIX, rfq.key().as_ref()],
        bump = slashed_bonds_tracker.bump,
        has_one = usdc_mint,
        has_one = treasury_usdc_owner,
    )]
    pub slashed_bonds_tracker: Box<Account<'info, SlashedBondsTracker>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn close_incomplete_handler(ctx: Context<CloseIncomplete>) -> Result<()> {
    let rfq = &mut ctx.accounts.rfq;
    let slashed_bonds_tracker = &mut ctx.accounts.slashed_bonds_tracker;
    let now = Clock::get()?.unix_timestamp;

    let deadline = rfq.funding_deadline().ok_or(RfqError::InvalidRfqState)?;
    require!(now > deadline, RfqError::TooEarly);

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
        rfq.bond_amount,
    )?;
    // refund maker's base
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_base_ata.to_account_info(),
                to: ctx.accounts.maker_base_account.to_account_info(),
                authority: rfq.to_account_info(),
            },
            &[seeds_rfq],
        ),
        rfq.base_amount,
    )?;

    if !slashed_bonds_tracker.is_resolved() {
        // Seize other bonds
        let seized_amount: u64 = rfq
            .committed_count
            .checked_sub(rfq.revealed_count) // violations = commits - reveals
            .and_then(|v| v.checked_add(1)) // taker's quote was valid and must be added
            .and_then(|v| rfq.bond_amount.checked_mul(v.into()))
            .ok_or(RfqError::ArithmeticOverflow)?;

        if seized_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.bonds_fees_vault.to_account_info(),
                        to: ctx.accounts.treasury_ata.to_account_info(),
                        authority: rfq.to_account_info(),
                    },
                    &[seeds_rfq],
                ),
                seized_amount,
            )?;
        }

        // update slashed bonds tracker
        slashed_bonds_tracker.amount = Some(seized_amount);
        slashed_bonds_tracker.seized_at = Some(now);
    }

    // update rfq
    rfq.state = RfqState::Incomplete;
    rfq.settlement = None;
    rfq.completed_at = Some(now);
    Ok(())
}
