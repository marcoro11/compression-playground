# Compression Playground

A workbench for squeezing bits. Step through the algorithms inside ZIP, PNG, GIF, bzip2 and JPEG one
decision at a time — the merge that builds a Huffman tree, the match a sliding window finds, the
interval an arithmetic coder zooms into, every field of a real gzip stream.

Nothing here is a mock-up. Every lossless coder on the site produces the actual bitstream it
describes, headers and tables included, and decodes it back. The DEFLATE exhibit writes streams your
browser's own decompressor accepts; the JPEG exhibit writes a baseline `.jpg` your browser decodes.

```bash
npm install && npm run dev
```

Then open http://localhost:5173. Every step-through is driven with <kbd>←</kbd> <kbd>→</kbd>,
<kbd>Home</kbd>/<kbd>End</kbd> and <kbd>space</kbd>, and narrates what each step just did. Anything
with a `?` next to it explains itself.

## The exhibits

**The floor**

| | What you do | What you see |
|---|---|---|
| **How Low Can It Go** | Type text; play Shannon's guessing game; try to beat the pigeonhole | Every character shaded by its surprisal −log₂p, the entropy sum built term by term, conditional entropy for 0–3 characters of context (with a warning when the input is too short to trust it), and a live demonstration that random bytes don't shrink |
| **Run-Length Encoding** | Paint a 1-bit picture; or feed it bytes | Fax-style alternating runs costed with fixed fields against ITU T.4 Modified Huffman codes; naive ⟨count, byte⟩ pairs doubling plain text, against Apple's PackBits |

**Entropy coders**

| | What you do | What you see |
|---|---|---|
| **Huffman Coding** | Build the tree merge by merge, then encode and decode through it | The queue as a shrinking forest, the bits each merge costs, tree codes vs canonical codes, and the length cap solved optimally by package-merge |
| **Arithmetic Coding** | Zoom into the interval with exact fractions, then watch a 16-bit integer coder do it for real | Nested intervals, settled bits, the E1/E2/E3 renormalisation with pending bits — and the *Skewed* sample at ~0.6 bits/symbol where Huffman must spend 1 |
| **Asymmetric Numeral Systems** | Push symbols onto one big integer, then run rANS with renormalisation and tANS as a state table | The state's log₂ tracking the ideal code length step for step, why encoding runs backwards, Zstandard's FSE spread — with rANS and tANS codecs on the bench |
| **Integer Codes** | Write a number in unary, Elias γ/δ/ω, Fibonacci, Golomb–Rice, Exp-Golomb and LEB128 | Each code's prefix and payload, length against log₂n, expected length under geometric/Zipf/uniform sources, and the optimal Golomb parameter |

**Dictionary coders**

| | What you do | What you see |
|---|---|---|
| **LZ77** | Slide the window over your text, as triples or LZSS | Each match drawn back to its source, overlapping copies that turn into runs, a decoder copying byte by byte |
| **LZW** | Watch the phrasebook grow, then rebuild it from codes alone | The table and code width growing, the decoder lagging one step, and the KwKwK case where it must use a code it has not defined yet |

**Predict, then code the surprise**

| | What you do | What you see |
|---|---|---|
| **Prediction by Partial Matching** | Step through the context ladder, order k down to −1, escape by escape | Count tables, escape methods A–D, exclusion, what the model expects next — and an order-5 codec that beats DEFLATE on every text sample |
| **PNG Filters** | Pick a pixel and watch five predictors guess it; switch filters per row | Residual images, the Paeth decision, byte histograms collapsing towards zero, and a real `.png` written with this site's DEFLATE |
| **Lossless Audio** | Predict a waveform sample by sample with FLAC's fixed predictors and LPC | Residuals far smaller than the signal, Levinson–Durbin, partitioned Rice codes, and gzip failing on the same PCM |

**Real formats**

| | What you do | What you see |
|---|---|---|
| **DEFLATE** | Encode tokens, or parse the stream bit by bit like an inflater | A from-scratch RFC 1951 encoder: hash-chain LZ77 with lazy matching, stored/fixed/dynamic blocks, the three-layer Huffman header, every bit coloured by meaning, a hex dump of the gzip file — then your browser's `DecompressionStream` decodes it |
| **Burrows–Wheeler** | Sort the rotations, invert with the LF mapping, move-to-front, run-code the zeros | Why sorting by right-context makes runs, and the order-0 entropy dropping through the bzip2 pipeline |
| **The Bench** | Run every codec on one input, a file of your own, or the whole sample set | Real sizes with tables and headers, round-trip ticks, timings, and your browser's own DEFLATE as a reference row |

**Throwing things away**

