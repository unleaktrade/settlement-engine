use crate::state::rfq::{Rfq, RfqState};
use crate::state::Settlement;
use crate::state::{Config, Quote};
use crate::RfqError;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

#[derive(Accounts)]
pub struct SelectQuote<'info> {
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
    )]
    pub rfq: Box<Account<'info, Rfq>>,

    #[account(
        mut,
        seeds = [Quote::SEED_PREFIX, rfq.key().as_ref(), quote.taker.as_ref()],
        bump = quote.bump,
    )]
    pub quote: Box<Account<'info, Quote>>,

    #[account(
        init,
        payer = maker,
        space = 8 + Settlement::INIT_SPACE,
        seeds = [Settlement::SEED_PREFIX, rfq.key().as_ref()],
        bump,
    )]
    pub settlement: Account<'info, Settlement>,

    #[account()]
    pub quote_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = maker,
        associated_token::mint = quote_mint,
        associated_token::authority = maker,
    )]
    pub maker_quote_account: Account<'info, TokenAccount>,

    #[account()]
    pub base_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = maker,
        associated_token::mint = base_mint,
        associated_token::authority = rfq,
    )]
    pub vault_base_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = base_mint,
        token::authority = maker,
    )]
    pub maker_base_account: Box<Account<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn select_quote_handler(ctx: Context<SelectQuote>) -> Result<()> {
    let rfq = &mut ctx.accounts.rfq;
    let quote = &mut ctx.accounts.quote;
    let settlement = &mut ctx.accounts.settlement;
    let maker = &ctx.accounts.maker;
    let maker_base_account = &ctx.accounts.maker_base_account;
    let base_mint = &ctx.accounts.base_mint;
    let quote_mint = &ctx.accounts.quote_mint;

    // let (expected_rfq, _) = Pubkey::find_program_address(
    //     &[Rfq::SEED_PREFIX, maker.key().as_ref(), rfq.uuid.as_ref()],
    //     ctx.program_id,
    // );

    // require_keys_eq!(rfq.key(), expected_rfq, RfqError::InvalidRfqPda);

    let now = Clock::get()?.unix_timestamp;
    match (rfq.reveal_deadline(), rfq.selection_deadline()) {
        (Some(reveal_deadline), Some(selection_deadline)) => {
            require!(now > reveal_deadline, RfqError::SelectionTooEarly);
            require!(now <= selection_deadline, RfqError::SelectionTooLate);
        }
        _ => return err!(RfqError::InvalidRfqState),
    }

    require!(quote.rfq == rfq.key(), RfqError::InvalidRfqAssociation);
    require!(quote.is_revealed(), RfqError::InvalidQuoteState);
    require!(!quote.selected, RfqError::InvalidQuoteState);

    require!(
        matches!(rfq.state, RfqState::Revealed),
        RfqError::InvalidRfqState
    );
    require!(!rfq.has_selection(), RfqError::AlreadySelected);

    require!(
        !maker_base_account.is_frozen(),
        RfqError::MakerBaseAccountClosed
    );

    require!(base_mint.key() == rfq.base_mint, RfqError::InvalidBaseMint);
    require!(
        quote_mint.key() == rfq.quote_mint,
        RfqError::InvalidQuoteMint
    );

    // Transfert base tokens from maker to RFQ vault
    let cpi_accounts = Transfer {
        from: ctx.accounts.maker_base_account.to_account_info(),
        to: ctx.accounts.vault_base_ata.to_account_info(),
        authority: ctx.accounts.maker.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    token::transfer(cpi_ctx, rfq.base_amount)?;

    // update rfq
    rfq.state = RfqState::Selected;
    rfq.selected_at = Some(now);
    rfq.selected_quote = Some(quote.key());
    rfq.settlement = Some(settlement.key());

    // fill settlement
    settlement.rfq = rfq.key();
    settlement.quote = quote.key();
    settlement.maker = maker.key();
    settlement.taker = quote.taker;
    settlement.base_mint = rfq.base_mint;
    settlement.quote_mint = rfq.quote_mint;
    settlement.base_amount = rfq.base_amount;
    settlement.quote_amount = quote
        .quote_amount
        .ok_or_else(|| RfqError::InvalidQuoteState)?;
    settlement.bond_amount = rfq.bond_amount;
    settlement.fee_amount = rfq.fee_amount;
    settlement.created_at = now;
    settlement.completed_at = None;
    settlement.maker_funded_at = Some(now);
    settlement.taker_funded_at = None;
    settlement.bump = ctx.bumps.settlement;
    settlement.maker_payment_account = rfq.maker_payment_account;
    settlement.taker_payment_account = quote.taker_payment_account;
    settlement.bonds_fees_vault = rfq.bonds_fees_vault;
    settlement.maker_base_account = maker_base_account.key();
    settlement.taker_base_account = None;
    settlement.vault_base_ata = ctx.accounts.vault_base_ata.key();
    settlement.maker_quote_account = ctx.accounts.maker_quote_account.key();
    settlement.taker_quote_account = None;

    //update quote
    quote.selected = true;

    Ok(())
}
