use anchor_lang::prelude::*;

pub mod errors;
pub mod state;
pub mod instructions;

pub use errors::*;

use instructions::{
    init_config::*,
    update_config::*,
    close_config::*,
};

// Program ID
declare_id!("E2amAUcnxFqJPbekUWPEAYkdahFPAnWoCFwaz2bryUJF");

#[program]
pub mod settlement_engine {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>, usdc_mint: Pubkey, treasury_usdc_owner: Pubkey) -> Result<()> {
        init_config::handler(ctx, usdc_mint, treasury_usdc_owner)
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_admin: Option<Pubkey>,
        new_usdc_mint: Option<Pubkey>,
        new_treasury_usdc_owner: Option<Pubkey>,
    ) -> Result<()> {
        update_config::handler(ctx, new_admin, new_usdc_mint, new_treasury_usdc_owner)
    }

    pub fn close_config(ctx: Context<CloseConfig>) -> Result<()> {
        close_config::handler(ctx)
    }
}