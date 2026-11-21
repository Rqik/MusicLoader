import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const fixtureDirectory = fileURLToPath(new URL('../tests/fixtures/hls/', import.meta.url));
const mimeType = 'audio/mp4;codecs=mp4a.40.2';

function readBoxes(buffer) {
  const boxes = [];
  let offset = 0;
  while (offset < buffer.length) {
    assert.ok(offset + 8 <= buffer.length, `Incomplete box header at ${offset}`);
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      assert.ok(offset + 16 <= buffer.length, `Incomplete extended box header at ${offset}`);
      const extendedSize = buffer.readBigUInt64BE(offset + 8);
      assert.ok(extendedSize <= BigInt(Number.MAX_SAFE_INTEGER));
      size = Number(extendedSize);
      headerSize = 16;
    } else if (size === 0) {
      size = buffer.length - offset;
    }
    assert.ok(size >= headerSize, `Invalid ${type} box size ${size}`);
    assert.ok(offset + size <= buffer.length, `${type} box exceeds file boundary`);
    boxes.push({ type, size, bytes: buffer.subarray(offset, offset + size) });
    offset += size;
  }
  assert.equal(offset, buffer.length);
  return boxes;
}

function splitRecording(recording) {
  const boxes = readBoxes(recording);
  const firstFragment = boxes.findIndex((box) => box.type === 'moof');
  assert.ok(firstFragment > 0, 'MediaRecorder must produce fragmented MP4');
  const initBoxes = boxes.slice(0, firstFragment).filter((box) => box.type === 'ftyp' || box.type === 'moov');
  assert.deepEqual(initBoxes.map((box) => box.type), ['ftyp', 'moov']);
  const segments = [];
  let fragment = [];
  let prefix = [];
  function finishFragment() {
    if (fragment.length === 0) return;
    assert.equal(fragment.filter((box) => box.type === 'moof').length, 1);
    assert.ok(fragment.some((box) => box.type === 'mdat'), 'A fragment must contain encoded audio');
    segments.push(Buffer.concat(fragment.map((box) => box.bytes)));
    fragment = [];
  }
  for (const box of boxes.slice(firstFragment)) {
    if (box.type === 'moof') {
      finishFragment();
      fragment = [...prefix, box];
      prefix = [];
    } else if (box.type === 'mdat') {
      assert.ok(fragment.some((item) => item.type === 'moof'));
      fragment.push(box);
    } else if (box.type === 'styp' || box.type === 'sidx') {
      prefix.push(box);
    } else {
      assert.ok(box.type === 'mfra' || box.type === 'free', `Unexpected top-level box: ${box.type}`);
    }
  }
  finishFragment();
  assert.equal(prefix.length, 0, 'Unexpected trailing segment prefix');
  assert.ok(segments.length > 0);
  return { init: Buffer.concat(initBoxes.map((box) => box.bytes)), segments };
}

const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Own synthetic AAC fixture generator</title>');
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

