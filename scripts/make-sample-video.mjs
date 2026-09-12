#!/usr/bin/env node
/**
 * Produce examples/media/sample.webm, the placeholder clip the example pages play.
 *
 * There is no video file in this repo and no ffmpeg dependency to make one. Chromium
 * is already a dependency, for Playwright, and it can record a canvas, so the clip is
 * generated rather than committed: a few seconds of a real, decodable stream with a
 * duration and keyframes, which is what the players that need loaded media before
 * they accept a text track are actually waiting for.
 *
 * Idempotent. Skips when the file is already there, so `npm run vendor` stays fast.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'examples', 'media', 'sample.webm');

// Long enough for the first cue of a real subtitle to fall inside the clip: the
// e2e suite seeks to it and asserts the browser has it on screen, which is the only
// check that a player has not quietly hidden the track again.
const SECONDS = 15;

async function exists(p) {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

if (await exists(out)) {
  console.log('sample.webm already present');
  process.exit(0);
}

const { chromium } = await import('@playwright/test');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const base64 = await page.evaluate(async (seconds) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(12);

    const type = ['video/webm;codecs=vp8', 'video/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    if (!type) throw new Error('this Chromium cannot record webm');

    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 120_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise((r) => {
      recorder.onstop = r;
    });
    recorder.start();

    const frames = seconds * 12;
    for (let i = 0; i < frames; i++) {
      ctx.fillStyle = `hsl(${(i * 360) / frames} 45% 22%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '28px sans-serif';
      ctx.fillText(`${(i / 12).toFixed(2)}s`, 24, 48);
      await new Promise((r) => setTimeout(r, 1000 / 12));
    }

    recorder.stop();
    await stopped;

    const blob = new Blob(chunks, { type: 'video/webm' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return btoa(s);
  }, SECONDS);

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 1024) throw new Error(`recording produced only ${bytes.length} bytes`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, bytes);
  console.log(`wrote examples/media/sample.webm (${bytes.length} bytes)`);
} finally {
  await browser.close();
}
