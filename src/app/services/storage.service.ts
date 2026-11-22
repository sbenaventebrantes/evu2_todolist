import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Directory } from '@capacitor/filesystem';
import type { PreferencesPlugin } from '@capacitor/preferences';

import type { TaskPhoto } from '../models/task.model';
import { FILESYSTEM_PLUGIN } from '../tokens/device.tokens';
import { createId } from '../utils/task.utils';

export interface StorageEntry {
  key: string;
  value: unknown;
}

type SerializedEntry = { key: string; value: string };

export abstract class AppStorage {
  abstract get<T>(key: string): Promise<T | null>;
  abstract set<T>(key: string, value: T): Promise<void>;
  abstract setMany(entries: StorageEntry[]): Promise<void>;
  abstract remove(key: string): Promise<void>;
  abstract savePhoto(base64: string, mimeType: string): Promise<TaskPhoto>;
  abstract readPhoto(photo: TaskPhoto): Promise<string>;
  abstract deletePhoto(photo: TaskPhoto): Promise<void>;
}

@Injectable({ providedIn: 'root' })
export class CapacitorStorageService extends AppStorage {
  private readonly filesystem = inject(FILESYSTEM_PLUGIN);

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.readRaw(key);

    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.setMany([{ key, value }]);
  }

  async setMany(entries: StorageEntry[]): Promise<void> {
    try {
      const serialized = entries.map(({ key, value }) => {
        const raw = JSON.stringify(value);

        if (typeof raw !== 'string') {
          throw new Error('El valor no se puede guardar en el dispositivo.');
        }

        return { key, value: raw };
      });

      if (serialized.length === 0) {
        return;
      }

      if (Capacitor.isNativePlatform()) {
        const { Preferences } = await import('@capacitor/preferences');
        await this.writeNativeBatch(serialized, Preferences);
      } else {
        this.writeWebBatch(serialized);
      }
    } catch (error) {
      throw new Error('No se pudo guardar la información en el dispositivo.', { cause: error });
    }
  }

  async remove(key: string): Promise<void> {
    try {
      if (Capacitor.isNativePlatform()) {
        const { Preferences } = await import('@capacitor/preferences');
        await Preferences.remove({ key });
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      throw new Error('No se pudo borrar la información del dispositivo.');
    }
  }

  async savePhoto(base64: string, mimeType: string): Promise<TaskPhoto> {
    const extension = mimeType.includes('png') ? 'png' : 'jpg';
    const name = `${createId('photo')}.${extension}`;
    const path = `tasks/${name}`;

    try {
      if (Capacitor.isNativePlatform()) {
        await this.filesystem.writeFile({
          path,
          data: base64,
          directory: Directory.Data,
          recursive: true,
        });
        return { path, name, mimeType };
      }

      return { path, name, mimeType, dataUrl: `data:${mimeType};base64,${base64}` };
    } catch {
      throw new Error('No se pudo guardar la foto en el almacenamiento persistente.');
    }
  }

  async readPhoto(photo: TaskPhoto): Promise<string> {
    if (photo.dataUrl) {
      return photo.dataUrl;
    }

    try {
      const result = await this.filesystem.readFile({ path: photo.path, directory: Directory.Data });
      return typeof result.data === 'string'
        ? `data:${photo.mimeType};base64,${result.data}`
        : URL.createObjectURL(result.data);
    } catch {
      throw new Error('No se pudo leer la foto guardada.');
    }
  }

  async deletePhoto(photo: TaskPhoto): Promise<void> {
    if (photo.dataUrl) {
      return;
    }

    try {
      await this.filesystem.deleteFile({ path: photo.path, directory: Directory.Data });
    } catch {
      throw new Error('No se pudo eliminar la foto del dispositivo.');
    }
  }

  private async readRaw(key: string): Promise<string | null> {
    try {
      if (Capacitor.isNativePlatform()) {
        const { Preferences } = await import('@capacitor/preferences');
        return (await Preferences.get({ key })).value;
      }

      return localStorage.getItem(key);
    } catch (error) {
      throw new Error('No se pudo leer la información del dispositivo.', { cause: error });
    }
  }

  private async writeNativeBatch(entries: SerializedEntry[], preferences: PreferencesPlugin): Promise<void> {
    const previous = await Promise.all(entries.map((entry) => preferences.get({ key: entry.key })));
    const applied: number[] = [];

    try {
      for (const [index, entry] of entries.entries()) {
        await preferences.set(entry);
        applied.push(index);
      }
    } catch (error) {
      for (const index of applied) {
        const value = previous[index]?.value ?? null;

        if (value === null) {
          await preferences.remove({ key: entries[index].key });
        } else {
          await preferences.set({ key: entries[index].key, value });
        }
      }

      throw error;
    }
  }

  private writeWebBatch(entries: SerializedEntry[]): void {
    const previous = entries.map((entry) => localStorage.getItem(entry.key));
    const applied: number[] = [];

    try {
      for (const [index, entry] of entries.entries()) {
        localStorage.setItem(entry.key, entry.value);
        applied.push(index);
      }
    } catch (error) {
      for (const index of applied) {
        const value = previous[index];

        if (value === null) {
          localStorage.removeItem(entries[index].key);
        } else {
          localStorage.setItem(entries[index].key, value);
        }
      }

      throw error;
    }
  }
}
