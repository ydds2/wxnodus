// src/infrastructure/voice/audioDeviceSettingsRepository.ts — 选中设备持久化（dataDir JSON，原子写）
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AudioDeviceSettingsPort } from '../../domain/voice/audioDevice.js';

interface SettingsFile { schemaVersion: 1; selectedInputId: string | null }

export class AudioDeviceSettingsRepository implements AudioDeviceSettingsPort {
  constructor(private readonly filePath: string) {}

  async readSelectedInput(): Promise<string | null> {
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8')) as SettingsFile;
      return typeof data.selectedInputId === 'string' && data.selectedInputId ? data.selectedInputId : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async writeSelectedInput(id: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify({ schemaVersion: 1, selectedInputId: id } satisfies SettingsFile, null, 2), 'utf8');
    try {
      await rename(tempPath, this.filePath);
    } catch (error) {
      // Windows：目标存在时 rename 可能 EPERM/EEXIST——移除旧文件后重试（先写临时文件已保证内容完整）
      try { await rename(this.filePath, `${this.filePath}.${randomUUID()}.bak`); await rename(tempPath, this.filePath); }
      catch { throw error; }
    }
  }
}
