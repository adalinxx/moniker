//! Shared pieces of Lattice transaction-scope policies: reading the policy
//! context and transaction body, and the token rule, under which a key's value
//! is its holder, `<holder>`, or its holder with an asking price,
//! `<holder>@<price>`, and anyone may take a priced token by paying its holder
//! at least that price in the same transaction.
//!
//! Consensus checks every declared old value against the chain, so a policy may
//! trust an action's old value as the key's real current value, and an empty
//! one as the key not existing yet.
#![no_std]

pub mod tokens;

const MAGIC: &[u8] = b"LWPCTX";
const CONTEXT_ENCODING_VERSION: u16 = 2;
/// Magic, encoding version, ABI version, scope, height, timestamp.
const HEADER_BYTES: usize = 6 + 2 + 2 + 1 + 8 + 8;

/// The transaction body carried by a transaction-scope context.
pub fn transaction_body(context: &[u8]) -> Option<&[u8]> {
    if context.get(..MAGIC.len())? != MAGIC {
        return None;
    }
    if u16::from_be_bytes(context.get(6..8)?.try_into().ok()?) != CONTEXT_ENCODING_VERSION {
        return None;
    }
    let mut at = HEADER_BYTES;
    let (_spec, next) = length_prefixed(context, at)?;
    at = next;
    let path_items = u32_at(context, at)?;
    at += 4;
    for _ in 0..path_items {
        at = length_prefixed(context, at)?.1;
    }
    if *context.get(at)? != 1 {
        return None;
    }
    Some(length_prefixed(context, at + 1)?.0)
}

/// A transaction body, with the offsets of the fields policies read.
pub struct Body<'a> {
    bytes: &'a [u8],
    signers: usize,
    actions: usize,
    credits: usize,
}

impl<'a> Body<'a> {
    /// A body that is exactly one well-formed DAG-CBOR map.
    pub fn parse(bytes: &'a [u8]) -> Option<Self> {
        if skip(bytes, 0)? != bytes.len() {
            return None;
        }
        Some(Body {
            bytes,
            signers: map_value(bytes, 0, b"signers")?,
            actions: map_value(bytes, 0, b"actions")?,
            credits: map_value(bytes, 0, b"accountActions")?,
        })
    }

    pub fn is_signer(&self, owner: &[u8]) -> Option<()> {
        let (major, count, mut at) = head(self.bytes, self.signers)?;
        if major != ARRAY {
            return None;
        }
        for _ in 0..count {
            if text(self.bytes, at)? == owner {
                return Some(());
            }
            at = skip(self.bytes, at)?;
        }
        None
    }

    /// The general-state actions, read one at a time. A malformed action ends
    /// the walk with a rejection.
    pub fn actions(&self) -> Option<Actions<'a>> {
        let (major, remaining, at) = head(self.bytes, self.actions)?;
        (major == ARRAY).then_some(Actions { body: self.bytes, at, remaining })
    }

    /// The sum of the credits to `owner` in the account actions.
    pub fn credited(&self, owner: &[u8]) -> Option<u128> {
        let (major, count, mut at) = head(self.bytes, self.credits)?;
        if major != ARRAY {
            return None;
        }
        let mut total: u128 = 0;
        for _ in 0..count {
            if text(self.bytes, map_value(self.bytes, at, b"owner")?)? == owner {
                let (sign, amount, _) = head(self.bytes, map_value(self.bytes, at, b"delta")?)?;
                if sign == UNSIGNED {
                    total = total.checked_add(amount as u128)?;
                }
            }
            at = skip(self.bytes, at)?;
        }
        Some(total)
    }

    /// The token rule for a write to a token key: the write leaves a holder;
    /// the holder may change the token in any way; anyone else may take it
    /// only if it has a price, paid for in `check_payments`. Who may create a
    /// token is the policy's to decide: `create` gets the first holder.
    pub fn check_token_write(
        &self,
        action: &Action,
        create: impl FnOnce(&[u8]) -> Option<()>,
    ) -> Option<()> {
        let (new_holder, _) = holding(action.new_value?)?;
        let Some(old) = action.old_value else {
            return create(new_holder);
        };
        let (holder, price) = holding(old)?;
        if self.is_signer(holder).is_some() {
            return Some(());
        }
        price.map(|_| ())
    }

    /// Every holder whose token is taken without their signature is credited
    /// at least the prices of all their tokens taken. `is_token` names the
    /// keys the token rule governs; run this after every action passed it.
    pub fn check_payments(&self, is_token: impl Fn(&[u8]) -> bool) -> Option<()> {
        let purchase = |action: &Action<'a>| -> Option<Option<(&'a [u8], u64)>> {
            let Some(old) = action.old_value.filter(|_| is_token(action.key)) else {
                return Some(None);
            };
            let (holder, price) = holding(old)?;
            if self.is_signer(holder).is_some() {
                return Some(None);
            }
            Some(Some((holder, price?)))
        };
        // The check runs once per holder, at the first token taken from them.
        for (index, action) in self.actions()?.enumerate() {
            let Some((holder, _)) = purchase(&action?)? else {
                continue;
            };
            let mut seen = false;
            let mut owed: u128 = 0;
            for (other, action) in self.actions()?.enumerate() {
                match purchase(&action?)? {
                    Some((payee, price)) if payee == holder => {
                        seen |= other < index;
                        owed = owed.checked_add(price as u128)?;
                    }
                    _ => {}
                }
            }
            if !seen && self.credited(holder)? < owed {
                return None;
            }
        }
        Some(())
    }
}

