use crate::rfq_errors::RfqError;
use crate::state::rfq::Rfq;
use anchor_lang::prelude::*;

// Computes total slashed bonds for an RFQ.
// Base slashing = (committed_count - revealed_count) * bond_amount.
// include_actor_bond adds the extra bond (maker or selected taker) when required by the flow.
pub fn compute_slashed_amount(rfq: &Rfq, include_actor_bond: bool) -> Result<u64> {
    // committed/revealed are u16 in state; widen for arithmetic safety.
    let committed = u64::from(rfq.committed_count);
    let revealed = u64::from(rfq.revealed_count);
    // base = unrevealed commits
    let base = committed
        .checked_sub(revealed)
        .ok_or_else(|| error!(RfqError::ArithmeticOverflow))?;
    // some flows add the maker/selected-taker bond to the slash total
    let total = if include_actor_bond {
        base.checked_add(1)
            .ok_or_else(|| error!(RfqError::ArithmeticOverflow))?
    } else {
        base
    };
    // multiply by bond_amount to get final USDC slash
    total
        .checked_mul(rfq.bond_amount)
        .ok_or_else(|| error!(RfqError::ArithmeticOverflow))
}
