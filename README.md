# The Infinite Corridor

The Infinite Corridor is a static, client-side exact file-sharing experiment hosted on GitHub Pages.

## IC2.1 adaptive knowledge

IC2.1 extends the IC2 streaming encoder with two knowledge layers:

1. a private browser-local knowledge database stored in IndexedDB;
2. an optional repository-wide public baseline loaded from `ic2-public-knowledge.json` in the site root.

Useful structural samples from successfully analyzed files are retained privately in the browser. Future files with the same extension/profile can test learned material as a Zstandard raw-content dictionary.

The public baseline is read-only. If a root-level `ic2-public-knowledge.json` exists and uses format `IC2_PUBLIC_KNOWLEDGE_V1`, the site loads the matching profile and combines it with local knowledge. Local material is preferred, while remaining dictionary capacity can be filled from the public baseline.

The important correctness rule is that learning never becomes a hidden dependency. If dictionary compression wins, the exact dictionary bytes needed for reconstruction are embedded in the IC2 v3 manifest. Before finalizing a share, IC2.1 compares cumulative dictionary savings with the cost of embedding that dictionary. If the dictionary does not pay for itself, dictionary-coded chunks are automatically replaced with ordinary self-contained fallback representations.

A recipient therefore never needs the sender's IndexedDB database or the repository knowledge pack to decode an already-created IC2 share.

## Encoder

The encoder reads the source as a stream and uses content-defined chunking with versioned parameters: 16 KiB minimum, 64 KiB target, 256 KiB maximum. For each chunk it can choose:

- deterministic recipes: zero, constant byte, repeating pattern up to 256 bytes, or byte counter;
- repeated-unit run or backward reference to an identical earlier chunk;
- XOR or prefix/suffix delta against a similar recent chunk;
- adaptive Zstandard dictionary compression when it is measurably worthwhile;
- ordinary Zstandard compression through a pinned browser WASM dependency;
- gzip fallback;
- raw bytes when compression does not help.

Every unit stores SHA-256 and the manifest stores SHA-256 of the complete source file. Reconstruction verifies both.

## Public knowledge trainer

A Windows-friendly trainer is available under `tools/` and can also be run directly with Python 3. It produces:

`ic2-public-knowledge.json`

Upload that file to the repository root and commit it. GitHub Pages will serve it automatically and IC2.1 will begin using it as a public baseline without any server-side component.

The trainer supports a bounded curated public corpus from Internet Archive, Wikimedia Commons and Project Gutenberg, plus explicitly supplied public GitHub repositories, Hugging Face repositories, HTTP directory indexes, public S3 bucket listings and direct URL lists.

Generic directory crawling is opt-in: the trainer only crawls `--open-dir` roots explicitly supplied by the operator. Local folders are excluded from publishable packs unless `--include-local-in-public-pack` is deliberately provided.

### Windows quick start

Run:

`tools\train_ic2_public.cmd`

Or:

`py -3 tools\train_ic2_knowledge.py --public-pack --output ic2-public-knowledge.json`

Optional examples:

`--github-repo owner/repo`

`--hf-repo dataset:owner/repo`

`--open-dir https://example.org/public/`

`--s3-list https://bucket.s3.amazonaws.com/`

`--url-list urls.txt`

### Privacy warning

Knowledge dictionaries contain literal byte fragments. Do not create a public pack from private or sensitive local files unless those fragments are safe to publish. The default public-pack workflow does not include local files.

## Local learning

The browser stores only small samples and aggregate profile statistics, not whole source files. Samples are capped and pruned. The UI exposes local and public knowledge statistics separately, and Clear local knowledge removes only the private IndexedDB layer.

There is also an opt-in **Train from Archive.org** browser control. It samples a small number of Project Gutenberg text derivatives and stores those samples only in local IndexedDB. It does not modify the repository-wide public pack.

Normal file sharing still works with both knowledge layers absent.

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
