import { Buffer } from 'node:buffer';
import { TextDecoder, TextEncoder } from 'node:util';
import { PROTOCOL_VERSION } from './constants';
import type { Frame } from './types';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const FRAME_KIND_JSON = 0;
const FRAME_KIND_STREAM_DATA = 1;
const FRAME_KIND_UDP_DATA = 2;

export type ParsedFrame =
  | { kind: 'json'; frame: Frame }
  | { kind: 'stream-data'; streamId: string; data: Uint8Array }
  | { kind: 'udp-data'; sessionId: string; data: Uint8Array };

function wrapFrame(payload: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + payload.length);
  new DataView(output.buffer).setUint32(0, payload.length, false);
  output.set(payload, 4);
  return output;
}

function encodeIdAndData(kind: number, id: string, data: Uint8Array): Uint8Array {
  const idBytes = textEncoder.encode(id);
  const payload = new Uint8Array(1 + 2 + idBytes.length + 4 + data.length);
  const view = new DataView(payload.buffer);
  payload[0] = kind;
  view.setUint16(1, idBytes.length, false);
  payload.set(idBytes, 3);
  const dataOffset = 3 + idBytes.length;
  view.setUint32(dataOffset, data.length, false);
  payload.set(data, dataOffset + 4);
  return wrapFrame(payload);
}

export function encodeFrame(frame: Frame): Uint8Array {
  const envelope = JSON.stringify({ v: PROTOCOL_VERSION, ...frame });
  const body = textEncoder.encode(envelope);
  const payload = new Uint8Array(1 + body.length);
  payload[0] = FRAME_KIND_JSON;
  payload.set(body, 1);
  return wrapFrame(payload);
}

export function encodeStreamDataFrame(streamId: string, data: Uint8Array): Uint8Array {
  return encodeIdAndData(FRAME_KIND_STREAM_DATA, streamId, data);
}

export function encodeUdpDataFrame(sessionId: string, data: Uint8Array): Uint8Array {
  return encodeIdAndData(FRAME_KIND_UDP_DATA, sessionId, data);
}

export class FrameParser {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): ParsedFrame[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const frames: ParsedFrame[] = [];
    while (this.buffer.length >= 4) {
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength).getUint32(0, false);
      if (this.buffer.length < 4 + length) break;
      const raw = this.buffer.slice(4, 4 + length);
      this.buffer = this.buffer.slice(4 + length);
      if (!raw.length) continue;

      const kind = raw[0];
      if (kind === FRAME_KIND_JSON || kind === 0x7b) {
        const jsonBytes = kind === FRAME_KIND_JSON ? raw.subarray(1) : raw;
        try {
          const parsed = JSON.parse(textDecoder.decode(jsonBytes)) as Frame;
          if (parsed && typeof parsed.type === 'string') {
            frames.push({ kind: 'json', frame: parsed });
          }
        } catch {
          // Ignore malformed frames.
        }
        continue;
      }

      if (kind !== FRAME_KIND_STREAM_DATA && kind !== FRAME_KIND_UDP_DATA) continue;
      if (raw.length < 1 + 2 + 4) continue;
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const idLen = view.getUint16(1, false);
      const idStart = 3;
      const idEnd = idStart + idLen;
      if (raw.length < idEnd + 4) continue;
      const dataLen = view.getUint32(idEnd, false);
      const dataStart = idEnd + 4;
      if (raw.length < dataStart + dataLen) continue;
      const id = textDecoder.decode(raw.subarray(idStart, idEnd));
      const data = raw.subarray(dataStart, dataStart + dataLen);
      if (kind === FRAME_KIND_STREAM_DATA) {
        frames.push({ kind: 'stream-data', streamId: id, data });
      } else {
        frames.push({ kind: 'udp-data', sessionId: id, data });
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