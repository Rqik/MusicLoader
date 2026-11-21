# Own synthetic AAC / fragmented MP4 fixture

These files contain a locally generated 440 Hz sine tone (gain 0.03), created with Web Audio and encoded with Chrome MediaRecorder. No microphone, third-party music, network media, account data or copyrighted recording was used. The fixture was generated for this project's tests and may be reused and regenerated with the project.

Codec: `audio/mp4;codecs=mp4a.40.2`, requested sample rate 48000 Hz, requested bitrate 64000 bit/s. Recording time: approximately 1 second; MediaRecorder timeslice: 200 ms. Actual MSE duration: **0.959604 s**. Segment durations derived from MSE buffered ends: 0.234187 s, 0.213333 s, 0.213355 s, 0.213312 s, 0.085417 s.

The init file contains ftyp + moov. Each media segment contains a real moof + mdat fragment. Every top-level ISO BMFF box size and file boundary was validated. Chrome appended init and all segments to an AAC MediaSource SourceBuffer, decoded and played the full recording to the ended event without a media error. These are clear, unencrypted source bytes; encryption for a test must use generated copies, leaving these originals unchanged.

| File | Bytes | Top-level boxes (type:size) |
| --- | ---: | --- |
| `init.mp4` | 667 | ftyp:36, moov:631 |
| `segment0.m4s` | 3163 | moof:180, mdat:2983 |
| `segment1.m4s` | 2778 | moof:172, mdat:2606 |
| `segment2.m4s` | 2739 | moof:172, mdat:2567 |
| `segment3.m4s` | 2740 | moof:172, mdat:2568 |
| `segment4.m4s` | 1164 | moof:124, mdat:1040 |

Reproduce from the project root after installing dependencies:

```sh
node scripts/generate-hls-fixture.mjs
```

Requires installed Chrome with AAC MediaRecorder support. The generator uses a fresh headless browser context and a temporary loopback HTTP origin, then closes both. Override the channel with MUSICLOADER_BROWSER_CHANNEL if needed. Regeneration can change encoded bytes, segment counts and duration slightly because MediaRecorder timing is not byte-deterministic.

Generated with: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36
