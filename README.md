# The Infinite Corridor

The Infinite Corridor is a static, browser-only file sharing service hosted on GitHub Pages.

The homepage has one purpose: select a local file and create a self-contained public share link. No user account, file server, pointer database, or upload API is used.

## How sharing works

1. The browser reads the selected file locally.
2. The file is optionally gzip-compressed when that makes it smaller.
3. SHA-256 is added for integrity checking.
4. A fresh 16-byte random salt is added so repeated shares of the same bytes produce different-looking URLs.
5. The reversible payload is encoded into an `ICS1` URL fragment.
6. The recipient opens `/s/`, where JavaScript discards the salt, reconstructs the original bytes, verifies SHA-256, and starts the download using the filename at the end of the link.

The salt is deliberately not part of reconstruction. It is not encryption.

## Current limits

There is no fixed source-file size cap in the browser UI. A source file is accepted as long as the browser can process it and the final self-contained ICS1 token fits within the current 1,500,000-character share-link safety ceiling.

An incompressible file can fit only about 1.07 MiB of raw data within that token ceiling because Base64URL expands binary data. Much larger source files can still work when gzip compresses them sufficiently. Highly compressible text, JSON, CSV, logs, and similar data can therefore be far larger than already-compressed video, ZIP, PNG/JPEG, and similar formats.

Very large source files can require substantial browser memory during encoding. If the final token exceeds the configured link limit, the share is rejected rather than producing a truncated or invalid URL.

## Deployment

The site is served from the repository root with GitHub Pages and `.nojekyll`.

Canonical project URL:

`https://uhuhuhuhuhuhuhuh.github.io/pablo.github.io/`
