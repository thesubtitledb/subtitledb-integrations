/**
 * The worker entry. One script, two roles, picked by the first message: `asr` runs
 * whisper.cpp, `audio` reads and decodes the media. The main thread spawns one
 * audio worker and a small pool of ASR workers from this same file.
 */
import { AudioRole } from '../audio/audio-role.js';
import { AsrRole } from './asr-role.js';
import type { FromAsr, FromAudio, ToAsr, ToAudio } from './protocol.js';

type Role = { handle(m: ToAsr & ToAudio): Promise<void> | void };

let role: Role | null = null;

const post = (m: FromAsr | FromAudio, transfer: Transferable[] = []) => {
  (self as unknown as Worker).postMessage(m, transfer);
};

self.onmessage = (ev: MessageEvent<ToAsr | ToAudio>) => {
  const m = ev.data;
  if (!role) {
    if (m.type !== 'init') {
      post({ type: 'error', message: 'first message must be init' });
      return;
    }
    role = (m.role === 'asr' ? new AsrRole(post) : new AudioRole(post)) as unknown as Role;
  }
  void role.handle(m as ToAsr & ToAudio);
};
