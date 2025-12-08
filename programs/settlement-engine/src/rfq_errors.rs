use anchor_lang::prelude::*;

#[error_code]
pub enum RfqError {
    #[msg("Invalid RFQ state for this instruction")]
    InvalidRfqState,
    #[msg("Deadline has not been reached yet")]
    TooEarly,
    #[msg("Deadline passed")]
    TooLate,
    #[msg("Commit Deadline passed")]
    CommitTooLate,
    #[msg("Unauthorized caller for this action")]
    Unauthorized,
    #[msg("RFQ already has a selected quote")]
    AlreadySelected,
    #[msg("No quote selected")]
    NoSelection,
    #[msg("Nothing to close or claim")]
    NothingToClose,
    #[msg("Invalid parameters")]
    InvalidParams,
    #[msg("Invalid Bond Vault account")]
    InvalidBondVault,
    #[msg("Invalid Bond Amount")]
    InvalidBondAmount,
    #[msg("Invalid Fee Amount")]
    InvalidFeeAmount,
    #[msg("Invalid Base Amount")]
    InvalidBaseAmount,
    #[msg("Invalid Min Quote Amount")]
    InvalidMinQuoteAmount,
    #[msg("Invalid TTL for Commit phase")]
    InvalidCommitTTL,
    #[msg("Invalid TTL for Reveal phase")]
    InvalidRevealTTL,
    #[msg("Invalid TTL for Selection phase")]
    InvalidSelectionTTL,
    #[msg("Invalid TTL for Funding phase")]
    InvalidFundingTTL,
    #[msg("Selection attempted too early")]
    SelectionTooEarly,
    #[msg("Selection deadline passed")]
    SelectionTooLate,
    #[msg("Maker payment account is frozen or closed")]
    MakerPaymentAccountClosed,
    #[msg("Maker base account is frozen or closed")]
    MakerBaseAccountClosed,
    #[msg("Maker payment account is not authorized for this RFQ")]
    UnauthorizedMakerPaymentAccount,
    #[msg("Base mint does not match RFQ requirement")]
    InvalidBaseMint,
    #[msg("Quote mint does not match RFQ requirement")]
    InvalidQuoteMint,
    #[msg("RFQ PDA does not match expected seeds")]
    InvalidRfqPda,
    #[msg("Funding deadline passed")]
    FundingTooLate,
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
    #[msg("Invalid config account")]
    InvalidConfig,
    #[msg("Settlement does not belong to RFQ")]
    InvalidRfq,
    #[msg("Settlement does not belong to taker")]
    InvalidTaker,
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
    InvalidQuoteState,
    #[msg("Taker payment account is frozen or closed")]
    TakerPaymentAccountClosed,
    #[msg("Quote does not belong to the expected RFQ")]
    InvalidRfqAssociation,
}