/// The signers in a crit-bit tree (a compressed binary trie), so that asking
/// whether an account signs follows one path rather than walking every signer.
/// Each internal node holds the first bit where the keys below it differ, and
/// a path visits ever later bits: every signer is an address, 59 characters,
/// so no path is longer than its bits, whatever addresses a signer grinds.
///
/// Built in scratch words: word 0 is the root, then four words per internal
/// node: byte index, the mask of every bit but the critical one, two children.
/// A reference is 0 (none), `offset << 1` for a leaf (the signer's text at
/// that offset in the body, which is never 0), or `node << 1 | 1`.
pub struct Signers<'a, 's> {
    bytes: &'a [u8],
    words: &'s mut [u32],
}

impl<'a> Body<'a> {
    /// The signers, in a tree built in `scratch`, which must hold at least
    /// `signer_words` of the body's bytes. Every signer is an address.
    pub fn signers<'s>(&self, scratch: &'s mut [u32]) -> Option<Signers<'a, 's>> {
        let (major, count, mut at) = head(self.bytes, self.signers)?;
        if major != ARRAY {
            return None;
        }
        let words = scratch.get_mut(..signer_words(count as usize)?)?;
        words[0] = 0;
        let mut tree = Signers { bytes: self.bytes, words };
        for node in 0..count as u32 {
            if !is_address(text(self.bytes, at)?) {
                return None;
            }
            tree.insert(at, node)?;
            at = skip(self.bytes, at)?;
        }
        Some(tree)
    }
}

impl Signers<'_, '_> {
    pub fn is_signer(&self, owner: &[u8]) -> Option<()> {
        let leaf = self.closest(owner)?;
        (text(self.bytes, leaf)? == owner).then_some(())
    }

    /// The offset of the signer whose path `key` follows.
    fn closest(&self, key: &[u8]) -> Option<usize> {
        let mut reference = self.words[0];
        if reference == 0 {
            return None;
        }
        while reference & 1 == 1 {
            let node = 1 + 4 * (reference >> 1) as usize;
            reference = self.words[node + 2 + self.direction(key, node)];
        }
        Some((reference >> 1) as usize)
    }

    /// Which child of internal node `node` (its first word) `key` goes to.
    fn direction(&self, key: &[u8], node: usize) -> usize {
        let byte = key.get(self.words[node] as usize).copied().unwrap_or(0) as u32;
        ((1 + (self.words[node + 1] | byte)) >> 8) as usize
    }

