use anchor_lang::prelude::*;

declare_id!("E2amAUcnxFqJPbekUWPEAYkdahFPAnWoCFwaz2bryUJF");

#[program]
pub mod settlement_engine {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
