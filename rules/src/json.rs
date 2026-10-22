//! JSON: just enough to find a post's top-level `"time"`, as Stoa's policy reads it.

/// The top-level `"time"` of a JSON object: exactly one, a non-negative whole
/// number with no fraction or exponent. None for anything else, or for an
/// object with a key holding an escape.
pub fn time_of(json: &[u8]) -> Option<i64> {
    let mut j = Json { bytes: json, at: 0 };
    j.space();
    j.expect(b'{')?;
    let mut time = None;
    j.space();
    if j.peek() == Some(b'}') {
        j.at += 1;
    } else {
        loop {
            j.space();
            let key = j.string()?;
            if key.contains(&b'\\') {
                return None;
            }
            j.space();
            j.expect(b':')?;
            j.space();
            if key == b"time" {
                if time.is_some() {
                    return None;
                }
                time = Some(j.integer()?);
            } else {
                j.value(0)?;
            }
            j.space();
            match j.next()? {
                b',' => continue,
                b'}' => break,
                _ => return None,
            }
        }
    }
    j.space();
    if j.at != json.len() {
        return None;
    }
    time
}

struct Json<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Json<'a> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }
    fn next(&mut self) -> Option<u8> {
        let byte = self.peek()?;
        self.at += 1;
        Some(byte)
    }
    fn expect(&mut self, byte: u8) -> Option<()> {
        (self.next()? == byte).then_some(())
    }
    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }
    /// A string's raw contents, escapes left as written.
    fn string(&mut self) -> Option<&'a [u8]> {
        self.expect(b'"')?;
        let start = self.at;
        loop {
            match self.next()? {
                b'"' => return Some(&self.bytes[start..self.at - 1]),
                b'\\' => {
                    self.next()?;
                }
                byte if byte < 0x20 => return None,
                _ => {}
            }
        }
    }
    fn integer(&mut self) -> Option<i64> {
        let start = self.at;
        let mut value: i64 = 0;
        while let Some(digit @ b'0'..=b'9') = self.peek() {
            value = value.checked_mul(10)?.checked_add((digit - b'0') as i64)?;
            self.at += 1;
        }
        let digits = self.at - start;
        if digits == 0 || (digits > 1 && self.bytes[start] == b'0') {
            return None;
        }
        if matches!(self.peek(), Some(b'.' | b'e' | b'E')) {
            return None;
        }
        Some(value)
    }
    /// Skips one value.
    fn value(&mut self, depth: u32) -> Option<()> {
        if depth > 64 {
            return None;
        }
        match self.peek()? {
            b'"' => self.string().map(|_| ()),
            b'{' | b'[' => {
                let close = if self.next()? == b'{' { b'}' } else { b']' };
                self.space();
                if self.peek() == Some(close) {
                    self.at += 1;
                    return Some(());
                }
                loop {
                    self.space();
                    if close == b'}' {
                        self.string()?;
                        self.space();
                        self.expect(b':')?;
                        self.space();
                    }
                    self.value(depth + 1)?;
                    self.space();
                    match self.next()? {
                        b',' => continue,
                        byte if byte == close => return Some(()),
                        _ => return None,
                    }
                }
            }
            b't' => self.word(b"true"),
            b'f' => self.word(b"false"),
            b'n' => self.word(b"null"),
            _ => {
                if self.peek() == Some(b'-') {
                    self.at += 1;
                }
                let start = self.at;
                while matches!(self.peek(), Some(b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')) {
                    self.at += 1;
                }
                (self.at > start).then_some(())
            }
        }
    }
    fn word(&mut self, word: &[u8]) -> Option<()> {
        let end = self.at.checked_add(word.len())?;
        (self.bytes.get(self.at..end)? == word).then(|| self.at = end)
    }
}
