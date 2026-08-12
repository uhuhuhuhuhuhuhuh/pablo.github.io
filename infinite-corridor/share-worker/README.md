# Infinite Corridor public share registry

This Worker implements collision-safe short public pointers for Infinite Corridor.

Public URLs use:

```text
https://<worker-or-custom-domain>/f/<base58-pointer>/<filename.ext>
```

Example:

```text
https://corridor.example/f/7Kq3mP4QaWx/cheeseburger.mkv
```

The registry stores manifests, not conventional uploaded files. A manifest can point to either:

- a literal Babel `/.../file` path, which is self-reconstructing;
- an `ICXL1:` or legacy `ICFMT1:` deterministic recipe.

`ICFILE1:` locators are rejected because a content hash by itself cannot reconstruct an arbitrary source file.

## Collision and overlap handling

Pointers start at 12 Base58 characters. The D1 schema has two independent uniqueness constraints:

- `id` is the primary key;
- `fingerprint` is unique for the complete canonical manifest.

Creation uses `INSERT OR IGNORE` atomically. If two unrelated requests happen to select the same pointer, the losing request cannot overwrite the existing record and retries with a new random pointer. If two identical requests race, the unique manifest fingerprint allows both callers to converge on the same stored pointer. After every eight true ID collisions the generated pointer widens by two characters. Creation stops after 24 attempts rather than ever overwriting an existing pointer.

## Deploy

Install Wrangler, create D1, copy the example configuration, apply the schema, and deploy:

```bash
cd infinite-corridor/share-worker
npm install -g wrangler
wrangler login
wrangler d1 create infinite-corridor-share
cp wrangler.toml.example wrangler.toml
```

Put the returned D1 `database_id` into `wrangler.toml`, then run:

```bash
wrangler d1 execute infinite-corridor-share --remote --file=./schema.sql
wrangler deploy
```

Set `APP_URL` to the GitHub Pages Infinite Corridor root and `ALLOWED_ORIGIN` to the GitHub Pages origin. If a custom Worker domain is assigned, optionally set `PUBLIC_BASE_URL` to that origin so generated links use it.

After deployment, open Infinite Corridor → **Public Share**, paste the Worker HTTPS origin into **Share Worker URL**, and save it in the browser. The endpoint is stored only in localStorage.

## API

### `POST /api/shares`

```json
{
  "filename": "example.pdf",
  "mime": "application/pdf",
  "size": 55878,
  "kind": "babel",
  "payload": "/AA/.../file",
  "sha256": "optional-64-character-hex-digest"
}
```

Response:

```json
{
  "id": "7Kq3mP4QaWx",
  "url": "https://corridor.example/f/7Kq3mP4QaWx/example.pdf",
  "deduplicated": false,
  "idAttempts": 1
}
```

### `GET /api/shares/:id`

Returns the manifest required by `share.html` to reconstruct or reopen the object.

### `GET /f/:id/:filename`

Canonical public share link. The Worker verifies the pointer and filename, increments its hit counter, and redirects to the GitHub Pages resolver with the Worker origin carried in the query string.
