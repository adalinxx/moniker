//! Tokens: keys held by an account, sold or given on terms the holder sets,
//! each listed under its holder by an index key.
//!
//! A token's value is `<owner>`, `<owner>@<price>` (for anyone, at that
//! price, paid to the owner) or `<owner>><account>` (offered to that account
//! for nothing). Whoever creates a free id owns it; the owner changes it at
//! will; anyone else only takes it on its terms, paying in the same
//! transaction. Nothing is put on an account without its signature: a
//! token's new owner signs.
//!
//! The policy sees only the transaction, not the chain's state, so a
//! transaction acting for a token writes it, unchanged if nothing moves.
//! Consensus checks every old value against the chain, so that write says
//! who owns it. Anyone may write a token unchanged.
//!
//! A token that changes owner is followed directly by its index keys,
//! `<index>/<holder>/<id>` set to `1`: the one it leaves deleted first, then
//! the one it reaches. These keys change in no other way, and the chain starts
//! with neither, so an index always agrees with its tokens.

use crate::{decimal, is_address, Action, Payments, Signers};

/// What a token's holder asks of anyone else who would take it.
#[derive(Clone, Copy, PartialEq)]
pub enum Terms<'a> {
    /// Not for anyone else.
    Kept,
    /// For anyone, at this price, paid to the owner.
    Price(u64),
    /// For this one taker, for nothing.
    Offer(&'a [u8]),
}

/// A token just written: its id, its owner after the transaction, and
/// whether that owner signs.
#[derive(Clone, Copy)]
pub struct Held<'a> {
    pub id: &'a [u8],
    pub owner: &'a [u8],
    pub signs: bool,
}

/// An index key the token before calls for, written (`created`) or deleted.
#[derive(Clone, Copy, PartialEq)]
struct Index<'a> {
    holder: &'a [u8],
    id: &'a [u8],
    created: bool,
}

/// One kind of token, read in one pass over the actions.
pub struct Tokens<'a, 'b> {
    signers: &'b Signers<'a, 'b>,
    /// The index keys still called for, the next first.
    expect: [Option<Index<'a>>; 2],
    payments: Payments<'a>,
}

impl<'a, 'b> Tokens<'a, 'b> {
    pub fn new(signers: &'b Signers<'a, 'b>, payments: Payments<'a>) -> Self {
        Tokens { signers, expect: [None; 2], payments }
    }

    pub fn signs(&self, account: &[u8]) -> bool {
        self.signers.is_signer(account).is_some()
    }

    /// Whether the next action must be an index key.
    pub fn due(&self) -> bool {
        self.expect[0].is_some()
    }

    /// The index key `<index>/<holder>/<id>` the token before called for.
    pub fn index(&mut self, holder: &'a [u8], id: &'a [u8], action: &Action<'a>) -> Option<()> {
        let created = match (action.old_value, action.new_value) {
            (None, Some(b"1")) => true,
            (Some(_), None) => false,
            _ => return None,
        };
        (Some(Index { holder, id, created }) == self.expect[0]).then_some(())?;
        self.expect = [self.expect[1], None];
        Some(())
    }

    /// A write to token `<id>`: who holds it after, or nobody if its owner
    /// released it, which only a `releasable` token may be.
    pub fn write(&mut self, action: &Action<'a>, id: &'a [u8], releasable: bool) -> Option<Option<Held<'a>>> {
        let old = match action.old_value {
            Some(value) => Some(token(value)?),
            None => None,
        };
        let new = match action.new_value {
            Some(value) => Some(token(value)?.0),
            None => None,
        };
        let held = new.map(|owner| Held { id, owner, signs: self.signs(owner) });
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
            // Released by its owner.
            (Some((owner, _)), None) => (releasable && self.signs(owner)).then_some(())?,
            (Some((owner, terms)), Some(held)) => {
                if owner != held.owner {
                    // Nobody is given a token without signing for it.
                    held.signs.then_some(())?;
                }
                // The owner changes it at will; anyone else only takes it.
                if !self.signs(owner) {
                    (owner != held.owner).then_some(())?;
                    self.purchase(owner, terms, held.owner)?;
                }
            }
        }
        let to = held.map(|held| held.owner);
        if from != to {
            let leaves = from.map(|holder| Index { holder, id, created: false });
            let reaches = to.map(|holder| Index { holder, id, created: true });
            self.expect = if leaves.is_some() { [leaves, reaches] } else { [reaches, None] };
        }
        Some(held)
    }

    /// Every index key called for came, and every purchase is paid: run this
    /// after the last action.
    pub fn finish(self) -> Option<()> {
        self.expect[0].is_none().then_some(())?;
        self.payments.finish()
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

/// A token value, `<owner>`, `<owner>@<price>` or `<owner>><taker>`, owner
/// and taker accounts. A price is one a credit can pay: below 2^63.
pub fn token(value: &[u8]) -> Option<(&[u8], Terms<'_>)> {
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
