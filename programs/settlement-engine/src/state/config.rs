use anchor_lang::prelude::*;

/// Global, singleton configuration for the deployment.
/// PDA: seeds = ["config"], bump stored for signer seeds.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,               // admin authority
    pub usdc_mint: Pubkey,           // USDC mint for fees/bonds
    pub treasury_usdc_owner: Pubkey, // treasury USDC owner
    pub bump: u8,                    // PDA bump
}

impl Config {
    pub const SEED_PREFIX: &'static [u8] = b"config";
}