    /// Adds the signer whose text is at `at`, as internal node `node` if one
    /// is needed. A signer listed twice is added once.
    fn insert(&mut self, at: usize, node: u32) -> Option<()> {
        let leaf = u32::try_from(at).ok()?.checked_mul(2)?;
        let key = text(self.bytes, at)?;
        let Some(best) = self.closest(key) else {
            self.words[0] = leaf;
            return Some(());
        };
        let best = text(self.bytes, best)?;
        let byte_at = |text: &[u8], index: usize| text.get(index).copied().unwrap_or(0) as u32;
        let Some(index) = (0..key.len().max(best.len())).find(|&i| byte_at(key, i) != byte_at(best, i)) else {
            return Some(());
        };
        let mut differ = byte_at(key, index) ^ byte_at(best, index);
        differ |= differ >> 1;
        differ |= differ >> 2;
        differ |= differ >> 4;
        let others = (differ & !(differ >> 1)) ^ 0xff;
        let direction = ((1 + (others | byte_at(key, index))) >> 8) as usize;
        // Down to where the new node goes: above the first node that tests a
        // later bit.
        let mut slot = 0;
        while self.words[slot] & 1 == 1 {
            let below = 1 + 4 * (self.words[slot] >> 1) as usize;
            let (byte, mask) = (self.words[below] as usize, self.words[below + 1]);
            if byte > index || (byte == index && mask > others) {
                break;
            }
            slot = below + 2 + self.direction(key, below);
        }
        let new = 1 + 4 * node as usize;
        self.words[new] = index as u32;
        self.words[new + 1] = others;
        self.words[new + 2 + direction] = leaf;
        self.words[new + 2 + (1 - direction)] = self.words[slot];
        self.words[slot] = node << 1 | 1;
        Some(())
    }
}

/// Scratch words for a tree of `count` signers: the root, and four for each
/// internal node, of which there are fewer than signers.
pub fn signer_words(count: usize) -> Option<usize> {
    count.checked_mul(4)?.checked_add(1)
}

/// What purchases owe, checked against the account actions in one pass: a
/// payee's purchases come one after another, and payees are credited in the
/// order they are first owed. Each credit pays one run of purchases.
pub struct Payments<'a> {
    bytes: &'a [u8],
    at: usize,
    remaining: u64,
    payee: Option<&'a [u8]>,
    owed: u128,
}

impl<'a> Body<'a> {
    /// Nothing owed yet; the credits from the first account action on.
    pub fn payments(&self) -> Option<Payments<'a>> {
        let (major, remaining, at) = head(self.bytes, self.credits)?;
        (major == ARRAY).then_some(Payments { bytes: self.bytes, at, remaining, payee: None, owed: 0 })
    }
}

impl<'a> Payments<'a> {
    /// A purchase owes `payee` `price`. A free one owes nothing, and leaves
    /// the run as it was.
    pub fn owe(&mut self, payee: &'a [u8], price: u64) -> Option<()> {
        if price == 0 {
            return Some(());
        }
        if self.payee != Some(payee) {
            self.settle()?;
            self.payee = Some(payee);
        }
        self.owed = self.owed.checked_add(price as u128)?;
        Some(())
    }

    /// Every run of purchases paid: run this after the last action.
    pub fn finish(mut self) -> Option<()> {
        self.settle()
    }

    /// The run owed to the current payee is paid by their next credit.
    fn settle(&mut self) -> Option<()> {
        let (Some(payee), owed) = (self.payee.take(), core::mem::take(&mut self.owed)) else {
            return Some(());
        };
        if owed == 0 {
            return Some(());
        }
        let bytes = self.bytes;
        while self.remaining > 0 {
            self.remaining -= 1;
            let at = self.at;
            self.at = skip(bytes, at)?;
            if text(bytes, map_value(bytes, at, b"owner")?)? == payee {
                let (sign, amount, _) = head(bytes, map_value(bytes, at, b"delta")?)?;
                return (sign == UNSIGNED && amount as u128 >= owed).then_some(());
            }
        }
        None
    }
}

pub struct Action<'a> {
    pub key: &'a [u8],
    pub old_value: Option<&'a [u8]>,
    pub new_value: Option<&'a [u8]>,
}

pub struct Actions<'a> {
    body: &'a [u8],
    at: usize,
    remaining: u64,
}