| | What you do | What you see |
|---|---|---|
| **JPEG** | Pick an 8×8 block and step it through the pipeline; drag the quality | DCT, quantization, zigzag and the Annex K Huffman codes with real bit counts, the 64 basis patterns, blocking and ringing — and a real baseline `.jpg` decoded by your browser |
| **Wavelets** | Lift a row through Haar and CDF 5/3 by hand, then decompose the whole image | The Mallat mosaic, wavelet vs 8×8 DCT at the same bit budget (and the image where the DCT wins), a rate–distortion curve, and the integer 5/3 giving back every pixel |
| **Palettes & Dithering** | Shrink an image to N colours with median cut or k-means; dither it | Boxes splitting in a draggable 3-D colour cube, Floyd–Steinberg's error arrows pixel by pixel, Bayer and Atkinson — and why dithering looks better but compresses worse |

## Verifying it

```bash
npm run verify            # everything
npm run verify deflate    # one exhibit folder
```

Two kinds of checks:

1. **Round trips.** Every `src/exhibits/<x>/codec.ts` exports its codecs, and each one is run over
   the corpus in `src/lib/samples.ts` — empty input, one byte, 70 000 zeros, repeated prose, random
   bytes, a mixed 40 KB file — and must decode to the exact input.
2. **Independent answers.** Every `*.verify.ts` pins its algorithm against something that existed
   before this repo:
   - DEFLATE: Node's zlib inflates our raw, zlib and gzip output for every block type, and our
     inflater decodes zlib's at levels 0–9 and its `HUFFMAN_ONLY` / `RLE` / `FIXED` strategies.
     CRC-32 and Adler-32 against their published check values.
   - Huffman: the RFC 1951 §3.2.2 canonical-code example; package-merge against exhaustive search.
   - LZW: the textbook `TOBEORNOTTOBEORTOBEORNOT` code sequence.
   - PackBits: Apple's Technical Note TN1023 vector, both directions.
   - BWT: `banana$ → annb$aa`, and the fast prefix-doubling sort against sorting every rotation.
   - Arithmetic: the exact interval for a hand-worked example, and output length within two bits of
     −log₂ P(message).
   - JPEG: the zigzag table of T.81 Figure A.6, the DCT against the standard's double sum, the IJG
     quality scaling against Annex K, and a separate parser that reads our `.jpg` back.
   - PNG: Paeth against the spec's pseudocode on all 256³ inputs; our `.png` files decoded by an
     independent reader (Node's zlib for CRCs and inflate).
   - PPM: the classic *abracadabra* context tables, and every model state's probabilities summing to
     exactly 1 in rational arithmetic.
   - ANS: a hand-worked rANS example, and the tANS spread visiting every state once.
   - Wavelets: a hand-worked CDF 5/3 example, the lifting code against the long-hand formulas of
     ITU T.800, exact integer round trips, Parseval for Haar.
   - Palettes: Bayer matrices against the bit-interleave formula; error diffusion conserving error.
   - Integer codes and FLAC: published codewords (Elias, Fibonacci, Exp-Golomb, LEB128), Levinson–
     Durbin against a direct solve, Rice parameters against brute force.

CI runs typecheck and the full verify before every deploy, so a wrong bit fails the build instead of
shipping.

## How it is put together

Vite + React + TypeScript, no runtime dependencies beyond React, hash routing so the whole site is a
static bundle.

```
src/
  lib/          bit I/O (MSB and LSB order, with labelled spans), Huffman (tree, package-merge,
                canonical codes), entropy, samples, the step-player hook
  ui/           page frame, controls, the transport bar, the byte tape and bit row
  exhibits/
    meta.ts     titles, taglines, accents — the index page and nav read this
    <slug>/     one folder per exhibit: the page, its algorithm, codec.ts, <slug>.verify.ts
```

The Bench finds codecs with `import.meta.glob('../*/codec.ts')`, the same files the verify script
round-trips, so adding a coder means adding one folder.

The look is a technical manual marked up with a highlighter: compression is mostly about pointing at
text you already have, and a highlighter on a printout is how you would mark that up by hand. Colours
mean the same thing on every page, and everything follows the system light/dark setting.

## Deploying to GitHub Pages

The workflow in `.github/workflows/deploy.yml` typechecks, runs `npm run verify`, builds with
`BASE_PATH=/<repo-name>/` and publishes `dist/` to Pages on every push to `main` (or by hand from the
Actions tab).

One-time setup: in the repository on GitHub, **Settings → Pages → Build and deployment → Source:
GitHub Actions**. After the first successful run the site is at
`https://<user>.github.io/compression-playground/`.

To try the production build locally:

```bash
npm run build && npm run preview
```
