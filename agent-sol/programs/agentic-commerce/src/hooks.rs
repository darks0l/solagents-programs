use anchor_lang::prelude::*;
use crate::state::ActionKind;

/// Hook interface — CPI to an external program for before/after callbacks.
///
/// When hook is Pubkey::default(), all calls are no-ops.
/// Full CPI implementation is added in v2 once base program is deployed.

pub fn invoke_before_hook<'a, 'b, 'c, 'd>(
    hook_program: &AccountInfo<'a>,
    _job_account: &AccountInfo<'a>,
    _caller: &AccountInfo<'a>,
    job_id: u64,
    action: ActionKind,
    _data: &[u8],
    _remaining_accounts: &'b [AccountInfo<'a>],
) -> Result<()> {
    if hook_program.key() == Pubkey::default() {
        return Ok(());
    }
    msg!("Hook before: job_id={}, action={:?}", job_id, action as u8);
    // Full CPI implementation: v2
    Ok(())
}

pub fn invoke_after_hook<'a, 'b, 'c, 'd>(
    hook_program: &AccountInfo<'a>,
    _job_account: &AccountInfo<'a>,
    _caller: &AccountInfo<'a>,
    job_id: u64,
    action: ActionKind,
    _data: &[u8],
    _remaining_accounts: &'b [AccountInfo<'a>],
) -> Result<()> {
    if hook_program.key() == Pubkey::default() {
        return Ok(());
    }
    msg!("Hook after: job_id={}, action={:?}", job_id, action as u8);
    // Full CPI implementation: v2
    Ok(())
}
