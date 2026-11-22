import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingOperation } from '../models/sync.model';
import type { Task } from '../models/task.model';
import { AuthService } from '../services/auth.service';
import { ConnectivityService } from '../services/connectivity.service';
import { AppStorage } from '../services/storage.service';
import { TaskApiService } from '../services/task-api.service';
import { TokenStore } from '../services/token.store';
import {
  TEST_SECOND_USER,
  TEST_SERVER_TIME,
  TEST_USER,
  conflictError,
  createApiDouble,
  createAuthDouble,
  createConnectivityDouble,
  createStorageDouble,
  createTask,
  createTokenDouble,
  networkError,
  storageAsAppStorage,
} from '../testing/test-doubles';

import { TaskService } from './task.service';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, (event: Event) => void>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  emit(type: string, data: string): void {
    this.listeners.get(type)?.({ data } as MessageEvent<string>);
  }
}

describe('TaskService', () => {
  let service: TaskService;
  let storage: ReturnType<typeof createStorageDouble>;
  let auth: ReturnType<typeof createAuthDouble>;
  let connectivity: ReturnType<typeof createConnectivityDouble>;
  let api: ReturnType<typeof createApiDouble>;
  let token: ReturnType<typeof createTokenDouble>;

  async function settle(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  async function signIn(user = TEST_USER): Promise<void> {
    auth.setUser(user);
    await service.initialize(user.id);
    await settle();
  }

  beforeEach(() => {
    storage = createStorageDouble();
    auth = createAuthDouble();
    connectivity = createConnectivityDouble();
    api = createApiDouble();
    token = createTokenDouble();

    TestBed.configureTestingModule({
      providers: [
        { provide: AppStorage, useValue: storageAsAppStorage(storage) },
        { provide: AuthService, useValue: auth },
        { provide: ConnectivityService, useValue: connectivity },
        { provide: TaskApiService, useValue: api },
        { provide: TokenStore, useValue: token },
      ],
    });

    service = TestBed.inject(TaskService);
    FakeEventSource.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts with an empty task list after signing in', async () => {
    await signIn();

    expect(service.tasks()).toEqual([]);
    expect(service.pendingCount()).toBe(0);
  });

  it('adds a task, generates a unique id and persists it for the signed-in user', async () => {
    await signIn();

    const first = await service.addTask({ title: '  Comprar pan  ', description: '  Pasar por la panadería  ' });
    const second = await service.addTask({ title: 'Estudiar', description: 'Repasar Ionic' });
    await settle();

    expect(first.title).toBe('Comprar pan');
    expect(first.description).toBe('Pasar por la panadería');
    expect(first.id).not.toBe(second.id);
    expect(service.tasks().map((task) => task.title)).toEqual(['Estudiar', 'Comprar pan']);
    expect(storage.values.get('tasks:user-a')).toMatchObject([{ title: 'Estudiar' }, { title: 'Comprar pan' }]);
  });

  it('does not change state when local persistence fails', async () => {
    await signIn();
    storage.failNextWrite();

    await expect(service.addTask({ title: 'Sin guardar', description: 'Error de almacenamiento' })).rejects.toThrow(
      'No se pudo guardar la información en el dispositivo.',
    );

    expect(service.tasks()).toEqual([]);
    expect(storage.values.get('tasks:user-a')).toEqual([]);
    expect(storage.values.get('queue:user-a')).toEqual([]);
  });

  it('updates and deletes only the selected task while preserving photo and location', async () => {
    await signIn();

    const photo = { path: 'tasks/a.jpg', name: 'a.jpg', mimeType: 'image/jpeg' };
    const location = { latitude: -33.45, longitude: -70.67, accuracy: 12, capturedAt: TEST_SERVER_TIME };
    const first = await service.addTask({ title: 'Primera', description: 'Uno', photo, location });
    await service.addTask({ title: 'Segunda', description: 'Dos' });
    await settle();

    const updated = await service.updateTask(first.id, ' Primera editada ', ' Descripción nueva ', {
      photo,
      location,
    });
    await settle();

    expect(service.tasks()).toHaveLength(2);
    expect(service.tasks().find((task) => task.id === first.id)).toMatchObject({
      title: 'Primera editada',
      description: 'Descripción nueva',
      photo,
      location,
    });
    expect(service.tasks().find((task) => task.title === 'Segunda')).toBeTruthy();
    expect(updated.id).toBe(first.id);

    await service.deleteTask(first.id);
    await settle();

    expect(service.tasks()).toHaveLength(1);
    expect(service.tasks()[0].title).toBe('Segunda');
  });

  it('isolates tasks and queues between users', async () => {
    await signIn(TEST_USER);
    await service.addTask({ title: 'Solo Ana', description: 'Privada de Ana' });
    await settle();

    const anaTasks = storage.values.get('tasks:user-a') as Task[];

    await signIn(TEST_SECOND_USER);

    expect(service.tasks()).toEqual([]);

    await service.addTask({ title: 'Solo Bruno', description: 'Privada de Bruno' });
    await settle();

    expect(storage.values.get('tasks:user-a')).toEqual(anaTasks);
    expect(storage.values.get('tasks:user-b')).toMatchObject([{ title: 'Solo Bruno' }]);

    await signIn(TEST_USER);

    expect(service.tasks()).toHaveLength(1);
    expect(service.tasks()[0].title).toBe('Solo Ana');
  });

  it('keeps offline changes queued and retries them without duplicating tasks', async () => {
    await signIn();
    vi.mocked(connectivity.isOnline).mockResolvedValueOnce(false);

    await service.addTask({ title: 'Pendiente', description: 'Creada sin conexión' });
    await settle();

    expect(service.pendingCount()).toBe(1);
    expect(service.syncStatus()).toBe('offline');
    expect(api.putTask).not.toHaveBeenCalled();

    vi.mocked(connectivity.isOnline).mockResolvedValue(true);
    vi.mocked(api.putTask).mockReturnValue(throwError(() => networkError()));
    await service.sync();

    expect(service.syncStatus()).toBe('offline');
    expect(service.pendingCount()).toBe(1);

    vi.mocked(api.putTask).mockImplementation((task) => of({ task }));
    await service.sync();

    expect(service.pendingCount()).toBe(0);
    expect(service.syncStatus()).toBe('idle');
    expect(service.tasks()).toHaveLength(1);
  });

  it('coalesces an offline create and edit into a single pending operation', async () => {
    await signIn();
    vi.mocked(connectivity.isOnline).mockResolvedValue(false);

    const task = await service.addTask({ title: 'Creada', description: 'Sin conexión' });
    await settle();

    await service.updateTask(task.id, 'Editada', 'Editada sin conexión');
    await settle();

    const queue = storage.values.get('queue:user-a') as PendingOperation[];

    expect(service.pendingCount()).toBe(1);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ type: 'upsert' });
    expect(queue[0].task.title).toBe('Editada');
    expect(queue[0].task.id).toBe(task.id);

    vi.mocked(connectivity.isOnline).mockResolvedValue(true);
    await service.sync();

    expect(api.putTask).toHaveBeenCalledTimes(1);
    expect(api.putTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Editada' }), queue[0].opId);
    expect(service.pendingCount()).toBe(0);
  });

  it('coalesces an offline edit and delete into one delete operation and retries it once', async () => {
    await signIn();
    vi.mocked(connectivity.isOnline).mockResolvedValue(false);

    const task = await service.addTask({ title: 'Temporal', description: 'Creada sin conexión' });
    await settle();
    await service.updateTask(task.id, 'Editada', 'Editada sin conexión');
    await settle();
    await service.deleteTask(task.id);
    await settle();

    const queue = storage.values.get('queue:user-a') as PendingOperation[];

    expect(service.pendingCount()).toBe(1);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ type: 'delete' });
    expect(service.tasks()).toHaveLength(0);

    vi.mocked(connectivity.isOnline).mockResolvedValue(true);
    await service.sync();
    await service.sync();

    expect(api.deleteTask).toHaveBeenCalledTimes(1);
    expect(api.putTask).not.toHaveBeenCalled();
    expect(service.pendingCount()).toBe(0);
    expect(service.tasks()).toHaveLength(0);
  });

  it('restores a persisted offline queue after restarting the service', async () => {
    await signIn();
    vi.mocked(connectivity.isOnline).mockResolvedValue(false);

    await service.addTask({ title: 'Persistida', description: 'Sobrevive al reinicio' });
    await settle();

    expect(storage.values.get('queue:user-a')).toHaveLength(1);

    const restarted = TestBed.runInInjectionContext(() => new TaskService());
    await restarted.initialize(TEST_USER.id);
    await settle();

    expect(restarted.tasks().map((task) => task.title)).toEqual(['Persistida']);
    expect(restarted.pendingCount()).toBe(1);

    vi.mocked(connectivity.isOnline).mockResolvedValue(true);
    await restarted.sync();

    expect(restarted.pendingCount()).toBe(0);
    expect(api.putTask).toHaveBeenCalledTimes(1);
  });

  it('persists tasks, queue and lastSync in one batch after syncing', async () => {
    await signIn();
    vi.mocked(connectivity.isOnline).mockResolvedValue(false);

    await service.addTask({ title: 'Pendiente', description: 'Sin conexión' });
    await settle();

    storage.setMany.mockClear();
    vi.mocked(connectivity.isOnline).mockResolvedValue(true);
    const serverTime = '2026-02-01T00:00:00.000Z';
    vi.mocked(api.getTasks).mockReturnValue(of({ tasks: [], serverTime }));

    await service.sync();

    const batches = storage.setMany.mock.calls.map((call) => call[0] as { key: string; value: unknown }[]);

    expect(batches.at(-1)).toEqual(
      expect.arrayContaining([
        { key: 'tasks:user-a', value: expect.any(Array) },
        { key: 'queue:user-a', value: expect.any(Array) },
        { key: 'lastSync:user-a', value: serverTime },
      ]),
    );
    expect(storage.values.get('lastSync:user-a')).toBe(serverTime);
    expect(service.lastSyncAt()).toBe(serverTime);
  });

  it('applies the server version and clears the queue on a conflict', async () => {
    await signIn();
    const local = await service.addTask({ title: 'Local', description: 'Cambio local' });
    await settle();

    const serverTask = createTask(local.id, {
      title: 'Versión del servidor',
      description: 'Cambio remoto',
      updatedAt: '2099-01-02T00:00:00.000Z',
    });
    vi.mocked(api.putTask).mockReturnValue(conflictError(serverTask));

    await service.updateTask(local.id, 'Local editado', 'Otro cambio local');
    await settle();

    expect(service.tasks()).toHaveLength(1);
    expect(service.tasks()[0]).toMatchObject({ title: 'Versión del servidor', description: 'Cambio remoto' });
    expect(service.pendingCount()).toBe(0);
    expect(service.conflictMessage()).toContain('servidor');
  });

  it('imports remote tasks with their additional data and ignores duplicates', async () => {
    await signIn();

    const importInfo = {
      source: 'jsonplaceholder',
      sourceId: '1',
      importKey: 'jsonplaceholder:1',
      completed: true,
      sourceUserId: 1,
    };
    const imported = createTask('remote-1', { title: 'Tarea importada', importInfo });

    vi.mocked(api.importTodos).mockReturnValue(
      of({ imported: [imported], skippedDuplicates: 0, skippedInvalid: 0, total: 1 }),
    );

    const result = await service.importTasks();

    expect(result.skippedDuplicates).toBe(0);
    expect(service.tasks()).toHaveLength(1);
    expect(service.tasks()[0]).toMatchObject({ title: 'Tarea importada', importInfo });

    vi.mocked(api.importTodos).mockReturnValue(
      of({
        imported: [{ ...imported, updatedAt: '2026-01-02T00:00:00.000Z' }],
        skippedDuplicates: 1,
        skippedInvalid: 0,
        total: 1,
      }),
    );

    await service.importTasks();

    expect(service.tasks()).toHaveLength(1);
    expect(service.syncError()).toBeNull();
  });

  it('reports import errors in Spanish', async () => {
    await signIn();
    vi.mocked(api.importTodos).mockReturnValue(
      throwError(() => ({ status: 500, error: { error: 'El proveedor externo falló' } })),
    );

    await expect(service.importTasks()).rejects.toThrow('El proveedor externo falló');

    expect(service.syncStatus()).toBe('error');
    expect(service.syncError()).toBe('El proveedor externo falló');
  });

  it('receives upserts and deletes through server-sent events', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    await signIn();

    const source = FakeEventSource.instances.at(-1);

    expect(source?.url).toContain('token=token-a');

    const remote = createTask('remote-rt', {
      title: 'Cambio en tiempo real',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });

    source?.emit('task-upsert', JSON.stringify(remote));
    await settle();

    expect(service.tasks().some((task) => task.title === 'Cambio en tiempo real')).toBe(true);

    source?.emit('task-delete', JSON.stringify({ ...remote, updatedAt: '2026-01-04T00:00:00.000Z' }));
    await settle();

    expect(service.tasks().some((task) => task.id === 'remote-rt')).toBe(false);
  });

  it('keeps a task with a pending operation when a remote delete arrives in real time', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    await signIn();
    vi.mocked(connectivity.isOnline).mockResolvedValue(false);

    const task = await service.addTask({ title: 'Con cambio pendiente', description: 'No borrar' });
    await settle();

    const source = FakeEventSource.instances.at(-1);

    expect(source).toBeDefined();

    source?.emit('task-delete', JSON.stringify({ ...task, deleted: true, updatedAt: '2099-01-01T00:00:00.000Z' }));
    await settle();

    expect(service.tasks().some((item) => item.id === task.id)).toBe(true);
    expect(service.pendingCount()).toBe(1);

    vi.mocked(connectivity.isOnline).mockResolvedValue(true);
    await service.sync();

    expect(service.pendingCount()).toBe(0);
    expect(service.tasks().some((item) => item.id === task.id)).toBe(true);
  });

  it('starts realtime after reconnecting from an offline start and applies token refreshes', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    token.clear();
    connectivity.setOnline(false);

    await signIn();

    expect(FakeEventSource.instances).toHaveLength(0);

    connectivity.setOnline(true);
    token.set('token-b');
    await settle();
    TestBed.flushEffects();
    await settle();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toContain('token=token-b');

    connectivity.setOnline(false);
    connectivity.setOnline(true);
    await settle();

    expect(FakeEventSource.instances).toHaveLength(1);

    token.set('token-c');
    TestBed.flushEffects();
    await settle();

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain('token=token-c');
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });
});
