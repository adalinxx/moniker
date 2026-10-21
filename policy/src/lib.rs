//! Transaction-scope validity policy for Moniker, the profile chain.
//!
//! An account (a key) owns profiles; a profile holds names. Keys:
//!
//! - `user/<account>/...`: the account's own records. The account must sign,
//!   and may create, overwrite or delete them.
//! - `profile/<p>`: a profile, held as a token: `<owner>`, `<owner>@<price>`
//!   or `<owner>><account>`, the owner an account. `<p>` is 16 characters of
//!   `a`–`z` and `2`–`7`. Whoever creates a free id owns it; the owner may
//!   transfer it, price it, offer it to one account or take it back, and
//!   anyone may take a priced profile by paying the owner the price in the
//!   same transaction, as the account it is offered to may take it for
//!   nothing. A profile is never deleted.
//! - `profile/<p>/<field>...`: the profile's records (its card, the name it
//!   shows, its admins, any app's fields). Only its owner writes them.
//! - `name/<handle>`: a name, held as a token by a profile: `<p>`,
//!   `<p>@<price>` or `<p>><profile>`. The holding profile's owner may move
//!   it to another profile, price it, offer it to one profile, take it back or
//!   release it; anyone may take a priced name by paying that owner the price
//!   in the same transaction, and the owner of the profile it is offered to
//!   may take it for nothing. A handle is lowercase letters, digits and `_`.
//! - `owns/<account>/<p>` and `holds/<p>/<handle>`: `1` while the account owns
//!   the profile, or the profile holds the name, so either lists by prefix. A
//!   transaction that moves the token moves its key; these keys change in no
//!   other way. The chain starts with neither, so the two always agree.
//!
//! The policy sees only the transaction, not the chain's state, so a
//! transaction acting for profile `<p>` also writes `profile/<p>`, if need be
//! rewritten to the value it has. Consensus checks every old value against
//! the chain, so that action says who owns `<p>`; the owner after the
//! transaction must sign. Anyone may write a profile or a name unchanged.
//!
//! Nothing is put on an account or a profile without its owner's signature:
//! a profile's new owner signs, and so does the owner of a name's new profile.
//!
//! What the records mean is up to clients. Coin actions pass untouched.
#![cfg_attr(not(test), no_std)]

use lattice_policy_rules::{decimal, is_address, transaction_body, Action, Body};

/// What a token's holder asks of anyone else who would take it.
#[derive(Clone, Copy, PartialEq)]
enum Terms<'a> {
    /// Not for anyone else.
    Kept,
    /// For anyone, at this price, paid to the owner.
    Price(u64),
    /// For this one taker, for nothing.
    Offer(&'a [u8]),
}

lattice_policy_rules::lattice_policy_abi!(crate::validate);

/// The verdict for one policy context. Anything malformed is a rejection.
pub fn validate(context: &[u8]) -> bool {
    transaction_body(context).and_then(check_body).is_some()
}

fn check_body(bytes: &[u8]) -> Option<()> {
    let body = Body::parse(bytes)?;
    for action in body.actions()? {
        let action = action?;
        match Key::parse(action.key)? {
            Key::Own(account) => body.is_signer(account)?,
            Key::Profile(p) => check_profile(&body, &action, p)?,
            Key::ProfileField(p, field) => check_field(&body, &action, p, field)?,
            Key::Name(handle) => check_name(&body, &action, handle)?,
            Key::Owns(account, p) => check_index(&body, &action, b"profile/", p, account)?,
            Key::Holds(p, handle) => check_index(&body, &action, b"name/", handle, p)?,
        }
    }
    body.check_purchases(|action| purchase(&body, action))
}

