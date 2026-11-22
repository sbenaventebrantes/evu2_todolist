import { computed, signal, type Signal, type WritableSignal } from '@angular/core';
import { of, throwError, type Observable } from 'rxjs';
import { vi, type Mock } from 'vitest';

import type { AuthUser } from '../models/auth.model';
import type { ImportResult, TaskListResponse } from '../models/sync.model';
import type { Task, TaskPhoto } from '../models/task.model';
import type { AppStorage } from '../services/storage.service';

export const TEST_USER: AuthUser = {
  id: 'user-a',
  email: 'ana@ejemplo.test',
  name: 'Ana',
};

export const TEST_SECOND_USER: AuthUser = {
  id: 'user-b',
  email: 'bruno@ejemplo.test',
  name: 'Bruno',
};

export const TEST_SERVER_TIME = '2026-01-01T00:00:00.000Z';

export interface StorageDouble {
  values: Map<string, unknown>;
  failNextWrite(): void;
  get: Mock;
  set: Mock;
  setMany: Mock;
  remove: Mock;
  savePhoto: Mock;
  readPhoto: Mock;
  deletePhoto: Mock;
}

export interface AuthDouble {
  currentUser: WritableSignal<AuthUser | null>;
  isAuthenticated: Signal<boolean>;
  sessionReady: Signal<boolean>;
  setUser(next: AuthUser | null): void;
  login: Mock;
  register: Mock;
  logout: Mock;
  restoreSession: Mock;
}

export interface ConnectivityDouble {
  online: Signal<boolean>;
  setOnline(connected: boolean): void;
  initialize: Mock;
  isOnline: Mock;
  onStatusChange: Mock;
  dispose: Mock;
}

export interface ApiDouble {
  getTasks: Mock;
  putTask: Mock;
  deleteTask: Mock;
  importTodos: Mock;
}

export interface TokenDouble {
  token: Signal<string | null>;
  set(next: string): void;
  clear(): void;
}

export function createTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Tarea ${id}`,
    description: `Descripción de ${id}`,
    createdAt: TEST_SERVER_TIME,
    updatedAt: TEST_SERVER_TIME,
    deleted: false,
    ...overrides,
  };
}

export function createStorageDouble(): StorageDouble {
  const values = new Map<string, unknown>();
  let failNextSet = false;

  const consumeFailure = (): void => {
    if (failNextSet) {
      failNextSet = false;
      throw new Error('No se pudo guardar la información en el dispositivo.');
    }
  };

  return {
    values,
    failNextWrite: () => {
      failNextSet = true;
    },
    get: vi.fn(async <T>(key: string): Promise<T | null> => (values.get(key) as T | undefined) ?? null),
    set: vi.fn(async <T>(key: string, value: T): Promise<void> => {
      consumeFailure();
      values.set(key, value);
    }),
    setMany: vi.fn(async (entries: { key: string; value: unknown }[]): Promise<void> => {
      consumeFailure();
      const previous = new Map(values);

      try {
        for (const { key, value } of entries) {
          values.set(key, value);
        }
      } catch (error) {
        values.clear();
        for (const [key, value] of previous) {
          values.set(key, value);
        }
        throw error;
      }
    }),
    remove: vi.fn(async (key: string): Promise<void> => {
      values.delete(key);
    }),
    savePhoto: vi.fn(async (base64: string, mimeType: string): Promise<TaskPhoto> => ({
      path: `tasks/photo-${values.size}.jpg`,
      name: `photo-${values.size}.jpg`,
      mimeType,
      dataUrl: `data:${mimeType};base64,${base64}`,
    })),
    readPhoto: vi.fn(async (photo: TaskPhoto): Promise<string> => photo.dataUrl ?? ''),
    deletePhoto: vi.fn(async (_photo: TaskPhoto): Promise<void> => undefined),
  };
}

export function storageAsAppStorage(storage: StorageDouble): AppStorage {
  return storage as unknown as AppStorage;
}

export function createAuthDouble(user: AuthUser | null = null): AuthDouble {
  const currentUser = signal<AuthUser | null>(user);

  return {
    currentUser,
    isAuthenticated: computed(() => currentUser() !== null),
    sessionReady: signal(true).asReadonly(),
    setUser: (next: AuthUser | null) => currentUser.set(next),
    login: vi.fn(async () => user ?? TEST_USER),
    register: vi.fn(async () => user ?? TEST_USER),
    logout: vi.fn(async () => currentUser.set(null)),
    restoreSession: vi.fn(async () => null),
  };
}

export function createConnectivityDouble(online = true): ConnectivityDouble {
  const status = signal(online);
  const listeners = new Set<(connected: boolean) => void>();

  return {
    online: status.asReadonly(),
    setOnline: (connected: boolean) => {
      status.set(connected);
      for (const listener of listeners) {
        listener(connected);
      }
    },
    initialize: vi.fn(async () => status()),
    isOnline: vi.fn(async () => status()),
    onStatusChange: vi.fn((listener: (connected: boolean) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    dispose: vi.fn(() => listeners.clear()),
  };
}

export function createApiDouble(): ApiDouble {
  const emptyResponse: TaskListResponse = { tasks: [], serverTime: TEST_SERVER_TIME };

  return {
    getTasks: vi.fn<(since?: string | null) => Observable<TaskListResponse>>(() => of(emptyResponse)),
    putTask: vi.fn<(task: Task, _opId: string) => Observable<{ task: Task }>>((task) => of({ task })),
    deleteTask: vi.fn<(id: string, _opId: string, _deletedAt: string) => Observable<{ task: Task }>>((id) =>
      of({ task: createTask(id, { title: '', description: '', deleted: true }) }),
    ),
    importTodos: vi.fn<() => Observable<ImportResult>>(() =>
      of({ imported: [], skippedDuplicates: 0, skippedInvalid: 0, total: 0 }),
    ),
  };
}

export function createTokenDouble(token: string | null = 'token-a'): TokenDouble {
  const state = signal<string | null>(token);

  return {
    token: state.asReadonly(),
    set: (next: string) => state.set(next),
    clear: () => state.set(null),
  };
}

export function networkError(): Record<string, unknown> {
  return { status: 0, error: { error: 'No hay conexión con el servidor.' } };
}

export function conflictError(task: Task): Observable<never> {
  return throwError(() => ({
    status: 409,
    error: {
      error: 'Otra versión era más reciente.',
      details: { task },
    },
  }));
}
