// src/application/voice/audioDeviceService.ts — 设备选择：枚举 → 校验 → 持久化 → 读回（热拔插 → 稳定失败，绝不静默换设备）
import type { AudioDeviceProbePort, AudioDeviceSettingsPort } from '../../domain/voice/audioDevice.js';
import type { OperationResult } from '../../protocol/results.js';

const failed = (code: string, details?: Record<string, unknown>): OperationResult<never> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export class AudioDeviceService {
  constructor(
    private readonly probe: AudioDeviceProbePort,
    private readonly settings: AudioDeviceSettingsPort,
  ) {}

  async listInputs(): Promise<OperationResult<{ devices: Awaited<ReturnType<AudioDeviceProbePort['enumerate']>> }>> {
    try {
      return { ok: true, value: { devices: (await this.probe.enumerate()).filter(device => device.kind === 'input') } };
    } catch {
      return failed('VOICE_DEVICE_ENUMERATION_FAILED');
    }
  }

  async selectInput(id: string): Promise<OperationResult<{ selectedId: string }>> {
    const listed = await this.listInputs();
    if (!listed.ok) return listed;
    const selected = listed.value.devices.find(device => device.id === id && device.state === 'active');
    if (!selected) return failed('VOICE_DEVICE_INVALID_SELECTION', { selectedId: id });
    try {
      await this.settings.writeSelectedInput(selected.id);
      const readBack = await this.settings.readSelectedInput();
      if (readBack !== selected.id) return failed('VOICE_DEVICE_PERSISTENCE_FAILED', { selectedId: id, readBack });
      return { ok: true, value: { selectedId: selected.id } };
    } catch {
      return failed('VOICE_DEVICE_PERSISTENCE_FAILED', { selectedId: id });
    }
  }

  async readSelection(): Promise<OperationResult<{ selectedId: string | null }>> {
    try { return { ok: true, value: { selectedId: await this.settings.readSelectedInput() } }; }
    catch { return failed('VOICE_DEVICE_PERSISTENCE_FAILED'); }
  }

  async assertSelectedDevicePresent(): Promise<OperationResult<{ selectedId: string | null }>> {
    const selected = await this.settings.readSelectedInput();
    if (!selected) return { ok: true, value: { selectedId: null } };
    const listed = await this.listInputs();
    if (!listed.ok) return listed;
    const present = listed.value.devices.some(device => device.id === selected && device.state === 'active');
    return present ? { ok: true, value: { selectedId: selected } } : failed('VOICE_DEVICE_DISCONNECTED', { selectedId: selected });
  }
}
