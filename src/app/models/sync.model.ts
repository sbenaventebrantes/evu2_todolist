import type { Task } from '../models/task.model';

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

export interface PendingOperation {
  opId: string;
  type: 'upsert' | 'delete';
  task: Task;
  createdAt: string;
}

export interface TaskListResponse {
  tasks: Task[];
  serverTime: string;
}

export interface ImportResult {
  imported: Task[];
  skippedDuplicates: number;
  skippedInvalid: number;
  skippedLimit?: number;
  total: number;
}