/// What a key is, by shape. Anything else is a rejection.
enum Key<'a> {
    Own(&'a [u8]),
    Profile(&'a [u8]),
    ProfileField(&'a [u8], &'a [u8]),
    Name(&'a [u8]),
    Owns(&'a [u8], &'a [u8]),
    Holds(&'a [u8], &'a [u8]),
}

impl<'a> Key<'a> {
    fn parse(key: &'a [u8]) -> Option<Self> {
        let (kind, rest) = split(key)?;
        match kind {
            b"user" => Some(Key::Own(split(rest).map_or(rest, |(account, _)| account))),
            b"profile" => match split(rest) {
                Some((p, field)) if is_profile(p) && !field.is_empty() => Some(Key::ProfileField(p, field)),
                Some(_) => None,
                None => is_profile(rest).then_some(Key::Profile(rest)),
            },
            b"name" => is_handle(rest).then_some(Key::Name(rest)),
            b"owns" => {
                let (account, p) = split(rest)?;
                (is_address(account) && is_profile(p)).then_some(Key::Owns(account, p))
            }
            b"holds" => {
                let (p, handle) = split(rest)?;
                (is_profile(p) && is_handle(handle)).then_some(Key::Holds(p, handle))
            }
            _ => None,
        }
    }
}

/// `key` split at its first `/`.
fn split(key: &[u8]) -> Option<(&[u8], &[u8])> {
    let at = key.iter().position(|&byte| byte == b'/')?;
    Some((&key[..at], &key[at + 1..]))
}

/// A profile id: 16 characters of the base32 alphabet.
fn is_profile(text: &[u8]) -> bool {
    text.len() == 16 && text.iter().all(|&byte| matches!(byte, b'a'..=b'z' | b'2'..=b'7'))
}

/// A handle: lowercase letters, digits and `_`.
fn is_handle(text: &[u8]) -> bool {
    !text.is_empty() && text.iter().all(|&byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

/// A token value, `<holder>`, `<holder>@<price>` or `<holder>><taker>`, whose
/// holder and taker pass `valid`.
fn token(value: &[u8], valid: fn(&[u8]) -> bool) -> Option<(&[u8], Terms<'_>)> {
    let Some(at) = value.iter().position(|&byte| byte == b'@' || byte == b'>') else {
        return valid(value).then_some((value, Terms::Kept));
    };
    let (holder, rest) = (&value[..at], &value[at + 1..]);
    if !valid(holder) {
        return None;
    }
    if value[at] == b'@' {
        return Some((holder, Terms::Price(decimal(rest)?)));
    }
    (valid(rest) && rest != holder).then_some((holder, Terms::Offer(rest)))
}

/// The holder before and after a token write; an absent value has none.
fn holders<'a>(action: &Action<'a>, valid: fn(&[u8]) -> bool) -> Option<(Option<&'a [u8]>, Option<&'a [u8]>)> {
    let holder = |value: Option<&'a [u8]>| -> Option<Option<&'a [u8]>> {
        match value {
            None => Some(None),
            Some(value) => Some(Some(token(value, valid)?.0)),
        }
    };
    Some((holder(action.old_value)?, holder(action.new_value)?))
}

/// The transaction's write to `<prefix><id>`, if any.
fn write_to<'a>(body: &Body<'a>, prefix: &[u8], id: &[u8]) -> Option<Option<Action<'a>>> {
    for action in body.actions()? {
        let action = action?;
        if action.key.strip_prefix(prefix) == Some(id) {
            return Some(Some(action));
        }
    }
    Some(None)
}

/// The owner of profile `p` after this transaction, from its write to
/// `profile/<p>`; a transaction acting for `p`, or buying from it, carries one.
/// A profile that changes owner is signed for by its new owner, so a buyer
/// pays the owner it had.
fn owner<'a>(body: &Body<'a>, p: &[u8]) -> Option<&'a [u8]> {
    let action = write_to(body, b"profile/", p)??;
    holders(&action, is_address)?.1
}

/// The owner of profile `p` signs this transaction.
fn acts_for(body: &Body, p: &[u8]) -> Option<()> {
    body.is_signer(owner(body, p)?)
}

fn check_profile(body: &Body, action: &Action, p: &[u8]) -> Option<()> {
    let new_value = action.new_value?;
    let (new_owner, _) = token(new_value, is_address)?;
    let Some(old_value) = action.old_value else {
        // A new profile: its owner creates it.
        body.is_signer(new_owner)?;
        return moved(body, b"owns/", p, None, Some(new_owner));
    };
    if old_value == new_value {
        return Some(());
    }
    // The owner changes it at will; anyone else only buys it (`purchase`).
    let (owner, _) = token(old_value, is_address)?;
    if owner != new_owner {
        // Nobody is given a profile without signing for it.
        body.is_signer(new_owner)?;
    }
    moved(body, b"owns/", p, Some(owner), Some(new_owner))
}

