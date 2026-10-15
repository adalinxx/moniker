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
                let context = unsafe {
                    core::slice::from_raw_parts(pointer as usize as *const u8, length as usize)
                };
                $validate(context) as i32
            }

            #[panic_handler]
            fn panic(_: &core::panic::PanicInfo) -> ! {
                unreachable()
            }
        }
    };
}
