# The Infinite Corridor

The Infinite Corridor is a static, client-side exact file-sharing experiment hosted on GitHub Pages.

## IC2.1 adaptive knowledge

IC2.1 extends the IC2 streaming encoder with a persistent local knowledge layer. Useful structural samples from successfully analyzed files are retained in IndexedDB on the same browser profile. Future files with the same extension/profile can test up to 16 KiB of learned material as a Zstandard raw-content dictionary.

The important correctness rule is that learning never becomes a hidden dependency. If learned dictionary compression wins, the exact dictionary bytes are embedded in the IC2 v3 manifest. Before finalizing a share, IC2.1 compares the cumulative dictionary savings with the cost of embedding that dictionary. If the dictionary does not pay for itself, all dictionary-coded chunks are automatically replaced with their ordinary self-contained fallback representations.

This means a recipient never needs the sender's IndexedDB database to open a normal share.

## Encoder

The encoder reads the source as a stream and uses content-defined chunking with versioned parameters: 16 KiB minimum, 64 KiB target, 256 KiB maximum. For each chunk it can choose:

- deterministic recipes: zero, constant byte, repeating pattern up to 256 bytes, or byte counter;
- repeated-unit run or backward reference to an identical earlier chunk;
- XOR or prefix/suffix delta against a similar recent chunk;
- learned Zstandard dictionary compression when it is measurably worthwhile;
- ordinary Zstandard compression through a pinned browser WASM dependency;
- gzip fallback;
- raw bytes when compression does not help.

Every unit stores SHA-256 and the manifest stores SHA-256 of the complete source file. Reconstruction verifies both.

## Local learning

The browser stores only small samples and aggregate profile statistics, not whole source files. Samples are capped and pruned. The UI exposes the current local sample count and a Clear local knowledge control.

There is also an opt-in **Train from Archive.org** control. It samples a small number of Project Gutenberg text derivatives through Internet Archive search/metadata/download endpoints, limits each training object to 2 MiB, and stores the resulting samples only in local IndexedDB. Archive content is not committed to this repository.

Normal file sharing still works with an empty knowledge database.

## Format and compatibility

New encodes use IC2 binary manifest version 3. Version 3 adds an optional embedded dictionary section and a `COMPRESSED_DICT` segment kind. The token envelope remains:

`IC2.<R|Z|G>.<base64url-binary-manifest>`

The receiver accepts both IC2 manifest version 2 and version 3, and `/s/` also retains decoding support for legacy `ICS1` links.

## Limits

There is no fixed source-file-size cap. Public share tokens remain capped at 1,500,000 characters for browser/clipboard safety. High-entropy or already-compressed novel data still obeys the information-theoretic floor and therefore stops fitting quickly.

Encoding runs in a Web Worker and never loads the entire source with `file.arrayBuffer()`. Decoding can use the File System Access API or OPFS for incremental output.

## Zstandard dependency

The site pins `@bokuweb/zstd-wasm` `0.0.27`. If it cannot load during encoding, the encoder falls back to browser gzip/raw. Dictionary compression is only considered when the pinned runtime exposes dictionary APIs.

## Canonical site

`https://uhuhuhuhuhuhuhuh.github.io/pablo.github.io/`
