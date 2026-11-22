import type { Task, TaskLocation } from '../models/task.model';

export function createId(prefix = 'task'): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

export function normalizeTask(input: Task): Task {
  const now = new Date().toISOString();
  return {
    ...input,
    title: input.title.trim(),
    description: input.description.trim(),
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  };
}

export function isNewer(candidate: Task, current: Task | undefined): boolean {
  if (!current) {
    return true;
  }

  const candidateTime = Date.parse(candidate.updatedAt ?? '');
  const currentTime = Date.parse(current.updatedAt ?? '');

  if (Number.isNaN(candidateTime)) {
    return false;
  }

  return Number.isNaN(currentTime) || candidateTime > currentTime;
}

export function formatCoordinates(location: TaskLocation): string {
  const accuracy = location.accuracy === null ? '' : ` ± ${Math.round(location.accuracy)} m`;
  return `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}${accuracy}`;
}

function errorInfo(error: unknown): { status?: number; message?: string } {
  if (!error || typeof error !== 'object') {
    return {};
  }

  const candidate = error as {
    status?: number;
    message?: string;
    error?: { error?: string; message?: string } | string;
  };
  const serverMessage =
    typeof candidate.error === 'object' ? candidate.error?.error || candidate.error?.message : candidate.error;

  return {
    status: candidate.status,
    message: serverMessage || candidate.message,
  };
}

export function describeError(error: unknown): string {
  const { status, message } = errorInfo(error);

  if (status === 0) {
    return 'No hay conexión. Los cambios quedarán pendientes y se reintentarán automáticamente.';
  }

  if (status === 401) {
    return 'La sesión venció. Vuelve a iniciar sesión.';
  }

  if (status === 409) {
    return 'Otra versión de la tarea era más reciente. Se conservó la versión del servidor.';
  }

  return message || 'Ocurrió un error. Inténtalo nuevamente.';
}

export function isNetworkError(error: unknown): boolean {
  return errorInfo(error).status === 0;
}

export function isConflictError(error: unknown): boolean {
  return errorInfo(error).status === 409;
}

export function conflictTask(error: unknown): Task | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const details = (error as { error?: { details?: { task?: Task } } }).error?.details?.task;
  return details ?? null;
}
