/** The embind surface of wasm/subbot.cpp. Everything answers JSON text. */
export interface SubbotModule {
  /** Grow the heap once to hold `bytes` more, before a load. */
  reserve(bytes: number): boolean;
  load_model(bytes: Uint8Array, flashAttn: boolean): boolean;
  load_vad(bytes: Uint8Array): boolean;
  vad(audio: Float32Array, optsJson: string): string;
  transcribe(audio: Float32Array, optsJson: string): string;
  detect_language(audio: Float32Array): string;
  info(): string;
  free_all(): void;
  set_verbose(v: boolean): void;
  onSegment?: (json: string) => void;
  onProgress?: (percent: number) => void;
  onLog?: (text: string) => void;
}

export interface SubbotInit {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}

export default function createSubbot(init?: SubbotInit): Promise<SubbotModule>;
