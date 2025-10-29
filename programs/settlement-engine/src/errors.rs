use anchor_lang::prelude::*;

#[error_code]
pub enum EngineError {
    #[msg("Unauthorized: only admin can perform this action")] 
    Unauthorized,
}