use crate::state::rfq::{Rfq, RfqState};
use crate::slashing::compute_slashed_amount;
use crate::state::{Config, Quote, SlashedBondsTracker};
use crate::RfqError;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

#[derive(Accounts)]
pub struct RefundQuoteBonds<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        address = rfq.treasury_usdc_owner,
    )]
    pub treasury_usdc_owner: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [Rfq::SEED_PREFIX, rfq.maker.key().as_ref(), rfq.uuid.as_ref()],
        bump = rfq.bump,
        has_one = config,
        constraint = matches!(rfq.state, RfqState::Revealed | RfqState::Selected | RfqState::Settled | RfqState::Ignored | RfqState::Incomplete) @ RfqError::InvalidRfqState,)]
    pub rfq: Box<Account<'info, Rfq>>,

    #[account(
        mut,
        seeds = [Quote::SEED_PREFIX, rfq.key().as_ref(), taker.key().as_ref()],
        bump = quote.bump,
    )]
    pub quote: Box<Account<'info, Quote>>,

    #[account(address = rfq.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

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
        address = rfq.bonds_fees_vault,
    )]
    pub bonds_fees_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = taker,
        address = quote.taker_payment_account,
    )]
    pub taker_payment_account: Box<Account<'info, TokenAccount>>,

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

pub fn refund_quote_bonds_handler(ctx: Context<RefundQuoteBonds>) -> Result<()> {
    let rfq = &mut ctx.accounts.rfq;
    let quote = &mut ctx.accounts.quote;
    let slashed_bonds_tracker = &mut ctx.accounts.slashed_bonds_tracker;

    require!(rfq.revealed_count > 0, RfqError::InvalidRfqState);

    require!(!quote.selected, RfqError::SelectedQuoteNotRefundable);
    require!(quote.is_revealed(), RfqError::UnrevealedQuoteNotRefundable);
    require!(
        !quote.are_bonds_refunded(),
        RfqError::QuoteBondsAlreadyRefunded
    );

    let now = Clock::get()?.unix_timestamp;
    let funding_deadline = rfq.funding_deadline().ok_or(RfqError::InvalidRfqState)?;
    require!(
        now > funding_deadline,
        RfqError::QuoteRefundBeforeFundingDeadline
    );

    let seeds_rfq: &[&[u8]] = &[
        Rfq::SEED_PREFIX,
        rfq.maker.as_ref(),
        rfq.uuid.as_ref(),
        &[rfq.bump],
    ];

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
        rfq.bond_amount,
    )?;

    // update quote
    quote.bonds_refunded_at = Some(now);

    if !slashed_bonds_tracker.is_resolved() {
        match rfq.state {
            // maker didn't select a valid quote
            // or taker didn't complete settlement
            RfqState::Revealed | RfqState::Selected => {
                // Seize unrevealed bonds plus the maker/selected taker bond
                let seized_amount = compute_slashed_amount(rfq, true)?;

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
                // update rfq
                if matches!(rfq.state, RfqState::Revealed) {
                    rfq.state = RfqState::Ignored;
                    rfq.completed_at = Some(now);
                }
            }
            _ => (), // do nothing
        }
    }

    Ok(())
}
