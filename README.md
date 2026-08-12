# Infinite Corridor

Infinite Corridor is a browser-native deterministic "infinite filesystem" inspired by `p2r3/babel-usb`.

The live project is served from the repository root at:

`https://uhuhuhuhuhuhuhuh.github.io/pablo.github.io/`

It does not contain an enormous database of files. Arbitrary bytes map deterministically to a Babel-compatible path, and that path can be decoded back into the bytes. The application is static HTML/CSS/JavaScript and runs on GitHub Pages without a file backend.

## Features

- Exact UTF-8 text and hexadecimal bytes to Corridor addresses
- Local-file lookup and streamed large-file locators
- Virtual explorer with 4,900 generated directories per level
- Path-to-file decoder
- Discovery-only regex traversal that tests untouched deterministic byte candidates
- XL deterministic objects and format-aware legacy recipes
- Self-Contained Corridor Share (`ICS1`)

## Self-Contained Corridor Share

Public sharing does not use a registry or short-ID database. A share URL contains the reversible information in the URL fragment:

`/s/#ICS1.<throwaway-salt>.<mode>.<sha256>.<payload>/filename.ext`

The browser may gzip the bytes when that reduces the payload. A fresh 128-bit random salt is added to each generated link so repeated shares of the same file normally look different. The receiver validates the salt field and then intentionally discards it. The salt is not part of reconstruction and is not encryption.

The receiver decodes the payload locally, verifies SHA-256, reconstructs the exact original bytes, and downloads them using the filename at the end of the URL. Because the payload lives after `#`, it is not sent to GitHub Pages as part of the HTTP request.

A self-contained URL still has to carry the information content of the file. It can be substantially smaller for compressible files, but arbitrary incompressible multi-gigabyte files cannot be represented by a tiny reversible URL without storing information somewhere else.

## Babel compatibility

The compatibility codec uses the original 70-character alphabet and two-character directory names, giving 4,900 directory choices at each level. Byte sequences are represented in bijective base 256 and paths in bijective base 4,900. The root `file` corresponds to the empty byte sequence.

## Discovery semantics

Babel's mapping contains bytes, not arbitrary external filenames. The Discovery tab therefore treats a filename regex as a search-label and expected-format stream. It traverses deterministic raw byte candidates and only returns candidates that naturally satisfy the selected validation/content conditions. It does not insert PDF signatures, PNG pixels, ZIP entries, document text, or other content to manufacture a hit.

## Privacy

Files selected in the browser are read locally with the File API. Exact mapping, discovery, ICS1 creation, ICS1 decoding, and downloads execute client-side. Selected file contents are not uploaded by Infinite Corridor.

## Inspiration

Inspired by `https://github.com/p2r3/babel-usb`. Infinite Corridor is an independent browser implementation of the deterministic mapping concept and does not emulate the original ESP32 MTP transport.
