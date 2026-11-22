import { HttpError } from './auth.mjs';

function sourceValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  return null;
}

export function mapExternalTodos(payload, options = {}) {
  if (!Array.isArray(payload)) {
    throw new HttpError(502, 'La API externa devolvió un formato inválido.');
  }

  const sourceName = options.sourceName || 'JSONPlaceholder';
  const existingKeys = options.existingKeys instanceof Set ? options.existingKeys : new Set();
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 10;
  const now = typeof options.now === 'function' ? options.now() : new Date().toISOString();
  const tasks = [];
  const addedKeys = new Set();
  let skippedDuplicates = 0;
  let skippedInvalid = 0;
  let skippedLimit = 0;

  for (const [index, item] of payload.entries()) {
    if (tasks.length >= limit) {
      skippedLimit = payload.length - index;
      break;
    }

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      skippedInvalid += 1;
      continue;
    }

    const sourceId = sourceValue(item.id);
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, 80) : '';
    const completed = typeof item.completed === 'boolean' ? item.completed : false;
    const sourceUserId = sourceValue(item.userId);

    if (!sourceId || !title) {
      skippedInvalid += 1;
      continue;
    }

    const importKey = `${sourceName.toLowerCase()}:${sourceId}`;

    if (existingKeys.has(importKey) || addedKeys.has(importKey)) {
      skippedDuplicates += 1;
      continue;
    }

    addedKeys.add(importKey);

    tasks.push({
      id: `import-${sourceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${sourceId}`.slice(0, 160),
      title,
      description: `Importada desde ${sourceName}. Estado remoto: ${completed ? 'completada' : 'pendiente'}.`,
      createdAt: now,
      updatedAt: now,
      deleted: false,
      importInfo: {
        source: sourceName,
        sourceId,
        importKey,
        completed,
        ...(sourceUserId ? { sourceUserId: Number(sourceUserId) || sourceUserId } : {}),
      },
    });
  }

  if (payload.length > 0 && tasks.length === 0 && skippedInvalid > 0 && skippedDuplicates === 0) {
    throw new HttpError(502, 'La API externa devolvió datos inválidos.');
  }

  return {
    tasks,
    skippedDuplicates,
    skippedInvalid,
    skippedLimit,
  };
}
