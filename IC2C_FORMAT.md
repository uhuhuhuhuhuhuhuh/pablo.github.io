# IC2C corpus-assisted shares

IC2C is the optional corpus-assisted companion to IC2. It is used only when the browser finds exact FastCDC chunks in the static public corpus catalog. Ordinary `IC2.*` and legacy `ICS1.*` shares remain supported.

## What changes

A self-contained IC2 share carries all non-generatable bytes in the token. An `IC2C.*` share may instead contain exact references to public HTTP source objects. Each corpus segment stores a source-table index, byte offset, chunk length, and SHA-256. The receiver requests that exact byte range, verifies the chunk SHA-256, writes it to the output stream, then verifies the complete output SHA-256.

The public catalog is needed only while **creating** a share. Source URLs actually used by a finished IC2C share are embedded in its manifest, so the receiver does not need `corpus/index.json` to interpret source IDs.

## Token

`IC2C.<outer-mode>.<base64url-manifest>`

Outer mode is `R`, `G`, or `Z`, using the same outer-compression runtime as IC2.

The binary manifest contains:

- magic `IC2C`
- format version 1
- SHA-256 hash algorithm identifier
- FastCDC version
- total output length
- full-file SHA-256
- deduplicated public source URL table
- segment table

Segment kinds are exact public-corpus reference, raw, compressed, zero recipe, constant recipe, repeat recipe, and backward deduplicated reference.

## Static catalog

`corpus/index.json` uses format `IC2_CORPUS_CATALOG_V1`. Chunk records are sharded by the first 12 hash bits under `corpus/chunks/ab/c.bin`.

Each fixed 48-byte little-endian record is:

- 32 bytes: complete chunk SHA-256
- 4 bytes: catalog source ID
- 8 bytes: byte offset in source object
- 4 bytes: chunk length

The catalog builder verifies the complete source SHA-256 recorded by the bulk trainer before publishing any chunk records. It also requires the source host to honor HTTP byte-range requests.

## Dependency semantics

IC2C is intentionally not self-contained. Reconstruction depends on the embedded public source URLs remaining accessible and returning the original bytes. This dependency cannot silently corrupt output because each fetched chunk and the final file are SHA-256 verified. If a source disappears, the receiver reports failure instead of producing different bytes.

If no useful catalog match is found, or a corpus-assisted token still exceeds the 1,500,000-character budget, the sender automatically retries with ordinary self-contained IC2.
