// A faster drop-in for csv-reader 1.0.0: same reading, different speed.
//
// The reference walks the text one character at a time and grows every field by
// one character per step. That is O(characters) string churn. This module keeps
// the same state machine — the same token boundaries, the same error order, the
// same line and row bookkeeping — but finds each run of plain characters with a
// native search and cuts it out once with slice(), so a field with no escapes
// costs two searches and one copy instead of one copy per character.
//
// The reading it reproduces:
//   - a leading U+FEFF is dropped;
//   - a record ends at LF or CRLF, and a line holding no characters is no record;
//   - outside quotes a CR with no LF after it is dropped, noted as stray_cr;
//   - a field opening with a quote runs to the next undoubled quote, "" being one
//     quote, and each CRLF or lone CR inside becomes one LF; whatever follows the
//     closing quote up to a comma or line break is joined on (quote_junk);
//   - a quote that never closes is a literal character and the rest of that field
//     is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is just a character;
//   - columns is the first record when header is true, else null, and every row is
//     padded with "" (short_row) or cut (long_row) to that first record's width.

const COMMA = 0;
const BREAK = 1;
const END = 2;

const QUOTE = 34;
const COMMA_CH = 44;
const LF = 10;
const CR = 13;
const BOM = 65279;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const total = text.length;

  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === BOM ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  // Where the text's last CR and last quote sit, so a search for either is skipped
  // once the reader is past them. -1 means the character does not occur at all.
  const lastCR = text.lastIndexOf('\r');
  const lastQuote = text.lastIndexOf('"');

  // Set by the two field readers below.
  let ended = END;
  let added = 0;

  // LF characters between two offsets of the text, for the line counter.
  function newlinesIn(from, to) {
    let found = 0;
    let at = text.indexOf('\n', from);
    while (at >= 0 && at < to) {
      found += 1;
      at = text.indexOf('\n', at + 1);
    }
    return found;
  }

  // An unquoted field: everything from `pos` to the next comma or line break,
  // with each stray CR dropped and noted. `prefix` is text already gathered.
  //
  // Every delimiter search is a native forward scan, so a field costs up to three
  // of them. Two are skipped outright when the whole text holds no CR or no quote
  // at all, which is the usual case for a file that only has commas and line
  // breaks: `lastCR` and `lastQuote` are where those characters end, or -1.
  function readPlain(prefix) {
    let begins = pos;
    let chunks = null;
    added = 0;
    for (;;) {
      const comma = text.indexOf(',', pos);
      const breakAt = text.indexOf('\n', pos);
      const cr = pos <= lastCR ? text.indexOf('\r', pos) : -1;

      let stop = -1;
      let kind = END;
      if (comma >= 0) {
        stop = comma;
        kind = COMMA;
      }
      if (breakAt >= 0 && (stop < 0 || breakAt < stop)) {
        stop = breakAt;
        kind = BREAK;
      }
      if (cr >= 0 && (stop < 0 || cr < stop)) {
        stop = cr;
        kind = -1;
      }

      if (stop < 0) {
        // Past the end of the text: the field ends here.
        const tail = text.slice(begins);
        added += total - begins;
        pos = total;
        ended = END;
        if (chunks !== null) {
          chunks.push(prefix.concat(tail));
          return chunks.join('');
        }
        return prefix.concat(tail);
      }

      if (kind === -1) {
        // A CR: it is a line break only when an LF follows it.
        if (text.charCodeAt(stop + 1) === LF) {
          const body = text.slice(begins, stop);
          added += stop - begins;
          pos = stop + 2;
          line += 1;
          ended = BREAK;
          if (chunks !== null) {
            chunks.push(body);
            return chunks.join('');
          }
          return prefix.concat(body);
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (chunks === null) chunks = [prefix];
        chunks.push(text.slice(begins, stop));
        pos = stop + 1;
        begins = pos;
        continue;
      }

      const body = text.slice(begins, stop);
      added += stop - begins;
      if (kind === COMMA) {
        pos = stop + 1;
        ended = COMMA;
      } else {
        pos = stop + 1;
        line += 1;
        ended = BREAK;
      }
      if (chunks !== null) {
        chunks.push(body);
        return chunks.join('');
      }
      return prefix.concat(body);
    }
  }

  // A quoted field whose opening quote sits at `pos`. Returns its text.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let begins = pos;
    let chunks = null;

    for (;;) {
      const quote = pos <= lastQuote ? text.indexOf('"', pos) : -1;
      const cr = pos <= lastCR ? text.indexOf('\r', pos) : -1;

      if (quote < 0 && cr < 0) {
        // No closing quote anywhere: the opening one was a plain character.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readPlain('"');
      }

      if (cr >= 0 && (quote < 0 || cr < quote)) {
        line += newlinesIn(begins, cr);
        if (chunks === null) chunks = [];
        chunks.push(text.slice(begins, cr), '\n');
        line += 1;
        pos = text.charCodeAt(cr + 1) === LF ? cr + 2 : cr + 1;
        begins = pos;
        continue;
      }

      if (text.charCodeAt(quote + 1) === QUOTE) {
        // A doubled quote inside the field is one quote.
        line += newlinesIn(begins, quote);
        if (chunks === null) chunks = [];
        chunks.push(text.slice(begins, quote), '"');
        pos = quote + 2;
        begins = pos;
        continue;
      }

      // The closing quote.
      line += newlinesIn(begins, quote);
      const body = text.slice(begins, quote);
      let value;
      if (chunks === null) {
        value = body;
      } else {
        chunks.push(body);
        value = chunks.join('');
      }
      pos = quote + 1;

      if (pos >= total) {
        ended = END;
        return value;
      }
      const next = text.charCodeAt(pos);
      if (next === COMMA_CH) {
        pos += 1;
        ended = COMMA;
        return value;
      }
      if (next === LF) {
        pos += 1;
        line += 1;
        ended = BREAK;
        return value;
      }
      if (next === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
        ended = BREAK;
        return value;
      }
      // Anything else is joined on as it stands, and noted when it is not empty.
      const joined = readPlain(value);
      if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return joined;
    }
  }

  for (;;) {
    // Empty lines are no records: step over LF and CRLF runs.
    while (pos < total) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= total) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    const fields = [];
    let openedWithQuote = false;
    for (;;) {
      openedWithQuote = text.charCodeAt(pos) === QUOTE;
      fields.push(openedWithQuote ? readQuoted() : readPlain(''));
      if (ended !== COMMA) break;
    }

    // A line that held nothing but dropped CRs leaves one empty plain field.
    if (fields.length === 1 && fields[0] === '' && !openedWithQuote) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns === null ? [] : columns) : null, rows, errors };
}
