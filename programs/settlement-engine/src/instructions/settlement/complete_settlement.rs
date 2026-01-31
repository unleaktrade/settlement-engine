use crate::rfq_errors::RfqError;
use crate::state::rfq::{Rfq, RfqState};
use crate::slashing::compute_slashed_amount;
use crate::state::{Config, FeesTracker, Quote, Settlement, SlashedBondsTracker};
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
        address = rfq.treasury_usdc_owner,
    )]
    pub treasury_usdc_owner: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [Rfq::SEED_PREFIX, rfq.maker.key().as_ref(), rfq.uuid.as_ref()],
        bump = rfq.bump,
    )]
    pub rfq: Box<Account<'info, Rfq>>,

    //quote provided in remaining_accounts
    #[account(
        mut,
        seeds = [Settlement::SEED_PREFIX, rfq.key().as_ref()],
        bump,
    )]
    pub settlement: Box<Account<'info, Settlement>>,

    #[account(address = rfq.usdc_mint)]
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

    // slashed_bonds_tracker provided in remaining_accounts
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn complete_settlement_handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, CompleteSettlement<'info>>,
) -> Result<()> {
    let rfq = &mut ctx.accounts.rfq;
    let settlement = &mut ctx.accounts.settlement;
    let fees_tracker = &mut ctx.accounts.fees_tracker;

    let Some(funding_deadline) = rfq.funding_deadline() else {
        return err!(RfqError::InvalidRfqState);
    };
    let now = Clock::get()?.unix_timestamp;
    require!(now <= funding_deadline, RfqError::FundingTooLate);
    require!(
        matches!(rfq.state, RfqState::Selected),
        RfqError::InvalidRfqState
    );
    require!(
        rfq.config == ctx.accounts.config.key(),
        RfqError::InvalidConfig
    );
    require!(settlement.rfq == rfq.key(), RfqError::InvalidRfq);
    require!(
        settlement.taker == ctx.accounts.taker.key(),
        RfqError::InvalidTaker
    );
    require!(
        settlement.taker_payment_account == ctx.accounts.taker_payment_account.key(),
        RfqError::InvalidTakerPaymentAccount
    );

    // resolve quote and slashed_bonds_tracker from remaining_accounts (order-agnostic)
    require!(
        ctx.remaining_accounts.len() >= 2,
        RfqError::MissingQuoteAccount
    );

    let quote_seeds: &[&[u8]] = &[
        Quote::SEED_PREFIX,
        settlement.rfq.as_ref(),
        settlement.taker.as_ref(),
    ];
    let (quote_expected_pda, quote_bump) = Pubkey::find_program_address(quote_seeds, &crate::ID);

    let slashed_bonds_tracker_seeds: &[&[u8]] =
        &[SlashedBondsTracker::SEED_PREFIX, settlement.rfq.as_ref()];
    let (slashed_bonds_tracker_expected_pda, slashed_bonds_tracker_bump) =
        Pubkey::find_program_address(slashed_bonds_tracker_seeds, &crate::ID);

    let mut quote_ai: Option<&AccountInfo<'info>> = None;
    let mut slashed_ai: Option<&AccountInfo<'info>> = None;
    for ai in ctx.remaining_accounts.iter() {
        if ai.key() == quote_expected_pda {
            quote_ai = Some(ai);
        } else if ai.key() == slashed_bonds_tracker_expected_pda {
            slashed_ai = Some(ai);
        }
    }

    let quote_ai = quote_ai.ok_or(RfqError::MissingQuoteAccount)?;
    let slashed_ai = slashed_ai.ok_or(RfqError::MissingSlashedBondsTrackerAccount)?;

    require_keys_eq!(*quote_ai.owner, crate::ID, RfqError::InvalidOwner);
    require_keys_eq!(*slashed_ai.owner, crate::ID, RfqError::InvalidOwner);

    let mut quote: Account<'info, Quote> = Account::try_from(quote_ai)?;
    require_eq!(quote_bump, quote.bump, RfqError::BumpMismatch);
    require_eq!(quote.key(), settlement.quote, RfqError::InvalidQuote);
    require!(quote.selected, RfqError::InvalidQuoteState);

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

    // Collect taker fees to treasury and optionally retain facilitator share in bonds_fees_vault.
    let facilitator_fee_bps = rfq.facilitator_fee_bps;
    let facilitator_share: u64 =
        if rfq.facilitator.is_some() && rfq.facilitator == quote.facilitator {
            let fee_amount_u128 = settlement.fee_amount as u128;
            let bps_u128 = facilitator_fee_bps as u128;
            fee_amount_u128
                .checked_mul(bps_u128)
                .and_then(|v| v.checked_div(10_000))
                .and_then(|v| u64::try_from(v).ok())
                .ok_or(RfqError::ArithmeticOverflow)?
        } else {
            0
        };
    let treasury_share = settlement
        .fee_amount
        .checked_sub(facilitator_share)
        .ok_or(RfqError::ArithmeticOverflow)?;

    if treasury_share > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.taker_payment_account.to_account_info(),
                    to: ctx.accounts.treasury_ata.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                },
            ),
            treasury_share,
        )?;
    }
    if facilitator_share > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.taker_payment_account.to_account_info(),
                    to: ctx.accounts.bonds_fees_vault.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                },
            ),
            facilitator_share,
        )?;
    }

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

    let mut slashed_bonds_tracker: Account<'info, SlashedBondsTracker> =
        Account::try_from(slashed_ai)?;
    require_eq!(
        slashed_bonds_tracker_bump,
        slashed_bonds_tracker.bump,
        RfqError::BumpMismatch
    );

    if !slashed_bonds_tracker.is_resolved() {
        // Seize only unrevealed bonds and send them to the treasury
        let seized_amount = compute_slashed_amount(rfq, false)?;

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

        slashed_bonds_tracker.amount = Some(seized_amount);
        slashed_bonds_tracker.seized_at = Some(now);
        slashed_bonds_tracker.exit(ctx.program_id)?; // persist modifications
    }

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
    fees_tracker.usdc_mint = rfq.usdc_mint;
    fees_tracker.treasury_usdc_owner = rfq.treasury_usdc_owner;
    fees_tracker.amount = treasury_share;
    fees_tracker.payed_at = now;
    fees_tracker.bump = ctx.bumps.fees_tracker;

    quote.bonds_refunded_at = Some(now);
    quote.exit(ctx.program_id)?; // persist modifications

    Ok(())
}
