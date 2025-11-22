use anchor_lang::prelude::*;

#[error_code]
pub enum EngineError {
    #[msg("Unauthorized: only admin can perform this action")]
    Unauthorized,
}

#[error_code]
pub enum QuoteError {
    #[msg("Commit Deadline passed")]
    CommitTooLate,
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
}