fn check_field(body: &Body, action: &Action, p: &[u8], field: &[u8]) -> Option<()> {
    acts_for(body, p)?;
    if field == b"name" {
        // The name a profile shows is one it holds.
        if let Some(handle) = action.new_value {
            let held = write_to(body, b"name/", handle)??;
            if holders(&held, is_profile)?.1 != Some(p) {
                return None;
            }
        }
    }
    Some(())
}

fn check_name(body: &Body, action: &Action, handle: &[u8]) -> Option<()> {
    if action.old_value.is_some() && action.old_value == action.new_value {
        token(action.new_value?, is_profile)?;
        return Some(());
    }
    let (old, new) = holders(action, is_profile)?;
    if let Some(new) = new {
        if old != Some(new) {
            // Nothing is put on a profile without its owner signing for it.
            acts_for(body, new)?;
        }
    }
    // Its profile's owner changes it at will; anyone else only buys it
    // (`purchase`), onto a profile. A free name is claimed onto a profile.
    match old {
        Some(old) if acts_for(body, old).is_some() => {}
        _ => {
            new?;
        }
    }
    moved(body, b"holds/", handle, old, new)
}

/// A token at `<id>` that changes holder from `from` to `to` moves its index
/// key under `index` (`owns/<holder>/<id>` or `holds/<holder>/<id>`).
fn moved(body: &Body, index: &[u8], id: &[u8], from: Option<&[u8]>, to: Option<&[u8]>) -> Option<()> {
    if from == to {
        return Some(());
    }
    let has = |holder: &[u8], created: bool| -> Option<()> {
        for other in body.actions()? {
            let other = other?;
            let Some(rest) = other.key.strip_prefix(index) else { continue };
            if split(rest) == Some((holder, id)) && other.new_value.is_some() == created {
                return Some(());
            }
        }
        None
    };
    if let Some(from) = from {
        has(from, false)?;
    }
    if let Some(to) = to {
        has(to, true)?;
    }
    Some(())
}

/// An index key (`owns/<holder>/<id>`, `holds/<holder>/<id>`) is written as
/// its token reaches its holder and deleted as the token leaves: never alone.
fn check_index(body: &Body, action: &Action, token_prefix: &[u8], id: &[u8], holder: &[u8]) -> Option<()> {
    let created = match (action.old_value, action.new_value) {
        (None, Some(b"1")) => true,
        (Some(_), None) => false,
        _ => return None,
    };
    let write = write_to(body, token_prefix, id)??;
    let valid = if token_prefix == b"profile/" { is_address } else { is_profile };
    let (old, new) = holders(&write, valid)?;
    let moved = if created { new == Some(holder) && old != Some(holder) } else { old == Some(holder) && new != Some(holder) };
    moved.then_some(())
}

/// Whom `action` pays and how much, when it changes a token its signers do
/// not control: a profile's owner, or the owner of a name's profile. Such a
/// change is a purchase at the token's price, or the taking of an offer by
/// the one it is offered to, for nothing; anything else is a rejection.
fn purchase<'a>(body: &Body<'a>, action: &Action<'a>) -> Option<Option<(&'a [u8], u64)>> {
    let Some(old_value) = action.old_value.filter(|old| action.new_value != Some(*old)) else {
        return Some(None);
    };
    let (seller, terms, taker) = match Key::parse(action.key)? {
        Key::Profile(_) => {
            let (owner, terms) = token(old_value, is_address)?;
            (owner, terms, token(action.new_value?, is_address)?.0)
        }
        Key::Name(_) => {
            let (p, terms) = token(old_value, is_profile)?;
            if acts_for(body, p).is_some() {
                return Some(None);
            }
            (owner(body, p)?, terms, token(action.new_value?, is_profile)?.0)
        }
        _ => return Some(None),
    };
    if body.is_signer(seller).is_some() {
        return Some(None);
    }
    match terms {
        Terms::Price(price) => Some(Some((seller, price))),
        Terms::Offer(to) if to == taker => Some(None),
        _ => None,
    }
}
