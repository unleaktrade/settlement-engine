use crate::state::config::Config;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct InitConfig<'info> {
    /// Admin is also the payer. This simplifies auth & testing.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// Global Config PDA
    #[account(
        init,
        payer = admin,
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
    let bump = ctx.bumps.config;
    let cfg = &mut ctx.accounts.config;

    cfg.admin = ctx.accounts.admin.key();
    cfg.usdc_mint = usdc_mint;
    cfg.treasury_usdc_owner = treasury_usdc_owner;
    cfg.bump = bump;

    Ok(())
}
