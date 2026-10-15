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
#![cfg_attr(not(test), no_std)]

use lattice_policy_rules::{holding, is_address, transaction_body, Action, Body};

lattice_policy_rules::lattice_policy_abi!(crate::validate);

/// The verdict for one policy context. Anything malformed is a rejection.
pub fn validate(context: &[u8]) -> bool {
    transaction_body(context).and_then(check_body).is_some()
}

fn check_body(bytes: &[u8]) -> Option<()> {
    let body = Body::parse(bytes)?;
    for action in body.actions()? {
        let action = action?;
        if is_handle_key(action.key) {
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
