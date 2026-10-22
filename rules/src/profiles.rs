//! Profiles an app defines on its own chain: public identities an account
//! owns, sells or gives as tokens, and the records written as them. Keys:
//!
//! - `profile/<p>`: the profile, a token (see `tokens`). `<p>` is 16
//!   characters of `a`–`z` and `2`–`7`. A profile is never deleted.
//! - `owns/<account>/<p>`: `1` while the account owns the profile, so an
//!   account's profiles list by prefix.
//! - `about/<p>/<field>...`: the profile's records (its card, the handle it
//!   shows, any of the app's fields), written by its owner.
//!
//! A transaction acting for a profile writes `profile/<p>`, unchanged if
//! nothing moves, which proves its owner; the owner after the transaction
//! must sign. That profile's records follow, while it is the last
//! profile written: `about/<p>/...` here, and whatever records the app keys
//! by profile, which ask `acts_for`.

use crate::tokens::{Held, Tokens};
use crate::{Action, Payments, Signers};

/// The profile keys of a transaction, read in one pass.
pub struct Profiles<'a, 'b> {
    tokens: Tokens<'a, 'b>,
    /// The last profile written.
    current: Option<Held<'a>>,
}

impl<'a, 'b> Profiles<'a, 'b> {
    pub fn new(signers: &'b Signers<'a, 'b>, payments: Payments<'a>) -> Self {
        Profiles { tokens: Tokens::new(signers, payments), current: None }
    }

    /// Reads one action: `Some(true)` for a profile key it allows,
    /// `Some(false)` for a key that is not a profile key, which the app
    /// judges, and `None` for a refusal.
    pub fn step(&mut self, action: &Action<'a>) -> Option<bool> {
        let (kind, rest) = split(action.key).unwrap_or((action.key, b""));
        if self.tokens.due() {
            // Only the index key the profile before calls for.
            (kind == b"owns").then_some(())?;
            let (account, p) = split(rest)?;
            self.tokens.index(account, p, action)?;
            return Some(true);
        }
        match kind {
            b"profile" => {
                is_profile(rest).then_some(())?;
                let held = self.tokens.write(action, rest, false)??;
                self.current = Some(held);
            }
            b"about" => {
                let (p, field) = split(rest)?;
                // Only the owner of the last profile written writes its records.
                let current = self.current.filter(|current| current.id == p)?;
                (!field.is_empty() && current.signs).then_some(())?;
            }
            // Index keys come only where a profile's move calls for them.
            b"owns" => return None,
            _ => return Some(false),
        }
        Some(true)
    }

    /// Whether profile `<p>` is the last profile written, and its owner signs.
    pub fn acts_for(&self, p: &[u8]) -> bool {
        self.current.is_some_and(|current| current.id == p && current.signs)
    }

    /// Every index key called for came, and every purchase is paid: run this
    /// after the last action.
    pub fn finish(self) -> Option<()> {
        self.tokens.finish()
    }
}

/// A profile id: 16 characters of the base32 alphabet.
pub fn is_profile(text: &[u8]) -> bool {
    text.len() == 16 && text.iter().all(|&byte| matches!(byte, b'a'..=b'z' | b'2'..=b'7'))
}

/// `key` split at its first `/`.
pub fn split(key: &[u8]) -> Option<(&[u8], &[u8])> {
    let at = key.iter().position(|&byte| byte == b'/')?;
    Some((&key[..at], &key[at + 1..]))
}
