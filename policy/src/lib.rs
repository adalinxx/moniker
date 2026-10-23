//! Transaction-scope validity policy for Moniker, the profile chain.
//!
//! Two shapes of key:
//!
//! - `user/<owner>/...`: the owner's own profile records. The owner must sign,
//!   and may create, overwrite or delete them.
//! - `name/<handle>`: a handle, held as a token (see `lattice-policy-rules`):
//!   `<holder>` or `<holder>@<price>`. Whoever claims a free handle holds it.
//!   The holder may transfer it, price it, take it off sale or release it, and
//!   anyone may take a priced handle by paying the holder at least the price in
//!   the same transaction. A handle is lowercase letters, digits and `_`, and
//!   its holder is always a well-formed address.
//!
//! What the records mean is up to clients. Coin actions pass untouched.
//!
//! A transaction has at most `MAX_ACTIONS` actions, `MAX_HANDLE_ACTIONS` of
//! them on handles, and `MAX_SIGNERS` signers. The node does not meter policy
//! time, and checking payments takes time in handle actions times actions
//! times signers, so without these one transaction could hold up every
//! validator for minutes.
//!
//! A key is at most `MAX_KEY_BYTES` and a value written at most
//! `MAX_VALUE_BYTES`, so writes, which may be free, cannot fill the state
//! that every node keeps. A transaction claims at most one free handle, so a
//! claim of many names takes as many transactions.
#![cfg_attr(not(test), no_std)]

use lattice_policy_rules::{holding, is_address, transaction_body, Action, Body};

lattice_policy_rules::lattice_policy_abi!(crate::validate);

pub const MAX_ACTIONS: usize = 256;
pub const MAX_HANDLE_ACTIONS: usize = 16;
pub const MAX_SIGNERS: u64 = 8;
pub const MAX_KEY_BYTES: usize = 512;
pub const MAX_VALUE_BYTES: usize = 16 * 1024;
pub const MAX_CLAIMS: usize = 1;

/// The verdict for one policy context. Anything malformed is a rejection.
pub fn validate(context: &[u8]) -> bool {
    transaction_body(context).and_then(check_body).is_some()
}

fn check_body(bytes: &[u8]) -> Option<()> {
    let body = Body::parse(bytes)?;
    if body.signer_count()? > MAX_SIGNERS {
        return None;
    }
    let (mut handle_actions, mut claims) = (0, 0);
    for (index, action) in body.actions()?.enumerate() {
        let action = action?;
        if index >= MAX_ACTIONS || action.key.len() > MAX_KEY_BYTES {
            return None;
        }
        if action.new_value.is_some_and(|value| value.len() > MAX_VALUE_BYTES) {
            return None;
        }
        if is_handle_key(action.key) {
            handle_actions += 1;
            claims += (action.old_value.is_none() && action.new_value.is_some()) as usize;
            if handle_actions > MAX_HANDLE_ACTIONS || claims > MAX_CLAIMS {
                return None;
            }
            check_handle(&body, &action)?;
        } else {
            check_owned(&body, &action)?;
        }
    }
    body.check_payments(is_handle_key)
}

fn check_owned(body: &Body, action: &Action) -> Option<()> {
    let mut segments = action.key.split(|&byte| byte == b'/');
    if segments.next()? != b"user" {
        return None;
    }
    body.is_signer(segments.next()?)
}

fn check_handle(body: &Body, action: &Action) -> Option<()> {
    let handle = &action.key[b"name/".len()..];
    if handle.is_empty() || !handle.iter().all(|&byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_')) {
        return None;
    }
    let Some(new_value) = action.new_value else {
        // Released: only by its holder.
        return body.is_signer(holding(action.old_value?)?.0);
    };
    if !is_address(holding(new_value)?.0) {
        return None;
    }
    body.check_token_write(action, |holder| body.is_signer(holder))
}

fn is_handle_key(key: &[u8]) -> bool {
    key.starts_with(b"name/")
}
