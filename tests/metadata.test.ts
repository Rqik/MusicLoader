import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { isTrack, normalizeMetadata, resolveTrackIdentity } from '../src/features/player/lib/metadata';
import type { Track } from '../src/shared/types/track';

const currentTrack: Track = {
  id: null, title: 'Очень-очень', artist: 'ARTIK & ASTI', album: '#РайОдинНаДвоих', artwork: null, url: null,
};

function resolve(html: string, track = currentTrack): Track {
  const dom = new JSDOM(html, { url: 'https://zvuk.com/' });
  try { return resolveTrackIdentity(track, dom.window.document); }
  finally { dom.window.close(); }
}

describe('public Media Session metadata', () => {
  it('normalizes whitespace and keeps only requested track fields', () => {
    assert.deepEqual(normalizeMetadata({
      title: '  Очень-очень\n ', artist: ' ARTIK\t &   ASTI ', album: ' #РайОдинНаДвоих ',
      artwork: [{ src: 'https://images.example.test/cover.jpg' }], authorization: 'must not be copied',
    }), { ...currentTrack, artwork: 'https://images.example.test/cover.jpg' });
  });

  it('requires a nonempty bounded title but tolerates missing optional metadata', () => {
    for (const value of [null, [], {}, { title: ' ' }, { title: 42 }, { title: 'a'.repeat(513) }]) {
      assert.equal(normalizeMetadata(value), null);
    }
    assert.deepEqual(normalizeMetadata({ title: 'Track' }), {
      id: null, title: 'Track', artist: '', album: null, artwork: null, url: null,
    });
  });

  it('omits unsafe or signed artwork URLs without changing their resource URL', () => {
    for (const src of [
      'http://images.test/cover.jpg', 'javascript:alert(1)', 'data:image/png;base64,x', 'blob:https://zvuk.com/123',
      'https://user:password@images.test/cover', 'https://images.test/cover?token=secret', 'https://images.test/cover#secret',
    ]) {
      assert.equal(normalizeMetadata({ title: 'Track', artwork: [{ src }] })?.artwork, null, src);
    }
    assert.equal(normalizeMetadata({ title: 'Track', artwork: [{ src: 'data:x' }, { src: 'https://images.test/public.jpg' }] })?.artwork,
      'https://images.test/public.jpg');
  });

  it('preserves observed public image optimizer covers from Media Session without rewriting their parameters', () => {
    const source = 'https://cdn-image.zvuk.com/pic/medium/own-cover-fixture.jpg';
    const artwork = [280, 420, 700].map((width) => ({
      src: `https://cdn-new.zvuk.com/desktop-data/_next/image?url=${encodeURIComponent(source)}&w=${width}&q=75`,
      type: 'image/jpeg', sizes: `${width}x${width}`,
    }));
    const track = normalizeMetadata({ title: currentTrack.title, artist: currentTrack.artist, album: currentTrack.album, artwork });
    assert.equal(track?.artwork, artwork[0]!.src);
    assert.equal(isTrack(track), true);
    assert.deepEqual(Object.keys(track!).sort(), ['album', 'artist', 'artwork', 'id', 'title', 'url']);
    for (const host of ['cdn41.zvuk.com', 'cdn42.zvuk.com', 'cdn51.zvuk.com', 'cdn52.zvuk.com', 'cdn61.zvuk.com', 'cdn62.zvuk.com', 'obs-image-service-mz.obs.ru-moscow-1.hc.sbercloud.ru']) {
      const nested = `https://${host}/public/own-cover-fixture.jpg`;
      const src = `https://cdn-new.zvuk.com/desktop-data/_next/image?url=${encodeURIComponent(nested)}&w=280&q=75`;
      assert.equal(normalizeMetadata({ title: 'Track', artwork: [{ src }] })?.artwork, src);
    }
    const sameOrigin = `https://zvuk.com/_next/image?w=420&q=100&url=${encodeURIComponent(source)}`;
    assert.equal(normalizeMetadata({ title: 'Track', artwork: [{ src: sameOrigin }] })?.artwork, sameOrigin);
    assert.equal(isTrack({ ...currentTrack, artwork: sameOrigin }), true);
  });

  it('rejects optimizer impersonation, unexpected parameters and nested private or executable sources', () => {
    const source = 'https://cdn-image.zvuk.com/public/own-cover-fixture.jpg';
    const prefix = 'https://cdn-new.zvuk.com/desktop-data/_next/image';
    const valid = `${prefix}?url=${encodeURIComponent(source)}&w=280&q=75`;
    const invalid = [
      valid.replace('cdn-new.zvuk.com', 'cdn-new.zvuk.com.attacker.test'),
      valid.replace('cdn-new.zvuk.com', 'user:password@cdn-new.zvuk.com'),
      valid.replace('cdn-new.zvuk.com', 'cdn-new.zvuk.com:443'),
      valid.replace('/desktop-data/_next/image', '/other/../desktop-data/_next/image'),
      valid.replace('/desktop-data/_next/image', '/_next/image'),
      `${valid}&token=DO_NOT_STORE_SECRET`, `${valid}&w=280`, `${valid}#private`,
      valid.replace('&w=280', '&w=200'), valid.replace('&w=280', '&w=0280'),
      valid.replace('&q=75', '&q=0'), valid.replace('&q=75', '&q=101'), valid.replace('&q=75', '&q=7.5'),
      `${valid}&url=${encodeURIComponent(source)}`, `${valid}&unexpected=value`,
      `${valid}&`,
      ...[
        'https://unknown.test/cover.jpg', 'http://cdn-image.zvuk.com/cover.jpg',
        'https://user:password@cdn-image.zvuk.com/cover.jpg', 'https://cdn-image.zvuk.com:443/cover.jpg',
        'https://cdn-image.zvuk.com/cover.jpg?token=DO_NOT_STORE_SECRET', 'https://cdn-image.zvuk.com/cover.jpg#private',
        'https://cdn-image.zvuk.com/cover%00.jpg', 'https://cdn-image.zvuk.com/cover%5c.jpg',
        'https://cdn-new.zvuk.com/desktop-data/_next/image', '/static/cover.jpg',
        'data:image/png;base64,private', 'javascript:private', 'blob:https://zvuk.com/private',
      ].map((nested) => `${prefix}?url=${encodeURIComponent(nested)}&w=280&q=75`),
      `${prefix}?url=${encodeURIComponent(source.repeat(60))}&w=280&q=75`,
    ];
    for (const src of invalid) {
      assert.equal(normalizeMetadata({ title: 'Track', artwork: [{ src }] })?.artwork, null, src);
      assert.equal(isTrack({ ...currentTrack, artwork: src }), false, src);
    }
  });
});

