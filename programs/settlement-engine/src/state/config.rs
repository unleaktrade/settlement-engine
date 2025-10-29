use anchor_lang::prelude::*;
use anchor_lang::space::InitSpace;

/// Global, singleton configuration for the deployment.
/// PDA: seeds = ["config"], bump stored for signer seeds.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Admin authority for config updates & privileged ops
    pub admin: Pubkey,                // 32
    /// USDC mint for all bonds/fees (Token-2022 not assumed)
    pub usdc_mint: Pubkey,            // 32
    /// Treasury owner (USDC ATA recipient for fees / slashed bonds)
    pub treasury_usdc_owner: Pubkey,  // 32
    /// PDA bump (for CPIs that need signer seeds)
    pub bump: u8,                     // 1
}

impl Config {
    pub const SEED_PREFIX: &'static [u8] = b"config";
}