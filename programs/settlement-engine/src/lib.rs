use anchor_lang::prelude::*;

declare_id!("E2amAUcnxFqJPbekUWPEAYkdahFPAnWoCFwaz2bryUJF");

#[program]
pub mod settlement_engine {
    use super::*;

    pub fn initialize_rfq(ctx: Context<InitializeRfq>, uuid: [u8; 16]) -> Result<()> {
        let rfq = &mut ctx.accounts.rfq;
        rfq.owner = ctx.accounts.signer.key();
        rfq.uuid = uuid;
        rfq.created_at = Clock::get()?.unix_timestamp;
        rfq.bump = ctx.bumps.rfq;
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Rfq {
    pub owner: Pubkey,    // 32
    pub uuid: [u8; 16],   // 16
    pub created_at: i64,  // 8
    pub bump: u8,         // 1
    // total data = 57; Anchor adds 8-byte discriminator
}

#[derive(Accounts)]
#[instruction(uuid: [u8; 16])]
pub struct InitializeRfq<'info> {
    #[account(
        init,
        payer = signer,
        space = 8 + Rfq::INIT_SPACE,
        seeds = [b"rfq", signer.key().as_ref(), uuid.as_ref()],
        bump
    )]
    pub rfq: Account<'info, Rfq>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}
