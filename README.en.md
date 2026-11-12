# dsh-maa-coverocr

[![npm](https://img.shields.io/npm/v/dsh-maa-coverocr.svg)](https://www.npmjs.com/package/dsh-maa-coverocr)
[![license](https://img.shields.io/npm/l/dsh-maa-coverocr.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

[简体中文](README.md) | English

A companion for [dsh-maa-cli](https://github.com/nhyo/dsh-maa-cli). It searches Bilibili for *Arknights* stage guides, or inspects supplied video links, recognizes operators shown on cover images, and lets dsh-maa-cli compare them with your operator Box. Every recommendation must retain its corresponding video URL.

It never requests a playback URL, downloads a video stream, watches the video, or operates the game.

## Install

In a DSH conversation:

```text
/maa ext install coverocr
```

Or manually:

```text
dsh plugin --profile <profile> add dsh-maa-coverocr
```

## Search and recognition

Ask DSH to “find a TL-EX-8 guide on Bilibili”. The plugin searches only for “Arknights + stage” (for example, `明日方舟 TL-EX-8`), returns at most five candidates with their video URLs, and reads only metadata and cover images. It persists and reuses the anonymous device identity and WBI cache under `~/.dsh-maa-coverocr`, and sends all Bilibili requests through one serialized queue at a default interval of 800–1300 ms.

On the first `-352`, `-412`, or `-509` from a signed request, it refreshes WBI and retries exactly once. A repeated failure starts a persistent 10/30/60/120-minute cooldown that survives DSH restarts. Errors identify the exact stage that failed.

Cover text is recognized with the PaddleOCR models already included in the user's MAA runtime. A recognized squad screen is compared with the Box by ownership only; one missing operator can be borrowed as support.

## Limitations

- Search depends on Bilibili's undocumented web endpoints and may require updates when the web protocol changes.
- Cover-only recognition cannot recover operators that are absent from the cover and may be incomplete or wrong.
- A text-free illustration cover usually yields no lineup.
- The installed package is about 300 MB because `onnxruntime-node` includes native runtimes; OCR models are reused from MAA.

## Service API (version 2)

The Cordis service is named `maaCoverocr` and exposes `searchVideos(...)`, `analyzeVideo(...)`, `bilibiliStatus()`, and `setBilibiliCookie(...)`. An optional login cookie is stored only in the local private session file and is never returned by the status method. Search results use the same analysis shape as direct-link results.

## Development

```text
npm install
npm test
```

## License

MIT
