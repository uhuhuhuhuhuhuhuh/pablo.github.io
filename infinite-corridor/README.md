# Infinite Corridor

Infinite Corridor is a browser-native deterministic "infinite filesystem" inspired by `p2r3/babel-usb`.

It does not contain an enormous database of files. Instead, it uses the same core mathematical idea as Babel USB: arbitrary bytes map deterministically to a path, and that path can be decoded back into the bytes. The entire application is static HTML/CSS/JavaScript and can run on GitHub Pages without a backend.

## Features

- Exact UTF-8 text to Corridor address
- Exact hexadecimal bytes to Corridor address
- Local file to Corridor address, with a browser safety cap for impractically large paths
- Virtual explorer with 4,900 generated directories at every level
- Path-to-file decoder with text and hex previews
- Client-side generated file downloads
- Bounded regex match synthesis with Corridor addresses for each generated match
- URL-hash state for practical-depth Explorer locations
- No uploads, database, API, or server-side execution

## Babel compatibility

The compatibility codec uses the original 70-character alphabet and two-character directory names. That gives 4,900 directory choices per level. Byte sequences are represented in bijective base 256 and paths in bijective base 4,900.

The root `file` corresponds to the empty byte sequence.

One quirk of the source project is that the JavaScript/C source lists four extra trailing symbols after declaring an alphabet length of 70. The actual modulo arithmetic can only reach the first 70 symbols, so Infinite Corridor follows the executable mapping and treats `++` as the final directory name.

## Why regex is a generator

There is no finite index to scan. A regex such as `cat[0-9]{3}` has many possible matches, and an unbounded regex can represent infinitely many byte strings. The regex tool therefore synthesizes a requested number of matching examples and calculates each example's exact Corridor path.

The built-in generator supports common literals, groups, alternation, character classes/ranges, `\d`, `\w`, `\s`, `.`, `?`, `*`, `+`, and `{m,n}`. It intentionally rejects backreferences, lookarounds, and negated character classes.

## Privacy

The application is entirely client-side. Files selected in the browser are read locally with the File API. This code does not send selected file contents to a server.

## Practical limits

Babel addresses grow with input size. Large files result in extremely deep paths and expensive arbitrary-precision base conversion. The deployed browser UI caps exact conversion at 64 KiB to avoid freezing the tab. That cap is a UI safety choice, not a limitation of the mathematical mapping.

## Validation

The browser codec was checked for byte/path/byte round trips and against 100 randomized vectors generated with the original `file-to-path.js` formula.

## Inspiration

Inspired by `https://github.com/p2r3/babel-usb`. Infinite Corridor is an independent browser implementation of the deterministic mapping concept and does not emulate the original project's ESP32 MTP transport.
