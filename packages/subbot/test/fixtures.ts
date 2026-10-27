import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A file under test/media as bytes. The fixtures are 20 s cuts of Sintel. */
export function media(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./media/${name}`, import.meta.url))));
}

export function mediaText(name: string): string {
  return new TextDecoder().decode(media(name));
}
