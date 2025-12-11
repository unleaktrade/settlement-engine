use crate::state::rfq::{Rfq, RfqState};
use crate::{state::Config, state::SlashedBondsTracker, RfqError};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct CloseExpired<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        mut,
        seeds = [Rfq::SEED_PREFIX, maker.key().as_ref(), rfq.uuid.as_ref()],
        bump = rfq.bump,
        has_one = maker,
        has_one = config,
        constraint = matches!(rfq.state, RfqState::Open | RfqState::Committed) @ RfqError::InvalidRfqState,)]
    pub rfq: Box<Account<'info, Rfq>>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = rfq,
    )]
    pub bonds_fees_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        address = config.treasury_usdc_owner,
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
        token::mint = usdc_mint,
        token::authority = maker,
        constraint = rfq.maker_payment_account == maker_payment_account.key() @ RfqError::UnauthorizedMakerPaymentAccount,
    )]
    pub maker_payment_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [SlashedBondsTracker::SEED_PREFIX, rfq.key().as_ref()],
        bump = slashed_bonds_tracker.bump,
        has_one = usdc_mint,
        has_one = treasury_usdc_owner,
    )]
    pub slashed_bonds_tracker: Account<'info, SlashedBondsTracker>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn close_expired_handler(ctx: Context<CloseExpired>) -> Result<()> {
    let rfq = &mut ctx.accounts.rfq;
    let slashed_bonds_tracker = &mut ctx.accounts.slashed_bonds_tracker;

    require!(rfq.revealed_count == 0, RfqError::InvalidRfqState);
    let reveal_deadline = rfq.reveal_deadline().ok_or(RfqError::InvalidRfqState)?;
    let now = Clock::get()?.unix_timestamp;
    require!(now > reveal_deadline, RfqError::ExpireTooEarly);

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

    if !slashed_bonds_tracker.is_resolved() {
        // Seize other bonds
        let seized_amount: u64 = rfq
            .bond_amount
            .checked_mul(rfq.committed_count.into())
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
    rfq.state = RfqState::Expired;
    rfq.completed_at = Some(now);

    Ok(())
}
