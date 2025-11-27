use anchor_lang::prelude::*;

#[error_code]
pub enum EngineError {
    #[msg("Unauthorized: only admin can perform this action")]
    Unauthorized,
}

#[error_code]
pub enum RfqError {
    #[msg("Invalid RFQ state for this instruction")]
    InvalidState,
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
    #[msg("Maker payment ATA is frozen or closed")]
    MakerPaymentAtaClosed,
}
