//! Transaction-scope validity policy for Moniker, the profile chain.
//!
//! An account (a key) owns profiles and names. A profile is a public
//! identity; a name is an asset its owner points at any profile. Keys:
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
//! - `about/<p>/<field>...`: the profile's records (its card, its default
//!   name, its admins, any app's fields). Only its owner writes them. They
//!   sit apart from `profile/<p>`, which a transaction acting for `<p>`
//!   rewrites, so that one never writes a key and adds a key under it.
//! - `name/<handle>`: a name, held as a token by an account, on the same
//!   terms as a profile; its owner may also release it. A handle is
//!   lowercase letters, digits and `_`.
//! - `points/<handle>`: the profile the name points at, any profile; only
//!   the name's owner writes it.
//! - `owns/<account>/<p>` and `names/<account>/<handle>`: `1` while the
//!   account owns the profile or the name, so either lists by prefix. A
//!   transaction that moves the token moves its key; these keys change in no
//!   other way. The chain starts with neither, so the two always agree.
//!
//! The policy sees only the transaction, not the chain's state, so a
//! transaction acting for a profile or a name also writes its token, if need
//! be rewritten to the value it has. Consensus checks every old value against
//! the chain, so that action says who owns it; the owner after the
//! transaction must sign. Anyone may write a token unchanged.
//!
//! Nothing is put on an account without its signature: a token's new owner
//! signs.
//!
//! The policy reads the actions once, in order, so it costs what the
//! transaction's bytes do. The order:
//!
//! - A token (`profile/<p>`, `name/<handle>`) is followed directly by the
//!   index keys it moves, the one it leaves first.
//! - `about/<p>/...` comes while `profile/<p>` is the last profile written.
//! - `points/<handle>` comes directly after `name/<handle>` and its index
//!   keys.
//! - A seller's purchases come one after another, and sellers are credited in
//!   the order they are first paid: each run of purchases is paid by the
//!   seller's next credit.
//!
//! What the records mean is up to clients: a profile shows its default name
//! only while that name points at it. Coin actions pass untouched.
#![cfg_attr(not(test), no_std)]

use lattice_policy_rules::{decimal, is_address, transaction_body, Action, Body, Payments, Signers};

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

/// The verdict for one policy context, with `scratch` for the signer table.
/// Anything malformed is a rejection.
pub fn validate(context: &[u8], scratch: &mut [u32]) -> bool {
    transaction_body(context).and_then(|body| check_body(body, scratch)).is_some()
}

fn check_body(bytes: &[u8], scratch: &mut [u32]) -> Option<()> {
    let body = Body::parse(bytes)?;
    let signers = body.signers(scratch)?;
    let mut walk = Walk { signers: &signers, profile: None, name: None, expect: [None; 2], payments: body.payments()? };
    for action in body.actions()? {
        walk.step(&action?)?;
    }
    walk.expect[0].is_none().then_some(())?;
    walk.payments.finish()
}

/// A token just written: its id, its owner after the transaction, and
/// whether that owner signs.
#[derive(Clone, Copy)]
struct Held<'a> {
    id: &'a [u8],
    owner: &'a [u8],
    signs: bool,
}

/// The name just written: held after the transaction, or released by its
/// owner, who may then only delete its pointer.
#[derive(Clone, Copy)]
enum Named<'a> {
    Held(Held<'a>),
    Released(&'a [u8]),
}

/// What kind of token a write is to: a profile (never deleted) or a name.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Profile,
    Name,
}

/// An index key the action before calls for: `owns/<holder>/<id>` or
/// `names/<holder>/<id>`, written (`created`) or deleted.
#[derive(Clone, Copy, PartialEq)]
struct Index<'a> {
    kind: Kind,
    holder: &'a [u8],
    id: &'a [u8],
    created: bool,
}

/// What the walk keeps from the actions read so far.
struct Walk<'a, 'b> {
    signers: &'b Signers<'a, 'b>,
    /// The last profile written.
    profile: Option<Held<'a>>,
    /// The name just written, until an action other than its index keys.
    name: Option<Named<'a>>,
    /// The index keys still called for, the next first.
    expect: [Option<Index<'a>>; 2],
    payments: Payments<'a>,
}

impl<'a> Walk<'a, '_> {
    fn step(&mut self, action: &Action<'a>) -> Option<()> {
        let key = Key::parse(action.key)?;
        if let Some(index) = self.expect[0] {
            let (kind, holder, id) = match key {
                Key::Owns(account, p) => (Kind::Profile, account, p),
                Key::Names(account, handle) => (Kind::Name, account, handle),
                _ => return None,
            };
            let created = match (action.old_value, action.new_value) {
                (None, Some(b"1")) => true,
                (Some(_), None) => false,
                _ => return None,
            };
            (Index { kind, holder, id, created } == index).then_some(())?;
            self.expect = [self.expect[1], None];
            return Some(());
        }
        let name = self.name.take();
        match key {
            Key::Own(account) => self.signers.is_signer(account),
            Key::Profile(p) => {
                let held = self.token(action, Kind::Profile, p)?;
                self.profile = Some(held?);
                Some(())
            }
            Key::ProfileField(p) => {
                // Only the owner of the last profile written writes its records.
                let profile = self.profile.filter(|profile| profile.id == p)?;
                profile.signs.then_some(())
            }
            Key::Name(handle) => {
                let held = self.token(action, Kind::Name, handle)?;
                self.name = Some(held.map_or(Named::Released(handle), Named::Held));
                Some(())
            }
            Key::Points(handle) => {
                // Only the name's owner points it, at a profile, right after
                // it; a released name's pointer is only deleted, by the
                // owner who released it.
                match (name?, action.old_value, action.new_value) {
                    (Named::Held(name), _, Some(p)) if name.id == handle && name.signs => is_profile(p).then_some(()),
                    (Named::Held(name), Some(_), None) if name.id == handle && name.signs => Some(()),
                    (Named::Released(id), Some(_), None) if id == handle => Some(()),
                    _ => None,
                }
            }
            // Index keys come only where a token's move calls for them.
            Key::Owns(..) | Key::Names(..) => None,
        }
    }

