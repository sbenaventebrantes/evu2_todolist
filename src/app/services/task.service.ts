import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../environments/environment';
import type { ImportResult, PendingOperation, SyncStatus } from '../models/sync.model';
import type { Task, TaskDraft, TaskLocation, TaskPhoto } from '../models/task.model';
import {
  conflictTask,
  createId,
  describeError,
  isConflictError,
  isNetworkError,
  isNewer,
  normalizeTask,
} from '../utils/task.utils';

import { AuthService } from './auth.service';
import { ConnectivityService } from './connectivity.service';
import { AppStorage, type StorageEntry } from './storage.service';
import { TaskApiService } from './task-api.service';
import { TokenStore } from './token.store';

@Injectable({ providedIn: 'root' })
export class TaskService {
  private readonly auth = inject(AuthService);
  private readonly storage = inject(AppStorage);
  private readonly api = inject(TaskApiService);
  private readonly connectivity = inject(ConnectivityService);
  private readonly tokenStore = inject(TokenStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly tasksState = signal<Task[]>([]);
  private readonly queueState = signal<PendingOperation[]>([]);
  private readonly syncStatusState = signal<SyncStatus>('idle');
  private readonly lastSyncAtState = signal<string | null>(null);
  private readonly syncErrorState = signal<string | null>(null);
  private readonly conflictMessageState = signal<string | null>(null);
  private currentUserId: string | null = null;
  private initialization?: { userId: string | null; promise: Promise<void> };
  private operationQueue: Promise<void> = Promise.resolve();
  private generation = 0;
  private syncing = false;
  private eventSource?: EventSource;
  private realtimeUrl?: string;
  private onlineUnsubscribe?: () => void;
  private syncTimer?: ReturnType<typeof setInterval>;

  readonly tasks = computed(() =>
    this.tasksState()
      .filter((task) => !task.deleted)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
  );
  readonly syncStatus = this.syncStatusState.asReadonly();
  readonly lastSyncAt = this.lastSyncAtState.asReadonly();
  readonly syncError = this.syncErrorState.asReadonly();
  readonly conflictMessage = this.conflictMessageState.asReadonly();
  readonly online = this.connectivity.online;
  readonly pendingCount = computed(() => this.queueState().length);
  readonly hasPendingChanges = computed(() => this.queueState().length > 0);

  constructor() {
    effect(() => {
      const user = this.auth.currentUser();
      void this.initialize(user?.id ?? null);
    });

    effect(() => {
      const token = this.tokenStore.token();

      if (token && this.connectivity.online()) {
        this.connectRealtime();
      }
    });

    this.destroyRef.onDestroy(() => {
      this.disconnectRealtime();
      this.onlineUnsubscribe?.();
      this.connectivity.dispose();

      if (this.syncTimer) {
        clearInterval(this.syncTimer);
      }
    });
  }

  async initialize(userId: string | null): Promise<void> {
    if (this.initialization?.userId === userId) {
      return this.initialization.promise;
    }

    const generation = ++this.generation;
    const promise = this.loadForUser(userId, generation);
    this.initialization = { userId, promise };
    return promise;
  }

  private async loadForUser(userId: string | null, generation: number): Promise<void> {
    this.disconnectRealtime();
    this.onlineUnsubscribe?.();
    this.clearTimers();
    this.currentUserId = userId;
    this.tasksState.set([]);
    this.queueState.set([]);
    this.lastSyncAtState.set(null);
    this.syncErrorState.set(null);
    this.conflictMessageState.set(null);

    if (!userId) {
      this.syncStatusState.set('idle');
      return;
    }

    const [tasks, queue, lastSyncAt] = await Promise.all([
      this.storage.get<Task[]>(`tasks:${userId}`),
      this.storage.get<PendingOperation[]>(`queue:${userId}`),
      this.storage.get<string>(`lastSync:${userId}`),
    ]);

    if (generation !== this.generation) {
      return;
    }

    this.tasksState.set((tasks ?? []).map((task) => normalizeTask(task)));
    this.queueState.set(this.coalesceOperations(queue ?? []));
    this.lastSyncAtState.set(lastSyncAt ?? null);

    this.onlineUnsubscribe = this.connectivity.onStatusChange((connected) => {
      if (!connected && generation === this.generation) {
        this.syncStatusState.set('offline');
      }

      if (connected && generation === this.generation) {
        this.connectRealtime();
        void this.sync();
      }
    });

    const connected = await this.connectivity.initialize();

    if (generation !== this.generation) {
      return;
    }

    this.syncTimer = setInterval(() => void this.sync(), environment.syncIntervalMs);
    this.syncStatusState.set(connected ? 'syncing' : 'offline');

    if (connected) {
      await this.sync();
    }

    if (generation === this.generation) {
      this.connectRealtime();
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  addTask(draft: TaskDraft): Promise<Task> {
    return this.enqueue(() => this.performAddTask(draft));
  }

  private async performAddTask(draft: TaskDraft): Promise<Task> {
    const userId = this.requireUserId();
    const now = new Date().toISOString();
    const task = normalizeTask({
      id: createId(),
      title: draft.title.trim(),
      description: draft.description.trim(),
      photo: draft.photo,
      location: draft.location,
      createdAt: now,
      updatedAt: now,
      deleted: false,
    });
    const operation = this.createOperation('upsert', task);
    const tasks = [task, ...this.tasksState()];
    const queue = this.queueWithOperation(operation);

    await this.applyLocalChange(userId, tasks, queue);

    return task;
  }

  updateTask(
    id: string,
    title: string,
    description: string,
    extras: { photo?: TaskPhoto | null; location?: TaskLocation | null } = {},
  ): Promise<Task> {
    return this.enqueue(() => this.performUpdateTask(id, title, description, extras));
  }

  private async performUpdateTask(
    id: string,
    title: string,
    description: string,
    extras: { photo?: TaskPhoto | null; location?: TaskLocation | null },
  ): Promise<Task> {
    const userId = this.requireUserId();
    const existing = this.tasksState().find((task) => task.id === id && !task.deleted);

    if (!existing) {
      throw new Error('No se encontró la tarea que quieres editar.');
    }

    const updated: Task = normalizeTask({
      ...existing,
      title: title.trim(),
      description: description.trim(),
      photo: extras.photo === null ? undefined : (extras.photo ?? existing.photo),
      location: extras.location === null ? undefined : (extras.location ?? existing.location),
      updatedAt: new Date().toISOString(),
    });
    const operation = this.createOperation('upsert', updated);
    const tasks = this.tasksState().map((task) => (task.id === id ? updated : task));
    const queue = this.queueWithOperation(operation);

    await this.applyLocalChange(userId, tasks, queue);

    return updated;
  }

  deleteTask(id: string): Promise<void> {
    return this.enqueue(() => this.performDeleteTask(id));
  }

  private async performDeleteTask(id: string): Promise<void> {
    const userId = this.requireUserId();
    const existing = this.tasksState().find((task) => task.id === id && !task.deleted);

    if (!existing) {
      return;
    }

    const deleted: Task = normalizeTask({
      ...existing,
      deleted: true,
      updatedAt: new Date().toISOString(),
    });
    const operation = this.createOperation('delete', deleted);
    const tasks = this.tasksState().map((task) => (task.id === id ? deleted : task));
    const queue = this.queueWithOperation(operation);

    await this.applyLocalChange(userId, tasks, queue);
  }

  // Shared by add/update/delete: all three persist the new tasks/queue snapshot,
  // publish it only if the user hasn't changed since the write started, and kick
  // off a background sync. Keeping this in one place avoids the three call sites
  // drifting out of sync with each other.
  private async applyLocalChange(userId: string, tasks: Task[], queue: PendingOperation[]): Promise<void> {
    await this.persistFor(userId, tasks, queue);

    if (this.currentUserId !== userId) {
      return;
    }

    this.tasksState.set(tasks);
    this.queueState.set(queue);
    void this.sync();
  }

  importTasks(): Promise<ImportResult> {
    return this.enqueue(() => this.performImportTasks());
  }

  private async performImportTasks(): Promise<ImportResult> {
    const userId = this.requireUserId();
    this.syncStatusState.set('syncing');
    this.syncErrorState.set(null);

    try {
      const result = await firstValueFrom(this.api.importTodos());

      if (this.currentUserId === userId) {
        await this.mergeRemoteTasks(result.imported, userId);
        this.syncStatusState.set('idle');
      }

      return result;
    } catch (error) {
      const message = describeError(error);

      if (this.currentUserId === userId) {
        this.syncStatusState.set('error');
        this.syncErrorState.set(message);
      }

      throw new Error(message, { cause: error });
    }
  }

  sync(): Promise<void> {
    return this.enqueue(() => this.performSync());
  }

  private async performSync(): Promise<void> {
    const userId = this.currentUserId;

    if (!userId || this.syncing) {
      return;
    }

    this.syncing = true;
    this.syncStatusState.set('syncing');
    this.syncErrorState.set(null);

    try {
      const connected = await this.connectivity.isOnline();

      if (!connected) {
        if (this.currentUserId === userId) {
          this.syncStatusState.set('offline');
        }

        return;
      }

      await this.flushQueue(userId);
      await this.pullRemote(userId);

      if (this.currentUserId === userId) {
        this.syncStatusState.set('idle');
      }
    } catch (error) {
      if (this.currentUserId === userId) {
        this.syncStatusState.set(isNetworkError(error) ? 'offline' : 'error');
        this.syncErrorState.set(describeError(error));
      }
    } finally {
      this.syncing = false;
    }
  }

  dismissConflict(): void {
    this.conflictMessageState.set(null);
  }

  private async flushQueue(userId: string): Promise<void> {
    for (const operation of [...this.queueState()]) {
      if (this.currentUserId !== userId) {
        return;
      }

      try {
        const response =
          operation.type === 'delete'
            ? await firstValueFrom(
                this.api.deleteTask(
                  operation.task.id,
                  operation.opId,
                  operation.task.updatedAt ?? new Date().toISOString(),
                ),
              )
            : await firstValueFrom(this.api.putTask(operation.task, operation.opId));
        await this.applyRemoteTask(response.task, operation.opId, userId);
      } catch (error) {
        if (isConflictError(error)) {
          const serverTask = conflictTask(error);

          if (serverTask) {
            await this.applyRemoteTask(serverTask, operation.opId, userId);
          } else {
            await this.removeOperation(operation.opId, userId);
          }

          if (this.currentUserId === userId) {
            this.conflictMessageState.set(describeError(error));
          }

          continue;
        }

        if (isNetworkError(error)) {
          throw error;
        }

        await this.removeOperation(operation.opId, userId);

        if (this.currentUserId === userId) {
          this.syncErrorState.set(describeError(error));
        }
      }
    }
  }

  private async pullRemote(userId: string): Promise<void> {
    const response = await firstValueFrom(this.api.getTasks(this.lastSyncAtState()));

    if (this.currentUserId !== userId) {
      return;
    }

    await this.mergeRemoteTasks(response.tasks, userId, response.serverTime);
  }

  private async mergeRemoteTasks(remoteTasks: Task[], userId: string, lastSyncAt?: string): Promise<void> {
    if (this.currentUserId !== userId) {
      return;
    }

    let tasks = [...this.tasksState()];
    const queue = [...this.queueState()];
    let changed = false;

    for (const remote of remoteTasks) {
      const normalized = normalizeTask(remote);

      if (this.hasPendingOperation(normalized.id, queue)) {
        continue;
      }

      const local = tasks.find((task) => task.id === normalized.id);

      if (!isNewer(normalized, local)) {
        continue;
      }

      tasks = local ? tasks.map((task) => (task.id === normalized.id ? normalized : task)) : [normalized, ...tasks];
      changed = true;
    }

    if (!changed && lastSyncAt === undefined) {
      return;
    }

    await this.persistFor(userId, tasks, queue, lastSyncAt);

    if (this.currentUserId === userId) {
      this.tasksState.set(tasks);
      this.queueState.set(queue);

      if (lastSyncAt !== undefined) {
        this.lastSyncAtState.set(lastSyncAt);
      }
    }
  }

  private async applyRemoteTask(remote: Task, opId: string | null, userId: string): Promise<void> {
    if (this.currentUserId !== userId) {
      return;
    }

    const normalized = normalizeTask(remote);
    const queue = opId ? this.queueState().filter((operation) => operation.opId !== opId) : [...this.queueState()];
    const hasPendingEdit = this.hasPendingOperation(normalized.id, queue);
    const local = this.tasksState().find((task) => task.id === normalized.id);
    let tasks = [...this.tasksState()];

    if (!hasPendingEdit && isNewer(normalized, local)) {
      tasks = local ? tasks.map((task) => (task.id === normalized.id ? normalized : task)) : [normalized, ...tasks];
    }

    await this.persistFor(userId, tasks, queue);

    if (this.currentUserId === userId) {
      this.tasksState.set(tasks);
      this.queueState.set(queue);
    }
  }

  private async removeOperation(opId: string, userId: string): Promise<void> {
    const queue = this.queueState().filter((operation) => operation.opId !== opId);
    await this.persistFor(userId, this.tasksState(), queue);

    if (this.currentUserId === userId) {
      this.queueState.set(queue);
    }
  }

  private async persistFor(
    userId: string,
    tasks: Task[],
    queue: PendingOperation[],
    lastSyncAt?: string,
  ): Promise<void> {
    const entries: StorageEntry[] = [
      { key: `tasks:${userId}`, value: tasks },
      { key: `queue:${userId}`, value: queue },
    ];

    if (lastSyncAt !== undefined) {
      entries.push({ key: `lastSync:${userId}`, value: lastSyncAt });
    }

    await this.storage.setMany(entries);
  }

  private queueWithOperation(operation: PendingOperation): PendingOperation[] {
    return this.coalesceOperations([...this.queueState(), operation]);
  }

  private coalesceOperations(operations: PendingOperation[]): PendingOperation[] {
    const byTask = new Map<string, PendingOperation>();

    for (const operation of operations) {
      const current = byTask.get(operation.task.id);

      if (!current || current.type !== 'delete') {
        byTask.set(operation.task.id, operation);
      }
    }

    return [...byTask.values()];
  }

  private hasPendingOperation(taskId: string, queue = this.queueState()): boolean {
    return queue.some((operation) => operation.task.id === taskId);
  }

  private createOperation(type: PendingOperation['type'], task: Task): PendingOperation {
    return {
      opId: createId('op'),
      type,
      task,
      createdAt: new Date().toISOString(),
    };
  }

  private connectRealtime(): void {
    if (typeof EventSource === 'undefined') {
      return;
    }

    const userId = this.currentUserId;
    const token = this.tokenStore.token();

    if (!userId || !token) {
      return;
    }

    const url = `${environment.apiUrl}/api/tasks/events?token=${encodeURIComponent(token)}`;

    if (this.eventSource && this.realtimeUrl === url) {
      return;
    }

    this.disconnectRealtime();
    const source = new EventSource(url);
    this.eventSource = source;
    this.realtimeUrl = url;

    source.addEventListener('task-upsert', (event) => {
      this.parseRealtimeTask(event, userId, 'upsert');
    });

    source.addEventListener('task-delete', (event) => {
      this.parseRealtimeTask(event, userId, 'delete');
    });
  }

  private parseRealtimeTask(event: Event, userId: string, type: PendingOperation['type']): void {
    try {
      const data = (event as MessageEvent<string>).data;
      const task = normalizeTask(JSON.parse(data) as Task);

      if (!this.hasPendingOperation(task.id)) {
        void this.applyRemoteTask({ ...task, deleted: type === 'delete' || task.deleted }, null, userId);
      }
    } catch {
      this.syncErrorState.set('No se pudo interpretar un cambio recibido en tiempo real.');
    }
  }

  private disconnectRealtime(): void {
    this.eventSource?.close();
    this.eventSource = undefined;
    this.realtimeUrl = undefined;
  }

  private clearTimers(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
  }

  private requireUserId(): string {
    if (!this.currentUserId) {
      throw new Error('Inicia sesión para administrar tus tareas.');
    }

    return this.currentUserId;
  }
}
