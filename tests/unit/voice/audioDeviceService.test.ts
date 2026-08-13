// tests/unit/voice/audioDeviceService.test.ts — W3-03 Step 1：设备选择/持久化/热拔插契约（计划原文）
import { describe, expect, it } from 'vitest';
import { AudioDeviceService } from '../../../src/application/voice/audioDeviceService.js';
import type { AudioDeviceSnapshot } from '../../../src/domain/voice/audioDevice.js';

const microphone = (id: string, name: string): AudioDeviceSnapshot => ({
  id, name, kind: 'input', backend: 'windows-mmdevice', state: 'active', isDefault: id === 'mic-1',
});

class MemorySettings {
  value: string | null = null;
  async readSelectedInput(): Promise<string | null> { return this.value; }
  async writeSelectedInput(id: string): Promise<void> { this.value = id; }
}

class MutableProbe {
  devices = [microphone('mic-1', 'Desk Mic'), microphone('mic-2', 'USB Mic')];
  async enumerate(): Promise<AudioDeviceSnapshot[]> { return this.devices.map(device => ({ ...device })); }
}

describe('AudioDeviceService', () => {
  it('enumerates, selects, rejects invalid IDs, persists, and reads selection back', async () => {
    const probe = new MutableProbe();
    const settings = new MemorySettings();
    const first = new AudioDeviceService(probe, settings);

    await expect(first.listInputs()).resolves.toMatchObject({ ok: true, value: { devices: [{ id: 'mic-1' }, { id: 'mic-2' }] } });
    await expect(first.selectInput('missing')).resolves.toMatchObject({
      ok: false,
      error: { code: 'VOICE_DEVICE_INVALID_SELECTION' },
    });
    await expect(first.selectInput('mic-2')).resolves.toMatchObject({ ok: true, value: { selectedId: 'mic-2' } });

    const restarted = new AudioDeviceService(probe, settings);
    await expect(restarted.readSelection()).resolves.toMatchObject({ ok: true, value: { selectedId: 'mic-2' } });
  });

  it('turns hot unplug into a stable failure and does not silently pick another device', async () => {
    const probe = new MutableProbe();
    const settings = new MemorySettings();
    const service = new AudioDeviceService(probe, settings);
    await service.selectInput('mic-2');
    probe.devices = [microphone('mic-1', 'Desk Mic')];

    await expect(service.assertSelectedDevicePresent()).resolves.toMatchObject({
      ok: false,
      error: { code: 'VOICE_DEVICE_DISCONNECTED', details: { selectedId: 'mic-2' } },
    });
    expect(settings.value).toBe('mic-2');
  });
});