impl<'a> Iterator for Actions<'a> {
    type Item = Option<Action<'a>>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining == 0 {
            return None;
        }
        self.remaining -= 1;
        let (body, at) = (self.body, self.at);
        let action = (|| {
            let action = Action {
                key: text(body, map_value(body, at, b"key")?)?,
                old_value: optional_text(body, at, b"oldValue")?,
                new_value: optional_text(body, at, b"newValue")?,
            };
            self.at = skip(body, at)?;
            Some(action)
        })();
        if action.is_none() {
            self.remaining = 0;
        }
        Some(action)
    }
}

/// A token value's holder and asking price: `<holder>` or `<holder>@<price>`.
pub fn holding(value: &[u8]) -> Option<(&[u8], Option<u64>)> {
    let mut parts = value.splitn(2, |&byte| byte == b'@');
    let holder = parts.next().filter(|holder| !holder.is_empty())?;
    match parts.next() {
        None => Some((holder, None)),
        Some(price) => Some((holder, Some(decimal(price)?))),
    }
}

/// A canonical unsigned decimal: digits only, no leading zero, fits in u64.
/// Canonical so that one price cannot be spelled two ways.
pub fn decimal(digits: &[u8]) -> Option<u64> {
    if digits.is_empty() || (digits.len() > 1 && digits[0] == b'0') {
        return None;
    }
    digits.iter().try_fold(0u64, |value, &digit| {
        if !digit.is_ascii_digit() {
            return None;
        }
        value.checked_mul(10)?.checked_add((digit - b'0') as u64)
    })
}

/// Whether `text` is an account address in its one canonical spelling: a
/// base32 CIDv1 of a dag-cbor sha2-256 block, `bafyrei` followed by 52
/// characters, with the unused bits of the first and last characters zero.
pub fn is_address(text: &[u8]) -> bool {
    const BASE32: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";
    let value = |byte: u8| BASE32.iter().position(|&c| c == byte);
    text.len() == 59
        && text.starts_with(b"bafyrei")
        && text[7..].iter().all(|&byte| value(byte).is_some())
        // The 32-byte digest starts three bits into the eighth character and
        // ends two bits into the last.
        && value(text[7]).is_some_and(|v| v < 8)
        && value(text[58]).is_some_and(|v| v % 4 == 0)
}

fn u32_at(bytes: &[u8], at: usize) -> Option<usize> {
    let raw = bytes.get(at..at.checked_add(4)?)?;
    Some(u32::from_be_bytes(raw.try_into().ok()?) as usize)
}

fn length_prefixed(bytes: &[u8], at: usize) -> Option<(&[u8], usize)> {
    let start = at.checked_add(4)?;
    let end = start.checked_add(u32_at(bytes, at)?)?;
    Some((bytes.get(start..end)?, end))
}

// DAG-CBOR: definite lengths only, text-keyed maps.

const UNSIGNED: u8 = 0;
const BYTES: u8 = 2;
const TEXT: u8 = 3;
const ARRAY: u8 = 4;
const MAP: u8 = 5;
const TAG: u8 = 6;
/// The DAG-CBOR `null`.
const NULL: u8 = 0xf6;

/// The item head at `at`: `(major type, argument, offset after the head)`.
fn head(bytes: &[u8], at: usize) -> Option<(u8, u64, usize)> {
    let first = *bytes.get(at)?;
    let width = match first & 0x1f {
        small @ 0..=23 => return Some((first >> 5, small as u64, at + 1)),
        24 => 1,
        25 => 2,
        26 => 4,
        27 => 8,
        _ => return None,
    };
    let end = (at + 1).checked_add(width)?;
    let argument = bytes
        .get(at + 1..end)?
        .iter()
        .fold(0u64, |value, &byte| (value << 8) | byte as u64);
    Some((first >> 5, argument, end))
}

