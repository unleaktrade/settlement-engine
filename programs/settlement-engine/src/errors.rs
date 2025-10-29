use anchor_lang::prelude::*;

#[error_code]
pub enum EngineError {
    #[msg("Config already initialized")]
    ConfigAlreadyInitialized,

    #[msg("Unauthorized: only admin can perform this action")]
    Unauthorized,
}
