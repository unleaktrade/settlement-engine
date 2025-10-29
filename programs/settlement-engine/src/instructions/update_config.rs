use anchor_lang::prelude::*;

use crate::state::config::Config;
use crate::EngineError;

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    /// Admin must sign
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
        has_one = admin @ EngineError::Unauthorized,
    )]
    pub config: Account<'info, Config>,
}

/// Partial update pattern: pass Option<Pubkey> for fields you might change.
pub fn handler(
    ctx: Context<UpdateConfig>,
    new_admin: Option<Pubkey>,
    new_usdc_mint: Option<Pubkey>,
    new_treasury_usdc_owner: Option<Pubkey>,
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

    Ok(())
}
