//! Profiles an app defines on its own chain: public identities, each owned
//! for good by the account that made it, and the records written as them.
//! Keys:
//!
//! - `profile/<p>`: the profile's owner, an account. `<p>` is 16 characters
//!   of `a`–`z` and `2`–`7`. Whoever creates a free id owns it, and signs; a
//!   profile never changes owner and is never deleted.
//! - `owns/<account>/<p>`: `1`, written directly after the profile is
//!   created and never changed, so an account's profiles list by prefix.
//! - `about/<p>/<field>...`: the profile's records (its card, the handle it
//!   shows, any of the app's fields), written by its owner.
//!
//! A transaction acting for a profile writes `profile/<p>`, unchanged unless
//! it creates it, which proves its owner: consensus checks every old value
//! against the chain. The owner must sign. That profile's records follow,
//! while it is the last profile written: `about/<p>/...` here, and whatever
//! records the app keys by profile, which ask `acts_for`.

use crate::{is_address, Action, Signers};

/// The last profile written, and whether its owner signs.
#[derive(Clone, Copy)]
struct Current<'a> {
    id: &'a [u8],
    signs: bool,
}

/// The profile keys of a transaction, read in one pass.
pub struct Profiles<'a, 'b> {
    signers: &'b Signers<'a, 'b>,
    current: Option<Current<'a>>,
    /// The `owns/<account>/<p>` key a profile just created calls for.
    due: Option<(&'a [u8], &'a [u8])>,
}

impl<'a, 'b> Profiles<'a, 'b> {
    pub fn new(signers: &'b Signers<'a, 'b>) -> Self {
        Profiles { signers, current: None, due: None }
    }

    /// Reads one action: `Some(true)` for a profile key it allows,
    /// `Some(false)` for a key that is not a profile key, which the app
    /// judges, and `None` for a refusal.
    pub fn step(&mut self, action: &Action<'a>) -> Option<bool> {
        let (kind, rest) = split(action.key).unwrap_or((action.key, b""));
        if let Some((owner, p)) = self.due.take() {
            // Only the index key the profile just created calls for.
            let created = action.old_value.is_none() && action.new_value == Some(b"1".as_slice());
            let (account, id) = split(rest)?;
            (kind == b"owns" && account == owner && id == p && created).then_some(())?;
            return Some(true);
        }
        match kind {
            b"profile" => {
                is_profile(rest).then_some(())?;
                let owner = match (action.old_value, action.new_value) {
                    // Created by its owner, who signs.
                    (None, Some(owner)) => {
                        self.signers.is_signer(owner)?;
                        self.due = Some((owner, rest));
                        owner
                    }
                    // Rewritten unchanged: whoever owns it.
                    (Some(old), Some(new)) if old == new => old,
                    _ => return None,
                };
                is_address(owner).then_some(())?;
                self.current = Some(Current { id: rest, signs: self.signers.is_signer(owner).is_some() });
            }
            b"about" => {
                let (p, field) = split(rest)?;
                // Only the owner of the last profile written writes its records.
                let current = self.current.filter(|current| current.id == p)?;
                (!field.is_empty() && current.signs).then_some(())?;
            }
            // Index keys come only where a new profile calls for them.
            b"owns" => return None,
            _ => return Some(false),
        }
        Some(true)
    }

    /// Whether profile `<p>` is the last profile written, and its owner signs.
    pub fn acts_for(&self, p: &[u8]) -> bool {
        self.current.is_some_and(|current| current.id == p && current.signs)
    }

    /// Every index key called for came: run this after the last action.
    pub fn finish(self) -> Option<()> {
        self.due.is_none().then_some(())
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