/// The offset just past the item at `at`.
fn skip(bytes: &[u8], mut at: usize) -> Option<usize> {
    let mut pending: u64 = 1;
    while pending > 0 {
        let (major, argument, next) = head(bytes, at)?;
        at = next;
        pending -= 1;
        match major {
            BYTES | TEXT => {
                at = at.checked_add(usize::try_from(argument).ok()?)?;
                if at > bytes.len() {
                    return None;
                }
            }
            ARRAY => pending = pending.checked_add(argument)?,
            MAP => pending = pending.checked_add(argument.checked_mul(2)?)?,
            TAG => pending += 1,
            _ => {}
        }
    }
    Some(at)
}

/// The offset of the value stored under `key` in the map at `at`.
fn map_value(bytes: &[u8], at: usize, key: &[u8]) -> Option<usize> {
    let (major, pairs, mut next) = head(bytes, at)?;
    if major != MAP {
        return None;
    }
    for _ in 0..pairs {
        let name = text(bytes, next)?;
        let value = skip(bytes, next)?;
        if name == key {
            return Some(value);
        }
        next = skip(bytes, value)?;
    }
    None
}

/// The text stored under `key` in the map at `at`, where an absent key and a
/// `null` both mean no value.
fn optional_text<'a>(bytes: &'a [u8], at: usize, key: &[u8]) -> Option<Option<&'a [u8]>> {
    let (major, pairs, mut next) = head(bytes, at)?;
    if major != MAP {
        return None;
    }
    for _ in 0..pairs {
        let name = text(bytes, next)?;
        let value = skip(bytes, next)?;
        if name == key {
            return match *bytes.get(value)? {
                NULL => Some(None),
                _ => Some(Some(text(bytes, value)?)),
            };
        }
        next = skip(bytes, value)?;
    }
    Some(None)
}

fn text(bytes: &[u8], at: usize) -> Option<&[u8]> {
    let (major, length, start) = head(bytes, at)?;
    if major != TEXT {
        return None;
    }
    bytes.get(start..start.checked_add(usize::try_from(length).ok()?)?)
}

/// The wasm ABI every Lattice policy module exports, around one verdict
/// function: `lattice_policy_abi!(validate);`.
#[macro_export]
macro_rules! lattice_policy_abi {
    ($validate:path) => {
        #[cfg(target_arch = "wasm32")]
        mod abi {
            use core::arch::wasm32::{memory_grow, memory_size, unreachable};

            const PAGE_BYTES: usize = 65536;

            extern "C" {
                static __heap_base: u8;
            }

            /// The host calls this once per evaluation, on a fresh instance, so
            /// the allocation is simply the memory above the module's own data.
            #[no_mangle]
            pub extern "C" fn lattice_alloc(length: i32) -> i32 {
                let base = unsafe { &__heap_base as *const u8 as usize };
                let Some(end) =
                    usize::try_from(length).ok().and_then(|length| base.checked_add(length))
                else {
                    return -1;
                };
                let have = memory_size(0) * PAGE_BYTES;
                if end > have && memory_grow(0, (end - have).div_ceil(PAGE_BYTES)) == usize::MAX {
                    return -1;
                }
                base as i32
            }

            #[no_mangle]
            pub extern "C" fn lattice_validate_transaction(pointer: i32, length: i32) -> i32 {
                if pointer < 0 || length < 0 {
                    return 0;
                }
                let (start, length) = (pointer as usize, length as usize);
                let context = unsafe { core::slice::from_raw_parts(start as *const u8, length) };
                // Scratch for the signer tree, above the context: room for as
                // many signers as the context could hold (an address takes
                // 61 bytes); the policy uses only what it needs.
                let Some(slots) = $crate::signer_words(length / 61) else { return 0 };
                let Some(from) = start.checked_add(length).map(|end| end.next_multiple_of(4)) else { return 0 };
                let Some(end) = slots.checked_mul(4).and_then(|bytes| from.checked_add(bytes)) else { return 0 };
                let have = memory_size(0) * PAGE_BYTES;
                if end > have && memory_grow(0, (end - have).div_ceil(PAGE_BYTES)) == usize::MAX {
                    return 0;
                }
                let scratch = unsafe { core::slice::from_raw_parts_mut(from as *mut u32, slots) };
                $validate(context, scratch) as i32
            }

            #[panic_handler]
            fn panic(_: &core::panic::PanicInfo) -> ! {
                unreachable()
            }
        }
    };
}
