//! Profiles an app defines on its own chain: public identities an account
//! owns, sells or gives as tokens, and the records written as them. Keys:
//!
//! - `profile/<p>`: the profile, a token (see `tokens`). `<p>` is 16
//!   characters of `a`–`z` and `2`–`7`. A profile is never deleted.
//! - `owns/<account>/<p>`: `1` while the account owns the profile, so an
//!   account's profiles list by prefix.
//! - `about/<p>/admin/<account>`: an admin, who acts for the profile as its
//!   owner does except over its admins. The value is the owner who named
//!   them, and they act only while that account still owns the profile, so a
//!   sale ends every admin at once. If the profile comes back to that
//!   account, its admins act again unless it removed them.
//! - `about/<p>/<field>...`: the profile's other records (its card, the
//!   handle it shows, any of the app's fields), written by its owner or an
//!   admin.
//!
//! A transaction acting for a profile writes `profile/<p>`, unchanged if
//! nothing moves, which proves its owner; the owner after the transaction
//! must sign. An admin also rewrites their `about/<p>/admin/<account>`
//! unchanged, and signs. That profile's records follow, while it is the last
//! profile written: `about/<p>/...` here, and whatever records the app keys
//! by profile, which ask `acts_for`.

use crate::tokens::{Held, Tokens};
use crate::{is_address, Action, Payments, Signers};

/// The last profile written, and whether its owner or an admin signs.
#[derive(Clone, Copy)]
struct Current<'a> {
    held: Held<'a>,
    admin_signs: bool,
}

/// The profile keys of a transaction, read in one pass.
pub struct Profiles<'a, 'b> {
    tokens: Tokens<'a, 'b>,
    current: Option<Current<'a>>,
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
                self.current = Some(Current { held, admin_signs: false });
            }
            b"about" => {
                let (p, field) = split(rest)?;
                let current = self.current.as_mut().filter(|current| current.held.id == p)?;
                let owner = current.held.owner;
                match split(field) {
                    Some((b"admin", account)) => {
                        is_address(account).then_some(())?;
                        if current.held.signs {
                            // The owner names and removes admins, in their own name.
                            action.new_value.map_or(true, |value| value == owner).then_some(())?;
                        } else {
                            // An admin named by this owner, rewritten unchanged, signs.
                            let named = action.old_value == Some(owner) && action.new_value == Some(owner);
                            (named && self.tokens.signs(account)).then_some(())?;
                            current.admin_signs = true;
                        }
                    }
                    _ => {
                        (!field.is_empty() && field != b"admin").then_some(())?;
                        (current.held.signs || current.admin_signs).then_some(())?;
                    }
                }
            }
            // Index keys come only where a profile's move calls for them.
            b"owns" => return None,
            _ => return Some(false),
        }
        Some(true)
    }

    /// Whether profile `<p>` is the last profile written, and its owner or
    /// one of its admins signs.
    pub fn acts_for(&self, p: &[u8]) -> bool {
        self.current.is_some_and(|current| current.held.id == p && (current.held.signs || current.admin_signs))
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
