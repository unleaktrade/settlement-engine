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
    #[msg("Unauthorized caller for this action")] 
    Unauthorized,
    #[msg("RFQ already has a selected quote")] 
    AlreadySelected,
    #[msg("No quote selected")] 
    NoSelection,
    #[msg("Nothing to close or claim")] 
    NothingToClose,
}