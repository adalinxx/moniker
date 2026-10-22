//! Transaction-scope validity policy for Moniker, the names chain.
//!
//! An account owns names, and points each at an account, any account. Keys:
//!
//! - `user/<account>/...`: the account's own records. The account must sign,
//!   and may create, overwrite or delete them. `user/<account>/name` is the
//!   handle the account shows: apps show `@<handle>` for an account only
//!   while it names the handle and the handle points at it.
//! - `name/<handle>`: a name, a token held by an account (see the rules
//!   crate's `tokens`): `<owner>`, `<owner>@<price>` or `<owner>><account>`.
//!   Its owner may also release it. A handle is lowercase letters, digits and
//!   `_`.
//! - `names/<account>/<handle>`: `1` while the account owns the name, so an
//!   account's names list by prefix. It moves only with its name.
//! - `points/<handle>`: the account the name points at. Only the name's
//!   owner writes it.
//!
//! The policy reads the actions once, in order, so it costs what the
//! transaction's bytes do. A name is followed directly by the index keys it
//! moves, then by its pointer. A seller's purchases come one after another,
//! and sellers are credited in the order they are first paid.
//!
//! Coin actions pass untouched.
#![cfg_attr(not(test), no_std)]

use lattice_policy_rules::tokens::{Held, Tokens};
use lattice_policy_rules::{is_address, transaction_body, Action, Body};

lattice_policy_rules::lattice_policy_abi!(crate::validate);

/// The verdict for one policy context, with `scratch` for the signer table.
/// Anything malformed is a rejection.
pub fn validate(context: &[u8], scratch: &mut [u32]) -> bool {
    transaction_body(context).and_then(|body| check_body(body, scratch)).is_some()
}

fn check_body(bytes: &[u8], scratch: &mut [u32]) -> Option<()> {
    let body = Body::parse(bytes)?;
    let signers = body.signers(scratch)?;
    let mut walk = Walk { tokens: Tokens::new(&signers, body.payments()?), name: None };
    for action in body.actions()? {
        walk.step(&action?)?;
    }
    walk.tokens.finish()
}

/// The name just written: held after the transaction, or released by its
/// owner, who may then only delete its pointer.
#[derive(Clone, Copy)]
enum Named<'a> {
    Held(Held<'a>),
    Released(&'a [u8]),
}

/// What the walk keeps from the actions read so far.
struct Walk<'a, 'b> {
    tokens: Tokens<'a, 'b>,
    /// The name just written, while its index keys and pointer follow.
    name: Option<Named<'a>>,
}

impl<'a> Walk<'a, '_> {
    fn step(&mut self, action: &Action<'a>) -> Option<()> {
        let key = Key::parse(action.key)?;
        if self.tokens.due() {
            let Key::Names(account, handle) = key else { return None };
            return self.tokens.index(account, handle, action);
        }
        if let Key::Points(handle) = key {
            // Only the name's owner points it, right after it; a released
            // name's pointer is only deleted, by the owner who released it.
            return match (self.name?, action.old_value, action.new_value) {
                (Named::Held(name), _, Some(account)) if name.id == handle && name.signs => is_address(account).then_some(()),
                (Named::Held(name), Some(_), None) if name.id == handle && name.signs => Some(()),
                (Named::Released(id), Some(_), None) if id == handle => Some(()),
                _ => None,
            };
        }
        self.name = None;
        match key {
            Key::Own(account) => self.tokens.signs(account).then_some(()),
            Key::Name(handle) => {
                let held = self.tokens.write(action, handle, true)?;
                self.name = Some(held.map_or(Named::Released(handle), Named::Held));
                Some(())
            }
            // Index keys come only where a name's move calls for them.
            Key::Names(..) | Key::Points(..) => None,
        }
    }
}

/// What a key is, by shape. Anything else is a rejection.
enum Key<'a> {
    Own(&'a [u8]),
    Name(&'a [u8]),
    Points(&'a [u8]),
    Names(&'a [u8], &'a [u8]),
}

impl<'a> Key<'a> {
    fn parse(key: &'a [u8]) -> Option<Self> {
        let (kind, rest) = split(key)?;
        match kind {
            b"user" => Some(Key::Own(split(rest).map_or(rest, |(account, _)| account))),
            b"name" => is_handle(rest).then_some(Key::Name(rest)),
            b"points" => is_handle(rest).then_some(Key::Points(rest)),
            b"names" => {
                let (account, handle) = split(rest)?;
                (is_address(account) && is_handle(handle)).then_some(Key::Names(account, handle))
            }
            _ => None,
        }
    }
}

/// A handle: lowercase letters, digits and `_`.
fn is_handle(text: &[u8]) -> bool {
    !text.is_empty() && text.iter().all(|&byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

/// `key` split at its first `/`.
fn split(key: &[u8]) -> Option<(&[u8], &[u8])> {
    let at = key.iter().position(|&byte| byte == b'/')?;
    Some((&key[..at], &key[at + 1..]))
}
