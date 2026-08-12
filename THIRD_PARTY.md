# Third-party runtime component

IC2 attempts to load the browser build of `@bokuweb/zstd-wasm` version `0.0.27` from a version-pinned jsDelivr URL for Zstandard compression/decompression.

- Wrapper project: https://github.com/bokuweb/zstd-wasm
- Wrapper license: MIT
- Zstandard implementation: https://github.com/facebook/zstd
- Zstandard license: BSD 3-Clause OR GPL-2.0

If the pinned Zstandard component is unavailable during encoding, IC2 falls back to the browser Compression Streams gzip implementation or raw bytes. A token whose manifest actually contains Zstandard-coded segments requires a Zstandard decoder at reconstruction time.