describe('track message validation', () => {
  it('accepts normalized tracks with explicit nullable fields', () => {
    assert.equal(isTrack(currentTrack), true);
    assert.equal(isTrack({ ...currentTrack, id: '81400222', url: 'https://zvuk.com/track/81400222' }), true);
    assert.equal(isTrack({ ...currentTrack, id: '81400222' }), true);
  });

  it('rejects extra fields, inconsistent IDs, unsafe links and unnormalized text', () => {
    for (const value of [
      { ...currentTrack, cookie: 'secret' }, { ...currentTrack, id: '' }, { ...currentTrack, id: '123x' },
      { ...currentTrack, id: '1'.repeat(31) }, { ...currentTrack, title: ' Title ' }, { ...currentTrack, album: '' },
      { ...currentTrack, url: 'https://zvuk.com/track/81400222' },
      { ...currentTrack, id: '123', url: 'https://zvuk.com/track/456' },
      { ...currentTrack, id: '123', url: 'https://zvuk.com.attacker.test/track/123' },
      { ...currentTrack, id: '123', url: 'https://zvuk.com/track/123?token=secret' },
      { ...currentTrack, artwork: 'https://images.test/cover?token=secret' },
    ]) assert.equal(isTrack(value), false, JSON.stringify(value));
    const { artist: _artist, ...missingField } = currentTrack;
    assert.equal(isTrack(missingField), false);
  });
});