let browser;
try {
  browser = await chromium.launch({
    channel: process.env.MUSICLOADER_BROWSER_CHANNEL ?? 'chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const recorded = await page.evaluate(async (type) => {
    if (!MediaRecorder.isTypeSupported(type)) throw new Error(`MediaRecorder does not support ${type}`);
    if (!MediaSource.isTypeSupported(type)) throw new Error(`MediaSource does not support ${type}`);
    const audioContext = new AudioContext({ sampleRate: 48000 });
    await audioContext.resume();
    const oscillator = audioContext.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = 440;
    const gain = audioContext.createGain();
    gain.gain.value = 0.03;
    const destination = audioContext.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination);
    const recorder = new MediaRecorder(destination.stream, { mimeType: type, audioBitsPerSecond: 64000 });
    const chunks = [];
    const stopped = new Promise((resolve, reject) => {
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
      recorder.onerror = (event) => reject(new Error(event.error?.message ?? 'MediaRecorder error'));
      recorder.onstop = resolve;
    });
    oscillator.start();
    recorder.start(200);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    recorder.stop();
    oscillator.stop();
    await stopped;
    for (const track of destination.stream.getTracks()) track.stop();
    await audioContext.close();
    const blob = new Blob(chunks, { type });
    return {
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      chunks: chunks.length,
      mimeType: recorder.mimeType,
      userAgent: navigator.userAgent,
    };
  }, mimeType);

  const { init, segments } = splitRecording(Buffer.from(recorded.bytes));
  const playback = await page.evaluate(async ({ type, initialization, fragments }) => {
    const audio = document.createElement('audio');
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    audio.src = objectUrl;
    document.body.append(audio);
    const opened = new Promise((resolve) => mediaSource.addEventListener('sourceopen', resolve, { once: true }));
    await opened;
    const sourceBuffer = mediaSource.addSourceBuffer(type);
    async function append(bytes) {
      await new Promise((resolve, reject) => {
        sourceBuffer.addEventListener('updateend', resolve, { once: true });
        sourceBuffer.addEventListener('error', () => reject(new Error('MSE rejected fixture bytes')), { once: true });
        sourceBuffer.appendBuffer(new Uint8Array(bytes));
      });
    }
    await append(initialization);
    const bufferedEnds = [];
    for (const fragment of fragments) {
      await append(fragment);
      bufferedEnds.push(sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1));
    }
    mediaSource.endOfStream();
    const ended = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('AAC playback did not end')), 10000);
      audio.addEventListener('ended', () => { clearTimeout(timer); resolve(); }, { once: true });
      audio.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`AAC decode error ${audio.error?.code}: ${audio.error?.message}`));
      }, { once: true });
    });
    await audio.play();
    await ended;
    const result = { duration: audio.duration, currentTime: audio.currentTime, bufferedEnds, ended: audio.ended };
    URL.revokeObjectURL(objectUrl);
    audio.remove();
    return result;
  }, { type: mimeType, initialization: [...init], fragments: segments.map((segment) => [...segment]) });
  assert.ok(playback.ended);
  assert.ok(playback.duration > 0.5 && playback.duration < 2);
  assert.ok(playback.currentTime >= playback.duration - 0.05);

  await mkdir(fixtureDirectory, { recursive: true });
  for (const file of await readdir(fixtureDirectory)) {
    if (/^segment\d+\.m4s$/.test(file)) await unlink(path.join(fixtureDirectory, file));
  }
  const files = [{ name: 'init.mp4', bytes: init }, ...segments.map((bytes, index) => ({ name: `segment${index}.m4s`, bytes }))];
  for (const file of files) await writeFile(path.join(fixtureDirectory, file.name), file.bytes);
  const details = files.map((file) => ({
    name: file.name,
    bytes: file.bytes.length,
    boxes: readBoxes(file.bytes).map((box) => `${box.type}:${box.size}`),
  }));
  const table = details.map((file) => `| \`${file.name}\` | ${file.bytes} | ${file.boxes.join(', ')} |`).join('\n');
  const durations = playback.bufferedEnds.map((end, index) => Number((end - (playback.bufferedEnds[index - 1] ?? 0)).toFixed(6)));
  const readme = `# Own synthetic AAC / fragmented MP4 fixture

These files contain a locally generated 440 Hz sine tone (gain 0.03), created with Web Audio and encoded with Chrome MediaRecorder. No microphone, third-party music, network media, account data or copyrighted recording was used. The fixture was generated for this project's tests and may be reused and regenerated with the project.

Codec: \`${mimeType}\`, requested sample rate 48000 Hz, requested bitrate 64000 bit/s. Recording time: approximately 1 second; MediaRecorder timeslice: 200 ms. Actual MSE duration: **${playback.duration.toFixed(6)} s**. Segment durations derived from MSE buffered ends: ${durations.map((duration) => `${duration.toFixed(6)} s`).join(', ')}.

The init file contains ftyp + moov. Each media segment contains a real moof + mdat fragment. Every top-level ISO BMFF box size and file boundary was validated. Chrome appended init and all segments to an AAC MediaSource SourceBuffer, decoded and played the full recording to the ended event without a media error. These are clear, unencrypted source bytes; encryption for a test must use generated copies, leaving these originals unchanged.

| File | Bytes | Top-level boxes (type:size) |
| --- | ---: | --- |
${table}

Reproduce from the project root after installing dependencies:

\`\`\`sh
node scripts/generate-hls-fixture.mjs
\`\`\`

Requires installed Chrome with AAC MediaRecorder support. The generator uses a fresh headless browser context and a temporary loopback HTTP origin, then closes both. Override the channel with MUSICLOADER_BROWSER_CHANNEL if needed. Regeneration can change encoded bytes, segment counts and duration slightly because MediaRecorder timing is not byte-deterministic.

Generated with: ${recorded.userAgent}
`;
  await writeFile(path.join(fixtureDirectory, 'README.md'), readme);
  console.log(JSON.stringify({ ...playback, segmentDurations: durations, recorderChunks: recorded.chunks, files: details }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
