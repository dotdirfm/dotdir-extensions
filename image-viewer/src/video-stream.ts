import { createFile, type MP4BoxBuffer } from 'mp4box';

const CHUNK = 512 * 1024;
const STREAMABLE_EXTS = new Set(['mp4', 'm4v', 'mov']);

export function isStreamable(ext: string): boolean {
  return STREAMABLE_EXTS.has(ext) && typeof MediaSource !== 'undefined';
}

type ReadRange = (offset: number, length: number) => Promise<ArrayBuffer>;

// ---------------------------------------------------------------------------
// Probe the top-level MP4 atoms to find moov/mdat order.
// Returns atoms seen up to (and including) whichever of moov/mdat comes first.
// ---------------------------------------------------------------------------
interface Atom { type: string; offset: number; size: number }

async function probeAtoms(readRange: ReadRange, fileSize: number): Promise<Atom[]> {
  const buf = await readRange(0, Math.min(4096, fileSize));
  const view = new DataView(buf);
  const atoms: Atom[] = [];
  let pos = 0;

  while (pos + 8 <= buf.byteLength) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(
      view.getUint8(pos + 4), view.getUint8(pos + 5),
      view.getUint8(pos + 6), view.getUint8(pos + 7),
    );

    if (size === 1 && pos + 16 <= buf.byteLength) {
      const hi = view.getUint32(pos + 8);
      const lo = view.getUint32(pos + 12);
      size = hi * 0x100000000 + lo;
    } else if (size === 0) {
      size = fileSize - pos;
    }

    atoms.push({ type, offset: pos, size });
    if (type === 'moov' || type === 'mdat') break;
    if (size < 8) break;
    pos += size;
  }
  return atoms;
}

// ---------------------------------------------------------------------------
// Streaming video player: mp4box.js + MediaSource
// ---------------------------------------------------------------------------
export function streamVideo(
  video: HTMLVideoElement,
  readRange: ReadRange,
  fileSize: number,
): () => void {
  const mp4 = createFile();
  const ms = new MediaSource();
  let destroyed = false;
  let loadGen = 0;
  let allLoaded = false;
  let streamEnd = fileSize;          // upper bound for sequential load

  let sb: SourceBuffer | null = null;
  const queue: ArrayBuffer[] = [];

  video.src = URL.createObjectURL(ms);

  // -- helpers ---------------------------------------------------------------

  function feed(buf: ArrayBuffer, fileStart: number) {
    const b = buf as MP4BoxBuffer;
    b.fileStart = fileStart;
    mp4.appendBuffer(b);
  }

  /** Read [start, end) and feed each chunk to mp4box. No loadGen tracking. */
  async function feedRange(start: number, end: number) {
    let pos = start;
    while (pos < end && !destroyed) {
      const len = Math.min(CHUNK, end - pos);
      const buf = await readRange(pos, len);
      if (destroyed) return;
      feed(buf, pos);
      pos += buf.byteLength;
    }
  }

  /** Sequentially load [offset, streamEnd) with cancellation support. */
  async function load(offset: number) {
    const gen = ++loadGen;
    allLoaded = false;

    while (offset < streamEnd && !destroyed && gen === loadGen) {
      const len = Math.min(CHUNK, streamEnd - offset);
      const buf = await readRange(offset, len);
      if (destroyed || gen !== loadGen) return;
      feed(buf, offset);
      offset += buf.byteLength;
    }

    if (!destroyed && gen === loadGen) {
      mp4.flush();
      allLoaded = true;
      tryEnd();
    }
  }

  function tryEnd() {
    if (!allLoaded || ms.readyState !== 'open') return;
    if (sb?.updating || queue.length > 0) return;
    try { ms.endOfStream(); } catch { /* already ended */ }
  }

  function enqueue(buf: ArrayBuffer) {
    queue.push(buf);
    drain();
  }

  function drain() {
    if (!sb || sb.updating || queue.length === 0 || destroyed) return;
    try { sb.appendBuffer(queue.shift()!); } catch { /* quota */ }
  }

  // -- mp4box callbacks ------------------------------------------------------

  mp4.onReady = (info) => {
    const codecs: string[] = [];
    const trackIds: number[] = [];

    for (const t of info.videoTracks) { codecs.push(t.codec); trackIds.push(t.id); }
    for (const t of info.audioTracks) { codecs.push(t.codec); trackIds.push(t.id); }
    if (codecs.length === 0) return;

    const mime = `video/mp4; codecs="${codecs.join(', ')}"`;
    if (!MediaSource.isTypeSupported(mime)) return;

    sb = ms.addSourceBuffer(mime);
    sb.addEventListener('updateend', () => { drain(); tryEnd(); });

    for (const id of trackIds) mp4.setSegmentOptions(id, null, { nbSamples: 500 });

    const initSeg = mp4.initializeSegmentation();
    enqueue(initSeg.buffer);
    mp4.start();
  };

  mp4.onSegment = (_id, _user, buffer) => {
    if (!destroyed) enqueue(buffer);
  };

  // -- seeking ---------------------------------------------------------------

  const onSeeking = () => {
    if (destroyed) return;
    const { offset } = mp4.seek(video.currentTime, true);
    if (sb) {
      try { if (sb.updating) sb.abort(); } catch { /* noop */ }
      queue.length = 0;
    }
    load(offset);
  };
  video.addEventListener('seeking', onSeeking);

  // -- sourceopen: probe structure, then start loading -----------------------

  ms.addEventListener('sourceopen', async () => {
    if (destroyed) return;
    try {
      const atoms = await probeAtoms(readRange, fileSize);
      if (destroyed) return;

      const moovFound = atoms.some(a => a.type === 'moov');
      const mdatAtom = atoms.find(a => a.type === 'mdat');

      if (moovFound) {
        // Faststart (moov before mdat) — stream the whole file sequentially
        load(0);
      } else if (mdatAtom && mdatAtom.size > 0) {
        // Non-faststart (mdat before moov).
        // Feed the header (ftyp etc.) + tail (moov etc.) first so mp4box
        // can parse the metadata, then stream mdat for media data.
        const mdatEnd = mdatAtom.offset + mdatAtom.size;
        if (mdatEnd < fileSize) {
          // 1) Feed atoms before mdat (ftyp, free, …)
          if (mdatAtom.offset > 0) {
            await feedRange(0, mdatAtom.offset);
            if (destroyed) return;
          }
          // 2) Feed everything after mdat (moov + trailing atoms)
          await feedRange(mdatEnd, fileSize);
          if (destroyed) return;
          // 3) Now stream mdat — mp4box already has metadata
          streamEnd = mdatEnd;
          load(mdatAtom.offset);
        }
        // else: mdat extends to EOF → no moov found → timeout fallback
      }
      // else: unusual structure → timeout fallback
    } catch {
      // probe failed → timeout fallback
    }
  });

  // -- cleanup ---------------------------------------------------------------

  return function destroy() {
    destroyed = true;
    video.removeEventListener('seeking', onSeeking);
    try { mp4.flush(); } catch { /* noop */ }
    if (video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
    queue.length = 0;
  };
}
