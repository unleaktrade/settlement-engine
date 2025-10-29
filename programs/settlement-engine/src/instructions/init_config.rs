use anchor_lang::prelude::*;

use crate::state::config::Config;
use crate::EngineError;

#[derive(Accounts)]
pub struct InitConfig<'info> {
    /// Payer for account creation
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: The desired admin authority (can be signer == admin or a multisig later)
    pub admin: UncheckedAccount<'info>,

    /// Global Config PDA
    #[account(
init,
payer = payer,
space = 8 + Config::INIT_SPACE,
seeds = [Config::SEED_PREFIX],
bump,
)]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitConfig>,
    usdc_mint: Pubkey,
    treasury_usdc_owner: Pubkey,
) -> Result<()> {
    let bump = *ctx
        .bumps
        .get("config")
        .ok_or(EngineError::ConfigAlreadyInitialized)?;
    let cfg = &mut ctx.accounts.config;

    cfg.admin = ctx.accounts.admin.key();
    cfg.usdc_mint = usdc_mint;
    cfg.treasury_usdc_owner = treasury_usdc_owner;
    cfg.bump = bump;

    Ok(())
}
