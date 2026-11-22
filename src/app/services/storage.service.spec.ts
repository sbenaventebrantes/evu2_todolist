import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FILESYSTEM_PLUGIN } from '../tokens/device.tokens';

import { AppStorage, CapacitorStorageService } from './storage.service';

const preferencesMock = vi.hoisted(() => {
  const values = new Map<string, string>();

  return {
    values,
    get: vi.fn(async ({ key }: { key: string }) => ({ value: values.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      values.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      values.delete(key);
    }),
    setMany: vi.fn(async () => {
      throw new Error('Preferences.setMany() is not implemented');
    }),
  };
});

vi.mock('@capacitor/preferences', () => ({ Preferences: preferencesMock }));

describe('CapacitorStorageService', () => {
  let service: CapacitorStorageService;
  let filesystem: {
    writeFile: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    deleteFile: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    localStorage.clear();
    preferencesMock.values.clear();
    vi.clearAllMocks();
    preferencesMock.get.mockImplementation(async ({ key }) => ({ value: preferencesMock.values.get(key) ?? null }));
    preferencesMock.set.mockImplementation(async ({ key, value }) => {
      preferencesMock.values.set(key, value);
    });
    preferencesMock.remove.mockImplementation(async ({ key }) => {
      preferencesMock.values.delete(key);
    });
    filesystem = {
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(async () => ({ data: 'base64-image' })),
      deleteFile: vi.fn(async () => undefined),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: AppStorage, useClass: CapacitorStorageService },
        { provide: FILESYSTEM_PLUGIN, useValue: filesystem },
      ],
    });

    service = TestBed.inject(CapacitorStorageService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('persists and reads JSON values from localStorage on web', async () => {
    await service.set('tasks:user-a', [{ id: 'task-1' }]);

    expect(await service.get('tasks:user-a')).toEqual([{ id: 'task-1' }]);
    expect(localStorage.getItem('tasks:user-a')).toBe('[{"id":"task-1"}]');
  });

  it('returns null for missing or invalid stored data', async () => {
    localStorage.setItem('invalid', '{no-json');

    expect(await service.get('missing')).toBeNull();
    expect(await service.get('invalid')).toBeNull();
  });

  it('removes stored values', async () => {
    await service.set('queue:user-a', []);
    await service.remove('queue:user-a');

    expect(await service.get('queue:user-a')).toBeNull();
  });

  it('reads, writes and removes native values through Preferences', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);

    await service.set('tasks:user-a', { title: 'Nativa' });

    expect(preferencesMock.set).toHaveBeenCalledWith({ key: 'tasks:user-a', value: '{"title":"Nativa"}' });
    expect(await service.get('tasks:user-a')).toEqual({ title: 'Nativa' });
    expect(preferencesMock.get).toHaveBeenCalledWith({ key: 'tasks:user-a' });

    await service.remove('tasks:user-a');

    expect(preferencesMock.remove).toHaveBeenCalledWith({ key: 'tasks:user-a' });
    expect(await service.get('tasks:user-a')).toBeNull();
  });

  it('surfaces failed native reads instead of treating them as empty data', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    preferencesMock.get.mockRejectedValueOnce(new Error('falló la lectura nativa'));

    await expect(service.get('tasks:user-a')).rejects.toThrow('No se pudo leer la información del dispositivo.');
  });

  it('surfaces failed web reads instead of treating them as empty data', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('falló la lectura web');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    });

    await expect(service.get('tasks:user-a')).rejects.toThrow('No se pudo leer la información del dispositivo.');
  });

  it('writes a web batch with all values and restores previous values when a write fails', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    const stored = new Map<string, string>([['tasks:user-a', 'anterior']]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === 'queue:user-a') {
          throw new Error('falló la escritura');
        }

        stored.set(key, value);
      },
      removeItem: (key: string) => {
        stored.delete(key);
      },
      clear: () => {
        stored.clear();
      },
    });

    await expect(
      service.setMany([
        { key: 'tasks:user-a', value: [{ id: 'task-1' }] },
        { key: 'queue:user-a', value: [{ id: 'op-1' }] },
      ]),
    ).rejects.toThrow('No se pudo guardar la información en el dispositivo.');

    expect(stored.get('tasks:user-a')).toBe('anterior');
    expect(stored.has('queue:user-a')).toBe(false);
  });

  it('writes web batches successfully as a single operation', async () => {
    await service.setMany([
      { key: 'tasks:user-a', value: [{ id: 'task-1' }] },
      { key: 'queue:user-a', value: [] },
      { key: 'lastSync:user-a', value: '2026-01-01T00:00:00.000Z' },
    ]);

    expect(await service.get('tasks:user-a')).toEqual([{ id: 'task-1' }]);
    expect(await service.get('queue:user-a')).toEqual([]);
    expect(await service.get('lastSync:user-a')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('writes native batches sequentially and restores previous values after a write fails', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    preferencesMock.values.set('tasks:user-a', 'anterior');
    preferencesMock.set.mockImplementation(async ({ key, value }) => {
      if (key === 'queue:user-a') {
        throw new Error('falló la escritura nativa');
      }

      preferencesMock.values.set(key, value);
    });

    await expect(
      service.setMany([
        { key: 'tasks:user-a', value: [{ id: 'task-1' }] },
        { key: 'queue:user-a', value: [] },
      ]),
    ).rejects.toThrow('No se pudo guardar la información en el dispositivo.');

    expect(preferencesMock.set).toHaveBeenCalledTimes(3);
    expect(preferencesMock.values.get('tasks:user-a')).toBe('anterior');
    expect(preferencesMock.values.has('queue:user-a')).toBe(false);
  });

  it('writes native values even when the bridge exposes a wrapper for an unsupported method', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);

    await service.setMany([
      { key: 'tasks:user-a', value: [{ id: 'task-1' }] },
      { key: 'queue:user-a', value: [] },
    ]);

    expect(preferencesMock.setMany).not.toHaveBeenCalled();
    expect(await service.get('tasks:user-a')).toEqual([{ id: 'task-1' }]);
    expect(await service.get('queue:user-a')).toEqual([]);
  });

  it('stores web photos as data URLs in localStorage', async () => {
    const photo = await service.savePhoto('base64-image', 'image/png');

    expect(photo.mimeType).toBe('image/png');
    expect(photo.dataUrl).toBe('data:image/png;base64,base64-image');
    expect(await service.readPhoto(photo)).toBe('data:image/png;base64,base64-image');
    await expect(service.deletePhoto(photo)).resolves.toBeUndefined();
  });

  it('writes, reads and deletes native photos in the app data directory', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);

    const photo = await service.savePhoto('base64-image', 'image/jpeg');

    expect(filesystem.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ data: 'base64-image', recursive: true }),
    );
    expect(photo.path).toMatch(/^tasks\/photo-.*\.jpg$/);
    await expect(service.readPhoto(photo)).resolves.toBe('data:image/jpeg;base64,base64-image');
    await service.deletePhoto(photo);

    expect(filesystem.deleteFile).toHaveBeenCalledWith({ path: photo.path, directory: 'DATA' });
  });
});
