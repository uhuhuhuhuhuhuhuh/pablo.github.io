# The Infinite Corridor

The Infinite Corridor is a static, client-side exact file-sharing experiment hosted on GitHub Pages.

## IC2

IC2 replaces the original single-payload ICS1 encoder with a streaming, adaptive representation engine. The public UI remains a normal drag/drop file-sharing page.

The encoder reads the source as a stream and uses content-defined chunking with fixed versioned parameters (16 KiB minimum, 64 KiB target, 256 KiB maximum). For each chunk it chooses the smallest exact representation it can prove:

- deterministic recipe: zero, constant byte, repeating short pattern, or byte counter;
- repeated-unit run or backward reference to an identical earlier chunk;
- XOR or prefix/suffix delta against a similar recent chunk;
- Zstandard compression through a pinned browser WASM dependency;
- gzip fallback;
- raw bytes when compression does not help.

Every unit stores SHA-256 and the manifest stores SHA-256 of the complete source file. Reconstruction is sequential and verifies each unit plus the final output.

The manifest is a compact versioned binary structure, optionally compressed again before Base64URL encoding. Public tokens use:

`IC2.<R|Z|G>.<base64url-binary-manifest>`

The URL filename remains after the token in the fragment:

`/s/#IC2.Z.../filename.ext`

A fresh 16-byte random salt is stored inside every manifest. It only changes the appearance of repeated shares and is discarded during decode. It is not encryption.

## Limits

There is no fixed source-file-size cap. A source can be very large if recipes, repeated-chunk runs, deduplication, deltas, or compression make its exact IC2 descriptor small enough. Public share tokens remain capped at 1,500,000 characters for browser/clipboard safety.

High-entropy or already-compressed files still obey information theory: novel incompressible bytes must be present in the self-contained descriptor, so those files stop fitting quickly.

Encoding runs in a Web Worker and never calls `file.arrayBuffer()` for the whole source. Decoding can use the File System Access API or OPFS so large recipe-heavy outputs can be written incrementally rather than materialized as one giant JavaScript buffer.

## Compatibility

`/s/` retains decoding support for existing `ICS1` links.

## Zstandard dependency

IC2 pins `@bokuweb/zstd-wasm` version `0.0.27` for browser Zstandard support. If the pinned component cannot load, the encoder falls back to browser gzip/raw representations. A link that was actually encoded with Zstandard requires the same decoder component to be reachable.

## Deployment

Canonical site:

`https://uhuhuhuhuhuhuhuh.github.io/pablo.github.io/`
