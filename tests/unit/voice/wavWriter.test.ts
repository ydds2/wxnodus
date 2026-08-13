// tests/unit/voice/wavWriter.test.ts — W3-03：WAV 编解码往返 + 非法头稳定失败
import { describe, expect, it } from 'vitest';
import { decodeWavHeader, decodeWavSamples, encodeWav } from '../../../src/infrastructure/voice/wavWriter.js';

describe('wavWriter', () => {
  it('round-trips mono 16-bit PCM and parses the exact header', () => {
    const samples = Int16Array.from([0, 1000, -1000, 32000, -32000]);
    const buffer = encodeWav(samples, { sampleRate: 16000, channels: 1, bitsPerSample: 16 });
    expect(buffer.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buffer.toString('ascii', 8, 12)).toBe('WAVE');
    const header = decodeWavHeader(buffer);
    expect(header).toMatchObject({
      ok: true,
      value: { format: { sampleRate: 16000, channels: 1, bitsPerSample: 16 }, dataOffset: 44, dataBytes: 10, sampleCount: 5 },
    });
    const decoded = decodeWavSamples(buffer);
    expect(decoded.ok && decoded.value[0]).toEqual(samples);
  });

  it('interleaves stereo channels deterministically', () => {
    const left = Int16Array.from([1, 2, 3]);
    const right = Int16Array.from([4, 5, 6]);
    const buffer = encodeWav([left, right], { sampleRate: 8000, channels: 2, bitsPerSample: 16 });
    const decoded = decodeWavSamples(buffer);
    expect(decoded.ok && decoded.value[0]).toEqual(left);
    expect(decoded.ok && decoded.value[1]).toEqual(right);
  });

  it('fails closed with VOICE_WAV_INVALID_HEADER on malformed input', () => {
    for (const bad of [
      Buffer.alloc(0),
      Buffer.alloc(43),
      Buffer.concat([Buffer.from('NOPE'), Buffer.alloc(40)]),
      Buffer.from('RIFFxxxxWAVEfmt ', 'ascii'),
    ]) {
      expect(decodeWavHeader(bad)).toMatchObject({ ok: false, error: { code: 'VOICE_WAV_INVALID_HEADER' } });
    }
    // data 块尺寸与实际字节不符 → 非法（44 头 + 6 数据 = 50；截到 49 少 1 字节）
    const truncated = encodeWav(Int16Array.from([1, 2, 3]), { sampleRate: 16000, channels: 1, bitsPerSample: 16 }).subarray(0, 49);
    expect(decodeWavHeader(truncated)).toMatchObject({ ok: false, error: { code: 'VOICE_WAV_INVALID_HEADER' } });
  });
});
