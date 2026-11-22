import fs from 'node:fs';
import path from 'node:path';

import { HttpError } from './auth.mjs';

export const TASK_LIMITS = Object.freeze({
  title: 80,
  description: 200,
  photoDataUrl: 3_000_000,
  importKey: 160,
  opId: 160,
});

function cleanText(value, maxLength, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : fallback;
}

function toIso(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
}

function cleanNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function cleanPhoto(value) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const pathValue = cleanText(value.path, 240);
  const dataUrl =
    typeof value.dataUrl === 'string' && value.dataUrl.startsWith('data:image/')
      ? value.dataUrl.slice(0, TASK_LIMITS.photoDataUrl)
      : undefined;

  if (!pathValue && !dataUrl) {
    return undefined;
  }

  return {
    path: pathValue,
    name: cleanText(value.name, 120),
    mimeType: cleanText(value.mimeType, 60, 'image/jpeg'),
    ...(dataUrl ? { dataUrl } : {}),
  };
}

function cleanLocation(value) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const latitude = cleanNumber(value.latitude);
  const longitude = cleanNumber(value.longitude);

  if (latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return undefined;
  }

  return {
    latitude,
    longitude,
    accuracy: cleanNumber(value.accuracy),
    capturedAt: toIso(value.capturedAt, new Date().toISOString()),
  };
}

function cleanImportInfo(value) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const source = cleanText(value.source, 60);
  const sourceId = cleanText(value.sourceId, 80);

  if (!source || !sourceId) {
    return undefined;
  }

  return {
    source,
    sourceId,
    importKey: cleanText(value.importKey, TASK_LIMITS.importKey, `${source.toLowerCase()}:${sourceId}`),
    completed: typeof value.completed === 'boolean' ? value.completed : undefined,
    sourceUserId: cleanNumber(value.sourceUserId),
  };
}

export function normalizeTask(input, userId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'La tarea enviada no es válida.');
  }

  const id = cleanText(input.id, 160);

  if (!id) {
    throw new HttpError(400, 'La tarea necesita un identificador.');
  }

  const title = cleanText(input.title, TASK_LIMITS.title);
  const description = cleanText(input.description, TASK_LIMITS.description);

  if (!title || !description) {
    throw new HttpError(400, 'El título y la descripción son obligatorios.');
  }

  const photo = cleanPhoto(input.photo);
  const location = cleanLocation(input.location);
  const importInfo = cleanImportInfo(input.importInfo);
  const lastOpId = cleanText(input.lastOpId, TASK_LIMITS.opId);
  const now = new Date().toISOString();
  const task = {
    id,
    userId,
    title,
    description,
    createdAt: toIso(input.createdAt, now),
    updatedAt: toIso(input.updatedAt, now),
    deleted: input.deleted === true,
    ...(photo ? { photo } : {}),
    ...(location ? { location } : {}),
    ...(importInfo ? { importInfo } : {}),
    ...(lastOpId ? { lastOpId } : {}),
  };

  return task;
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      return { users: [], tasks: [] };
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      };
    } catch {
      return { users: [], tasks: [] };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.data, null, 2));
    fs.renameSync(temporaryPath, this.filePath);
  }

  getUserByEmail(email) {
    return this.data.users.find((user) => user.email === email.toLowerCase()) ?? null;
  }

  getUserById(id) {
    return this.data.users.find((user) => user.id === id) ?? null;
  }

  addUser(user) {
    this.data.users.push(user);
    this.save();
  }

  getTask(userId, taskId) {
    return this.data.tasks.find((task) => task.userId === userId && task.id === taskId) ?? null;
  }

  tasksForUser(userId) {
    return this.data.tasks.filter((task) => task.userId === userId);
  }

  importKeysForUser(userId) {
    return new Set(
      this.tasksForUser(userId)
        .map((task) => task.importInfo?.importKey)
        .filter(Boolean),
    );
  }

  upsertTask(task, opId) {
    const existing = this.getTask(task.userId, task.id);
    const stored = withoutUndefined({
      ...task,
      ...(opId ? { lastOpId: opId } : {}),
    });

    if (existing) {
      Object.assign(existing, stored);
      this.save();
      return existing;
    }

    this.data.tasks.push(stored);
    this.save();
    return stored;
  }

  deleteTask(userId, taskId, deletedAt, opId) {
    const existing = this.getTask(userId, taskId);

    if (existing) {
      delete existing.photo;
      delete existing.location;
    }

    const tombstone = existing
      ? {
          ...existing,
          deleted: true,
          updatedAt: deletedAt,
        }
      : normalizeTask(
          {
            id: taskId,
            title: 'Tarea eliminada',
            description: 'La tarea ya no está disponible.',
            createdAt: deletedAt,
            updatedAt: deletedAt,
            deleted: true,
          },
          userId,
        );

    return this.upsertTask(tombstone, opId);
  }
}