describe('DOM identity matching', () => {
  it('matches metadata to a track row instead of the first link', () => {
    const resolved = resolve(`
      <section><a href="/track/1">Other song</a><p>Other artist</p></section>
      <footer><div><a class="unstable_hash_123" href="/track/81400222"><p title="Очень-очень">Очень-очень</p></a></div>
      <a href="/artist/1">ARTIK &amp; ASTI</a></footer>`);
    assert.equal(resolved.id, '81400222');
    assert.equal(resolved.url, 'https://zvuk.com/track/81400222');
  });

  it('does not invent an ID when only the matching title is available', () => {
    assert.equal(resolve('<footer><a href="/track/81400222"><p title="Очень-очень">Очень-очень</p></a></footer>').id, null);
    assert.equal(resolve('<footer><a href="/track/81400222">Очень-очень</a>ARTIK &amp; ASTI</footer>', { ...currentTrack, artist: '' }).id, null);
  });

  it('uses artist evidence to distinguish different artists with the same track title', () => {
    assert.equal(resolve(`
      <article><a href="/track/9">Очень-очень</a><p>Other artist</p></article>
      <article><a href="/track/81400222">Очень-очень</a><p>ARTIK &amp; ASTI</p></article>`).id, '81400222');
  });

  it('matches widget-style inline artist names and comma spans in sibling metadata wrappers', () => {
    const resolved = resolve(`<div>
      <div><a href="/track/123"><p title="Track">Track</p></a></div>
      <div title="Alice, Bob"><a href="/artist/1">Alice</a><span>, </span><a href="/artist/2">Bob</a><span></span></div>
    </div>`, { ...currentTrack, title: 'Track', artist: 'Alice, Bob' });
    assert.equal(resolved.id, '123');
    assert.equal(resolved.artist, 'Alice, Bob');
  });

  it('normalizes artist comma whitespace on both sides without requiring a wrapper title', () => {
    const resolved = resolve(`<div>
      <div><a href="/track/123"><p title="Track">Track</p></a></div>
      <div><a href="/artist/1">Alice</a><span> , </span><a href="/artist/2">Bob</a></div>
    </div>`, { ...currentTrack, title: 'Track', artist: 'Alice ,Bob' });
    assert.equal(resolved.id, '123');
    assert.equal(resolved.artist, 'Alice ,Bob');
  });

  it('does not accept missing commas, reversed artist lists or artist-name substrings', () => {
    for (const artists of [
      '<a href="/artist/1">Alice</a><span> </span><a href="/artist/2">Bob</a>',
      '<a href="/artist/2">Bob</a><span>, </span><a href="/artist/1">Alice</a>',
      '<a href="/artist/1">Alice</a><span>, </span><a href="/artist/3">Bobby</a>',
    ]) {
      assert.equal(resolve(`<div><div><a href="/track/123"><p title="Track">Track</p></a></div><div>${artists}</div></div>`,
        { ...currentTrack, title: 'Track', artist: 'Alice, Bob' }).id, null, artists);
    }
  });

  it('keeps a comma inside a single artist name meaningful', () => {
    const track = { ...currentTrack, title: 'September', artist: 'Earth, Wind & Fire' };
    assert.equal(resolve('<div><a href="/track/123">September</a><a href="/artist/1">Earth , Wind &amp; Fire</a></div>', track).id, '123');
    assert.equal(resolve('<div><a href="/track/123">September</a><a href="/artist/1">Earth Wind &amp; Fire</a></div>', track).id, null);
  });

  it('does not change public metadata artist values or title comma matching', () => {
    const track = normalizeMetadata({ title: 'Track , title', artist: 'Alice ,Bob' });
    assert.ok(track);
    assert.equal(track.artist, 'Alice ,Bob');
    assert.equal(resolve('<div><a href="/track/123">Track, title</a><p>Alice, Bob</p></div>', track).id, null);
    const resolved = resolve('<div><a href="/track/123">Track , title</a><p>Alice, Bob</p></div>', track);
    assert.equal(resolved.id, '123');
    assert.equal(resolved.title, 'Track , title');
    assert.equal(resolved.artist, 'Alice ,Bob');
  });

  it('keeps identity unknown for ambiguous same-title same-artist tracks', () => {
    assert.equal(resolve(`
      <article><a href="/track/9">Очень-очень</a><p>ARTIK &amp; ASTI</p></article>
      <article><a href="/track/81400222">Очень-очень</a><p>ARTIK &amp; ASTI</p></article>`).id, null);
  });

  it('deduplicates repeated links to the same confirmed ID', () => {
    assert.equal(resolve(`
      <article><a href="/track/81400222">Очень-очень</a><p>ARTIK &amp; ASTI</p></article>
      <article><a href="https://zvuk.com/track/81400222">Очень-очень</a><p>ARTIK &amp; ASTI</p></article>`).id, '81400222');
  });

  it('does not borrow artist text from another playlist row or the track title itself', () => {
    assert.equal(resolve(`
      <section><div><a href="/track/81400222">Очень-очень</a></div>
      <div><a href="/track/1">Another song</a><p>ARTIK &amp; ASTI</p></div></section>`).id, null);
    assert.equal(resolve('<div><a href="/track/1">Кино</a></div>', { ...currentTrack, title: 'Кино', artist: 'Кино' }).id, null);
  });

  it('rejects unrelated hosts, malformed IDs and artist substring matches', () => {
    for (const href of ['https://evil.test/track/1', 'https://zvuk.com.attacker.test/track/1', '/track/1abc', 'http://zvuk.com/track/1']) {
      assert.equal(resolve(`<div><a href="${href}">Очень-очень</a><p>ARTIK &amp; ASTI</p></div>`).id, null, href);
    }
    assert.equal(resolve('<div><a href="/track/1">Track</a><p>Кинопрокат</p></div>', { ...currentTrack, title: 'Track', artist: 'Кино' }).id, null);
  });

  it('clears a previously resolved identity when the DOM no longer confirms it', () => {
    const resolved = resolve('', { ...currentTrack, id: '81400222', url: 'https://zvuk.com/track/81400222' });
    assert.equal(resolved.id, null);
    assert.equal(resolved.url, null);
  });
});
