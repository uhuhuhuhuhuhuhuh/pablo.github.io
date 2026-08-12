# IC2 binary format v2

Public token: `IC2.<outer-mode>.<base64url-manifest>` where outer mode is `R` (raw), `Z` (Zstandard), or `G` (gzip). The readable filename follows the token in the URL fragment and is not part of the binary manifest.

Binary manifest header:

- magic `IC2B`
- format version `2`
- hash algorithm `1` = SHA-256
- content-defined chunker version `1`
- 16-byte random salt
- total reconstructed byte length as unsigned varint
- 32-byte SHA-256 of the complete original file
- segment count as unsigned varint

Each segment stores:

- representation kind byte
- unit output length varint
- repeat count varint
- SHA-256 of one decoded unit
- representation-specific payload

Kinds:

0. RAW: payload length + exact bytes
1. COMPRESSED: codec byte + payload length + payload (`1` Zstandard, `2` gzip)
2. ZERO: no payload
3. CONSTANT: one byte
4. REPEAT: pattern length + pattern bytes
5. COUNTER8: starting byte, then increment modulo 256
6. REF: backward segment index
7. DELTA_XOR: backward base segment + codec + compressed XOR bytes
8. DELTA_SPLICE: backward base segment + common prefix length + common suffix length + codec + encoded middle bytes

All references are backward-only, making the manifest acyclic and sequentially reconstructable. `repeatCount` applies to one verified decoded unit, which permits very large repeated/generated outputs without storing millions of identical records.

The v2 decoder rejects unknown versions, unknown hash algorithms, forward references, invalid lengths, malformed varints, unit hash failures, and final whole-file hash failures.
