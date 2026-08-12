# IC2 binary format

IC2 share tokens use:

`IC2.<outer-mode>.<Base64URL(binary-manifest)>`

Outer mode is `R` (raw), `Z` (Zstandard), or `G` (gzip).

## Manifest versions

The receiver supports versions 2 and 3. New IC2.1 encodes use version 3.

Common header:

1. magic `IC2B` (4 bytes)
2. manifest version (u8)
3. hash algorithm id (u8, currently SHA-256 = 1)
4. chunker version (u8)
5. random salt (16 bytes)
6. original output size (varint)
7. complete-file SHA-256 (32 bytes)

Version 2 then stores the segment count.

Version 3 inserts before the segment count:

8. embedded dictionary length (varint)
9. embedded dictionary bytes
10. segment count (varint)

The dictionary is capped at 64 KiB by the decoder. The current learner supplies at most 16 KiB.

## Segment record

Each segment begins with:

- kind (u8)
- unit length (varint)
- repeat count (varint)
- SHA-256 of one reconstructed unit (32 bytes)

Kinds:

- `0 RAW`
- `1 COMPRESSED`
- `2 ZERO`
- `3 CONSTANT`
- `4 REPEAT`
- `5 COUNTER8`
- `6 REF`
- `7 DELTA_XOR`
- `8 DELTA_SPLICE`
- `9 COMPRESSED_DICT` (version 3)

`COMPRESSED_DICT` stores only its compressed payload. It always uses the manifest-level embedded Zstandard dictionary.

## IC2.1 learning rule

The encoder may test locally learned dictionary material, but local history is never an implicit dependency. A dictionary is serialized into the manifest only when the total measured savings across dictionary-coded chunks exceeds the dictionary's own serialized overhead. Otherwise those segments are reverted to their ordinary compression/delta/raw fallback before serialization.

This preserves self-contained decoding while allowing previous related files to improve future encodes when the gain is real.
