// src/infrastructure/voice/wavWriter.ts — 纯 WAV 容器编解码（16-bit PCM，RIFF/fmt/data）：独立可测，无任何设备 IO
import type { OperationResult } from '../../protocol/results.js';

export interface WavFormat { sampleRate: number; channels: 1 | 2; bitsPerSample: 16 }
export interface WavHeaderInfo { format: WavFormat; dataOffset: number; dataBytes: number; sampleCount: number }

const failed = (code: string): OperationResult<never> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false },
});

export function encodeWav(channelSamples: Int16Array | Int16Array[], format: WavFormat): Buffer {
  const channels = Array.isArray(channelSamples) ? channelSamples : [channelSamples];
  const frameCount = channels[0].length;
  const dataBytes = frameCount * channels.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);            // fmt 块长
  buffer.writeUInt16LE(1, 20);             // PCM
  buffer.writeUInt16LE(format.channels, 22);
  buffer.writeUInt32LE(format.sampleRate, 24);
  buffer.writeUInt32LE(format.sampleRate * format.channels * 2, 28); // byteRate
  buffer.writeUInt16LE(format.channels * 2, 32);                     // blockAlign
  buffer.writeUInt16LE(format.bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < channels.length; channel++) {
      buffer.writeInt16LE(channels[channel][frame] ?? 0, 44 + (frame * channels.length + channel) * 2);
    }
  }
  return buffer;
}

export function decodeWavHeader(buffer: Buffer): OperationResult<WavHeaderInfo> {
  if (buffer.byteLength < 44) return failed('VOICE_WAV_INVALID_HEADER');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return failed('VOICE_WAV_INVALID_HEADER');
  if (buffer.toString('ascii', 12, 16) !== 'fmt ') return failed('VOICE_WAV_INVALID_HEADER');
  const formatTag = buffer.readUInt16LE(20);
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  if (formatTag !== 1 || (channels !== 1 && channels !== 2) || bitsPerSample !== 16 || sampleRate < 1) return failed('VOICE_WAV_INVALID_HEADER');
  if (buffer.toString('ascii', 36, 40) !== 'data') return failed('VOICE_WAV_INVALID_HEADER');
  const dataBytes = buffer.readUInt32LE(40);
  const blockAlign = channels * 2;
  if (dataBytes % blockAlign !== 0 || buffer.byteLength < 44 + dataBytes) return failed('VOICE_WAV_INVALID_HEADER');
  return { ok: true, value: { format: { sampleRate, channels: channels as 1 | 2, bitsPerSample: 16 }, dataOffset: 44, dataBytes, sampleCount: dataBytes / blockAlign } };
}

export function decodeWavSamples(buffer: Buffer): OperationResult<Int16Array[]> {
  const header = decodeWavHeader(buffer);
  if (!header.ok) return header;
  const { format, dataOffset, sampleCount } = header.value;
  const channels: Int16Array[] = Array.from({ length: format.channels }, () => new Int16Array(sampleCount));
  for (let frame = 0; frame < sampleCount; frame++) {
    for (let channel = 0; channel < format.channels; channel++) {
      channels[channel][frame] = buffer.readInt16LE(dataOffset + (frame * format.channels + channel) * 2);
    }
  }
  return { ok: true, value: channels };
}
