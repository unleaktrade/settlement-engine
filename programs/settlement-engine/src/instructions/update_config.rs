use crate::state::config::Config;
use crate::RfqError;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
        has_one = admin @ RfqError::Unauthorized,
    )]
    pub config: Account<'info, Config>,
}

pub fn update_config_handler(
    ctx: Context<UpdateConfig>,
    new_admin: Option<Pubkey>,
    new_usdc_mint: Option<Pubkey>,
    new_treasury_usdc_owner: Option<Pubkey>,
    new_liquidity_guard: Option<Pubkey>,
    new_facilitator_fee_bps: Option<u16>,
) -> Result<()> {
    let cfg = &mut ctx.accounts.config;

    if let Some(v) = new_admin {
        cfg.admin = v;
    }
    if let Some(v) = new_usdc_mint {
        cfg.usdc_mint = v;
    }
    if let Some(v) = new_treasury_usdc_owner {
        cfg.treasury_usdc_owner = v;
    }
    if let Some(v) = new_liquidity_guard {
        cfg.liquidity_guard = v;
    }
    if let Some(v) = new_facilitator_fee_bps {
        require!(v <= 10_000, RfqError::InvalidFeeAmount);
        cfg.facilitator_fee_bps = v;
    }

    Ok(())
}
