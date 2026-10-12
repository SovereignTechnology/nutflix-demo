# ffmpeg for the real-ffmpeg test suite

The media pipeline shells out to an external `ffmpeg` and `ffprobe` (ADR 0003, spike S-C:
`bare-ffmpeg` has no H.264 encoder, no faststart, no seek). **The desktop app does not bundle
ffmpeg**: Studio uses the system one (ADR 0005). The binary is never committed and never placed in
`node_modules`; the pipeline takes its path as injected config (`MediaPipelineDeps.binaries`), so a
system package, a shipped binary or the pinned test build below are only different values.

This file pins the build that the **real-ffmpeg test suite**
(`src/media/__tests__/node-real-ffmpeg.test.ts`) was verified against. With no binary present
those tests are skipped, not failed.

## The current pin

BtbN deletes its daily `autobuild-*` releases after about twelve days and keeps one month-end
snapshot per month. An earlier pin (`autobuild-2026-09-04-14-01`) was gone within a day, so a pin
must be a **month-end** build.

| Field                              | Value                                                                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release tag                        | `autobuild-2026-08-31-13-27` (month-end, so long-lived)                                                                                                                |
| Asset                              | `ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1.tar.xz`                                                                                                                  |
| URL                                | https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1.tar.xz                                |
| ffmpeg version string              | `n8.1.2-50-g1a748fe2cd-20260831`                                                                                                                                       |
| Tarball sha256                     | `c733b4b2951e5957e15505f788b2c65a7a41b6da4b289e295852cc38079b4d2b`                                                                                                     |
| Upstream `checksums.sha256` sha256 | `5a831b23711edf09476291bfbb104cc4e9c78ab6d9a3978ff27da1ee76b01c5b`                                                                                                     |
| `bin/ffmpeg` sha256                | `ad7a8c8e8fe4f50972f32f63705cfcc57f44cd3531f57aa8defe388372242f5e`                                                                                                     |
| `bin/ffprobe` sha256               | `150bfd75016992a8d495a5f5c16cd93387a21c059f4309ed1e6342659aef48b3`                                                                                                     |
| Size                               | 125,758,156 bytes (the tar.xz)                                                                                                                                         |
| Verified (2026-09-05)              | Three ways: the release's own `checksums.sha256`, the GitHub API asset `digest` field, and `ffmpeg -version`. The real-ffmpeg suite passed (10 tests).                 |

It is the same FFmpeg revision as the earlier pin (`n8.1.2-50-g1a748fe2cd`): BtbN rebuilds the same
source daily, so the binaries differ byte for byte while the version string differs only in its
date suffix.

## Install for tests (no root)

```sh
mkdir -p ~/ffmpeg-pin && cd ~/ffmpeg-pin
T=autobuild-2026-08-31-13-27
A=ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1.tar.xz
curl -sSLO "https://github.com/BtbN/FFmpeg-Builds/releases/download/$T/$A"
curl -sSLO "https://github.com/BtbN/FFmpeg-Builds/releases/download/$T/checksums.sha256"
grep " $A\$" checksums.sha256 | sha256sum -c -      # must print OK
tar -xJf "$A"
export NUTFLIX_FFMPEG=~/ffmpeg-pin/ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1
```

**When this pin is eventually pruned too:** pick the newest month-end tag from
`curl -s 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases?per_page=100'`, verify the
tarball against that release's own `checksums.sha256` **and** the API `digest`, run the real-ffmpeg
suite, and update the table. Do not switch to `latest`: it is a moving pointer and defeats a pin.

## Resolution order (`findFfmpeg()` in `media/node/find-ffmpeg.ts`)

1. `NUTFLIX_FFMPEG`: the path to the `ffmpeg` binary, or a directory containing `ffmpeg` (or
   `bin/ffmpeg`). `ffprobe` must sit beside it.
2. A fixed scratch directory, `/tmp/opencode/ffmpeg/`, left over from the original development
   setup. Prefer step 1.
3. `PATH`.

Test input is synthesised at test time with `-f lavfi testsrc` and `sine`; no media is committed.

## Facts verified against this build (the pipeline depends on them)

- `ffprobe -print_format json -show_format -show_streams`: numbers arrive as strings
  (`"duration": "3.000000"`, `"sample_rate": "44100"`), rotation is in
  `streams[].side_data_list[].rotation` (`side_data_type: "Display Matrix"`).
- `-progress pipe:2` emits `out_time_us=`, `out_time_ms=` (both microseconds), `out_time=`,
  `fps=`, `progress=continue|end`.
- `-movflags +faststart` yields `ftyp moov free mdat`; the default muxer yields `ftyp free mdat
  moov` (moov last). The pipeline verifies by box order, not by flag.
- `-force_key_frames expr:gte(t,n_forced*2)` + `-g/-keyint_min` + `-sc_threshold 0` gives
  keyframes at exactly 0 s, 2 s, 4 s on every rendition (checked with `-skip_frame nokey`).
- `-map 0:a:0?` lets silent sources encode without an audio stream.

## Licensing

This is a **GPL** build (it includes `libx264`), used only to run the tests. ffmpeg is not shipped
in the desktop app. If a future release bundles one, the choice of an LGPL build with
`libopenh264` is open; nothing in the pipeline depends on it, because the binaries are injected
(`binaries`).
