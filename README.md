# DEAD DROP

LSB steganography lab for PNG carriers. Hide a text message or a binary file (mp3, image, pdf, zip…) in the least-significant bits of R/G/B, optionally wrapping the payload with local OpenSSL first.

This is a training terminal, not a covert-comms kit. JPEG/WebP can be loaded as a source, but export is always lossless PNG.

## Dependencies

- **Node.js** 22+ (ES modules, `DecompressionStream`)
- **npm** (comes with Node)
- **OpenSSL** 3.x on `PATH` (`openssl enc`) for the optional cipher catalog and encrypt/decrypt pipe
- A current desktop browser (Chrome, Firefox, or similar)

Optional:

- An **OpenAI API key** if you want **GPT GEN** to paint carrier images (`gpt-image-1`, falling back to `dall-e-3`)

Runtime npm packages are only the Vite/TypeScript toolchain (`vite`, `typescript`, `@types/node`). There is no separate backend process: the Vite plugin serves `/api/crypt`, `/api/gpt-image`, and `/api/library`.

## Install

```bash
git clone https://github.com/freddythunder/stegano.git
cd stegano
npm install
```

## Run

```bash
npm run dev
```

or `./startthis`.

Vite listens on **http://localhost:5173/** (`host: true`, so other interfaces work too). The hostname `lucca` is allowed if you open it that way.

Other scripts:

| Command        | What it does                          |
|----------------|----------------------------------------|
| `npm test`     | LSB roundtrip checks                   |
| `npm run build`| Typecheck + production build           |
| `npm run preview` | Serve the production build          |

## GPT image key (optional)

The server reads the key from `/home/freddythunder/creds` (not from the repo). Add a `[stegano]` block; the first non-comment line is the key:

```ini
[stegano]
sk-...your-openai-key...
```

Do not commit that file.

## Layout

| Path               | Role |
|--------------------|------|
| `images/source/`   | Carriers (GPT, SYNTH, loads, resizes). Duplicates with the same name, size, and payload are skipped. |
| `images/output/`   | Stego PNGs written on **EMBED**. |
| `payloads/`        | Scratch tray for files you plan to hide (not auto-loaded). |
| `src/`             | Browser UI + LSB engine |
| `server/`          | Vite plugin: OpenSSL, GPT, on-disk library |

Generated PNGs under `images/source/` and `images/output/` are gitignored except for files already tracked.

## Basic use

1. Load a carrier: local PNG, URL, clipboard, **SYNTH SAT**, **GPT GEN**, or **LIB**.
2. Set **W×H** (16–4096) before synth/GPT. **SNAP** copies the current size; **RESIZE** resamples (this destroys any hidden payload).
3. Choose **bits/channel** (1 is nearly invisible) and RGB channels. Alpha is never touched.
4. Payload:
   - **MSG** — type text. Empty key = cleartext in the LSBs.
   - **BIN** — load a file. A small `DDFILE` header plus the raw bytes go into the image.
   - **GPT** — prompt, then **GPT GEN** to make a carrier; switch back to MSG or BIN to embed.
5. Optional **CIPHER** + **KEY** runs `openssl enc` (`-a -A -pbkdf2 -iter 10000`) before embed / after extract.
6. **EMBED** writes LSBs and shelves a copy in `images/output/`. **EXPORT PNG** downloads it. **EXTRACT** reads the frame back.
7. **LIB** browses source/output. Opening an output still reconstructs a hidden file on the **BIN** tab (player for audio, preview for images/PDF) and keeps the DDFILE + hex dump.

Frame format: magic `DDRP` + 32-bit big-endian length + payload bytes, walking pixels left-to-right, top-to-bottom. Extract must use the same bits, channels, cipher, and key as embed.

**INFO** in the header is a longer field manual.
