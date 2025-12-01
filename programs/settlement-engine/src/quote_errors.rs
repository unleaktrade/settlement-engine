use anchor_lang::prelude::*;

#[error_code]
pub enum QuoteError {
    #[msg("Commit Deadline passed")]
    CommitTooLate,
    #[msg("Reveal Deadline passed")]
    RevealTooLate,
    #[msg("Reveal attempted too early")]
    RevealTooEarly,
    #[msg("No Ed25519 instruction found")]
    NoEd25519Instruction,
    #[msg("Invalid Ed25519 program ID")]
    InvalidEd25519Program,
    #[msg("Invalid Ed25519 instruction data")]
    InvalidEd25519Data,
    #[msg("Invalid signature count")]
    InvalidSignatureCount,
    #[msg("Invalid offset - security check failed")]
    InvalidOffset,
    #[msg("Invalid message size")]
    InvalidMessageSize,
    #[msg("Unauthorized liquidity guard signer - not the expected public key")]
    UnauthorizedSigner,
    #[msg("Commit hash mismatch")]
    CommitHashMismatch,
    #[msg("Liquidity proof signature mismatch")]
    LiquidityProofSignatureMismatch,
    #[msg("Quote amount is invalid (too low)")]
    InvalidQuoteAmount,
    #[msg("Quote has already been revealed")]
    QuoteAlreadyRevealed,
    #[msg("Invalid QUOTE state for this instruction")]
    InvalidState,
    #[msg("Taker payment account is frozen or closed")]
    TakerPaymentAccountClosed,
    #[msg("Quote does not belong to the expected RFQ")]
    InvalidRfqAssociation,
}
