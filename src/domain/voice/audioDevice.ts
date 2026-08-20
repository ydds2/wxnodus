// src/domain/voice/audioDevice.ts — 音频设备契约：稳定 MMDevice 端点 ID 为持久身份，友好名只是展示数据
export interface AudioDeviceSnapshot {
  id: string;
  name: string;
  kind: 'input';
  backend: 'windows-mmdevice' | 'ffmpeg-dshow' | 'coreaudio' | 'pulse';
  state: 'active' | 'disabled' | 'unplugged';
  isDefault: boolean;
}
export interface AudioDeviceProbePort { enumerate(): Promise<AudioDeviceSnapshot[]> }
export interface AudioDeviceSettingsPort {
  readSelectedInput(): Promise<string | null>;
  writeSelectedInput(id: string): Promise<void>;
}