    /// A write to token `<id>`: who holds it after, if anyone.
    fn token(&mut self, action: &Action<'a>, kind: Kind, id: &'a [u8]) -> Option<Option<Held<'a>>> {
        let old = match action.old_value {
            Some(value) => Some(token(value)?),
            None => None,
        };
        let new = match action.new_value {
            Some(value) => Some(token(value)?.0),
            None => None,
        };
        let held = new.map(|owner| Held { id, owner, signs: self.signers.is_signer(owner).is_some() });
        if old.is_some() && action.old_value == action.new_value {
            // Anyone may write a token unchanged.
            return Some(held);
        }
        let from = old.map(|(owner, _)| owner);
        match (old, held) {
            // Nothing is no write.
            (None, None) => return None,
            // A new token: its owner creates it.
            (None, Some(held)) => held.signs.then_some(())?,
            // Only a name is released, by its owner.
            (Some((owner, _)), None) => {
                (kind == Kind::Name && self.signers.is_signer(owner).is_some()).then_some(())?;
            }
            (Some((owner, terms)), Some(held)) => {
                if owner != held.owner {
                    // Nobody is given a token without signing for it.
                    held.signs.then_some(())?;
                }
                // The owner changes it at will; anyone else only takes it.
                if self.signers.is_signer(owner).is_none() {
                    (owner != held.owner).then_some(())?;
                    self.purchase(owner, terms, held.owner)?;
                }
            }
        }
        self.calls_for(kind, id, from, held.map(|held| held.owner))?;
        Some(held)
    }

    /// A token at `<id>` that moves from holder `from` to `to` calls for its
    /// index keys next: the one it leaves, then the one it reaches.
    fn calls_for(&mut self, kind: Kind, id: &'a [u8], from: Option<&'a [u8]>, to: Option<&'a [u8]>) -> Option<()> {
        if from == to {
            return Some(());
        }
        let leaves = from.map(|holder| Index { kind, holder, id, created: false });
        let reaches = to.map(|holder| Index { kind, holder, id, created: true });
        self.expect = if leaves.is_some() { [leaves, reaches] } else { [reaches, None] };
        Some(())
    }

    /// A token taken from `seller`, who does not sign: bought at its price,
    /// or taken for nothing by the one it is offered to.
    fn purchase(&mut self, seller: &'a [u8], terms: Terms<'a>, taker: &[u8]) -> Option<()> {
        match terms {
            Terms::Price(price) => self.payments.owe(seller, price),
            Terms::Offer(to) if to == taker => Some(()),
            _ => None,
        }
    }
}

/// What a key is, by shape. Anything else is a rejection.
enum Key<'a> {
    Own(&'a [u8]),
    Profile(&'a [u8]),
    ProfileField(&'a [u8]),
    Name(&'a [u8]),
    Points(&'a [u8]),
    Owns(&'a [u8], &'a [u8]),
    Names(&'a [u8], &'a [u8]),
}

impl<'a> Key<'a> {
    fn parse(key: &'a [u8]) -> Option<Self> {
        let (kind, rest) = split(key)?;
        match kind {
            b"user" => Some(Key::Own(split(rest).map_or(rest, |(account, _)| account))),
            b"profile" => is_profile(rest).then_some(Key::Profile(rest)),
            b"about" => {
                let (p, field) = split(rest)?;
                (is_profile(p) && !field.is_empty()).then_some(Key::ProfileField(p))
            }
            b"name" => is_handle(rest).then_some(Key::Name(rest)),
            b"points" => is_handle(rest).then_some(Key::Points(rest)),
            b"owns" => {
                let (account, p) = split(rest)?;
                (is_address(account) && is_profile(p)).then_some(Key::Owns(account, p))
            }
            b"names" => {
                let (account, handle) = split(rest)?;
                (is_address(account) && is_handle(handle)).then_some(Key::Names(account, handle))
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

/// A token value, `<owner>`, `<owner>@<price>` or `<owner>><taker>`, owner
/// and taker accounts. A price is one a credit can pay: below 2^63.
fn token(value: &[u8]) -> Option<(&[u8], Terms<'_>)> {
    let Some(at) = value.iter().position(|&byte| byte == b'@' || byte == b'>') else {
        return is_address(value).then_some((value, Terms::Kept));
    };
    let (owner, rest) = (&value[..at], &value[at + 1..]);
    if !is_address(owner) {
        return None;
    }
    if value[at] == b'@' {
        let price = decimal(rest).filter(|&price| price <= i64::MAX as u64)?;
        return Some((owner, Terms::Price(price)));
    }
    (is_address(rest) && rest != owner).then_some((owner, Terms::Offer(rest)))
}
