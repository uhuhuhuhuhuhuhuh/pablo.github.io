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

The browser UI caps source files at 32 MiB and caps the resulting ICS1 token at 1,500,000 characters. In practice, self-contained links are best suited to small files or highly compressible content. Already-compressed video, archives, PNG/JPEG images, and similar formats may produce links that are too long for practical sharing.

## Deployment

The site is served from the repository root with GitHub Pages and `.nojekyll`.

Canonical project URL:

`https://uhuhuhuhuhuhuhuh.github.io/pablo.github.io/`
