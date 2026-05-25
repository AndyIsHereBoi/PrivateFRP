import { Buffer } from 'node:buffer';
import { TextDecoder, TextEncoder } from 'node:util';
import { PROTOCOL_VERSION } from './constants';
import type { Frame } from './types';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeFrame(frame: Frame): Uint8Array {
  const envelope = JSON.stringify({ v: PROTOCOL_VERSION, ...frame });
  const body = textEncoder.encode(envelope);
  const output = new Uint8Array(4 + body.length);
  new DataView(output.buffer).setUint32(0, body.length, false);
  output.set(body, 4);
  return output;
}

export class FrameParser {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const frames: Frame[] = [];
    while (this.buffer.length >= 4) {
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength).getUint32(0, false);
      if (this.buffer.length < 4 + length) break;
      const raw = this.buffer.slice(4, 4 + length);
      this.buffer = this.buffer.slice(4 + length);
      try {
        const parsed = JSON.parse(textDecoder.decode(raw)) as Frame;
        if (parsed && typeof parsed.type === 'string') {
          frames.push(parsed);
        }
      } catch {
        // Ignore malformed frames.
      }
    }
    return frames;
  }
}

export function encodeData(payload: Uint8Array): string {
  return Buffer.from(payload).toString('base64');
}

export function decodeData(payload: string): Uint8Array {
  return new Uint8Array(Buffer.from(payload, 'base64'));
}