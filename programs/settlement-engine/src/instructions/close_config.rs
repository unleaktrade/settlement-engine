use anchor_lang::prelude::*;

use crate::state::config::Config;
use crate::EngineError;

#[derive(Accounts)]
pub struct CloseConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        close = admin,                    // rent refund to admin
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
        has_one = admin @ EngineError::Unauthorized,
    )]
    pub config: Account<'info, Config>,
}

pub fn close_config_handler(_ctx: Context<CloseConfig>) -> Result<()> {
    Ok(())
}
