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
//! - `about/<p>/<field>...`: the profile's records (its card, the name it
//!   shows, its admins, any app's fields). Only its owner writes them. They
//!   sit apart from `profile/<p>`, which a transaction acting for `<p>`
//!   rewrites, so that one never writes a key and adds a key under it.
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
//! The policy reads the actions once, in order, keeping only the last two
//! profiles written in mind, so it costs what the transaction's bytes do.
//! The order:
//!
//! - `profile/<p>` is followed directly by the `owns/` keys it moves, the
//!   one it leaves first.
//! - `about/<p>/...` comes while `<p>` is one of the last two profiles
//!   written, and `about/<p>/name`, when set, directly after the name it
//!   shows (and that name's index keys).
//! - `name/<handle>` comes while the profiles it moves between are among the
//!   last two written, and is followed directly by the `holds/` keys it
//!   moves, the one it leaves first.
//! - A seller's purchases come one after another, and sellers are credited in
//!   the order they are first paid: each run of purchases is paid by the
//!   seller's next credit.
//!
//! What the records mean is up to clients. Coin actions pass untouched.
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
    let mut walk = Walk { signers: &signers, recent: [None; 2], expect: [None; 2], shown: None, payments: body.payments()? };
    for action in body.actions()? {
        walk.step(&action?)?;
    }
    walk.expect[0].is_none().then_some(())?;
    walk.payments.finish()
}

/// A profile among the last two written: its id, its owner after the
/// transaction, and whether that owner signs.
#[derive(Clone, Copy)]
struct Recent<'a> {
    p: &'a [u8],
    owner: &'a [u8],
    signs: bool,
}

/// An index key the action before calls for: `owns/<holder>/<id>` or
/// `holds/<holder>/<id>`, written (`created`) or deleted.
#[derive(Clone, Copy, PartialEq)]
struct Index<'a> {
    owns: bool,
    holder: &'a [u8],
    id: &'a [u8],
    created: bool,
}

/// What the walk keeps from the actions read so far.
struct Walk<'a, 'b> {
    signers: &'b Signers<'a, 'b>,
    /// The last profile written first.
    recent: [Option<Recent<'a>>; 2],
    /// The index keys still called for, the next first.
    expect: [Option<Index<'a>>; 2],
    /// The name just written, and the profile holding it after.
    shown: Option<(&'a [u8], &'a [u8])>,
    payments: Payments<'a>,
}

impl<'a> Walk<'a, '_> {
    fn step(&mut self, action: &Action<'a>) -> Option<()> {
        let key = Key::parse(action.key)?;
        if let Some(index) = self.expect[0] {
            let (owns, holder, id) = match key {
                Key::Owns(account, p) => (true, account, p),
                Key::Holds(p, handle) => (false, p, handle),
                _ => return None,
            };
            let created = match (action.old_value, action.new_value) {
                (None, Some(b"1")) => true,
                (Some(_), None) => false,
                _ => return None,
            };
            (Index { owns, holder, id, created } == index).then_some(())?;
            self.expect = [self.expect[1], None];
            return Some(());
        }
        let shown = self.shown.take();
        match key {
            Key::Own(account) => self.signers.is_signer(account),
            Key::Profile(p) => self.profile(action, p),
            Key::ProfileField(p, field) => {
                self.acts_for(p)?;
                // The name a profile shows is one it holds: the one just written.
                match action.new_value {
                    Some(handle) if field == b"name" => (shown == Some((handle, p))).then_some(()),
                    _ => Some(()),
                }
            }
            Key::Name(handle) => self.name(action, handle),
            // Index keys come only where a token's move calls for them.
            Key::Owns(..) | Key::Holds(..) => None,
        }
    }

    fn recent(&self, p: &[u8]) -> Option<Recent<'a>> {
        self.recent.iter().flatten().find(|recent| recent.p == p).copied()
    }

    /// Profile `p` is one of the last two written, and its owner signs.
    fn acts_for(&self, p: &[u8]) -> Option<()> {
        self.recent(p)?.signs.then_some(())
    }

    fn profile(&mut self, action: &Action<'a>, p: &'a [u8]) -> Option<()> {
        let new_value = action.new_value?;
        let (owner, _) = token(new_value, is_address)?;
        let signs = self.signers.is_signer(owner).is_some();
        self.recent = [Some(Recent { p, owner, signs }), self.recent[0]];
        let Some(old_value) = action.old_value else {
            // A new profile: its owner creates it.
            signs.then_some(())?;
            return self.calls_for(true, p, None, Some(owner));
        };
        if old_value == new_value {
            return Some(());
        }
        let (old_owner, terms) = token(old_value, is_address)?;
        if old_owner != owner {
            // Nobody is given a profile without signing for it.
            signs.then_some(())?;
        }
        // The owner changes it at will; anyone else only takes it.
        if self.signers.is_signer(old_owner).is_none() {
            (old_owner != owner).then_some(())?;
            self.purchase(old_owner, terms, owner)?;
        }
        self.calls_for(true, p, Some(old_owner), Some(owner))
    }

    fn name(&mut self, action: &Action<'a>, handle: &'a [u8]) -> Option<()> {
        let old = match action.old_value {
            Some(value) => Some(token(value, is_profile)?),
            None => None,
        };
        let new = match action.new_value {
            Some(value) => Some(token(value, is_profile)?.0),
            None => None,
        };
        let from = old.map(|(holder, _)| holder);
        self.shown = new.map(|new| (handle, new));
        if action.old_value.is_some() && action.old_value == action.new_value {
            // Anyone may write a name unchanged.
            return Some(());
        }
        if let Some(new) = new.filter(|&new| from != Some(new)) {
            // Nothing is put on a profile without its owner signing for it.
            self.acts_for(new)?;
        }
        if let Some((holder, terms)) = old {
            let seller = self.recent(holder)?;
            // Its profile's owner changes it at will; anyone else only takes
            // it onto another profile. A free name is claimed onto a profile.
            if !seller.signs {
                let taker = new.filter(|&new| new != holder)?;
                self.purchase(seller.owner, terms, taker)?;
            }
        } else {
            new?;
        }
        self.calls_for(false, handle, from, new)
    }

    /// A token at `<id>` that moves from holder `from` to `to` calls for its
    /// index keys next: the one it leaves, then the one it reaches.
    fn calls_for(&mut self, owns: bool, id: &'a [u8], from: Option<&'a [u8]>, to: Option<&'a [u8]>) -> Option<()> {
        if from == to {
            return Some(());
        }
        let leaves = from.map(|holder| Index { owns, holder, id, created: false });
        let reaches = to.map(|holder| Index { owns, holder, id, created: true });
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
            b"profile" => is_profile(rest).then_some(Key::Profile(rest)),
            b"about" => {
                let (p, field) = split(rest)?;
                (is_profile(p) && !field.is_empty()).then_some(Key::ProfileField(p, field))
            }
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
/// holder and taker pass `valid`. A price is one a credit can pay: below 2^63.
fn token(value: &[u8], valid: fn(&[u8]) -> bool) -> Option<(&[u8], Terms<'_>)> {
    let Some(at) = value.iter().position(|&byte| byte == b'@' || byte == b'>') else {
        return valid(value).then_some((value, Terms::Kept));
    };
    let (holder, rest) = (&value[..at], &value[at + 1..]);
    if !valid(holder) {
        return None;
    }
    if value[at] == b'@' {
        let price = decimal(rest).filter(|&price| price <= i64::MAX as u64)?;
        return Some((holder, Terms::Price(price)));
    }
    (valid(rest) && rest != holder).then_some((holder, Terms::Offer(rest)))
}
