import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createApiServer } from './api-server.mjs';
import { createConfig } from './config.mjs';
import { mapExternalTodos } from './import.mapper.mjs';
import { TASK_LIMITS, normalizeTask } from './store.mjs';

const activeDirectories = [];

after(() => {
  for (const directory of activeDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function createTestApi(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mis-tareas-api-'));
  activeDirectories.push(directory);

  const api = createApiServer({
    secret: 'unit-test-secret',
    storePath: path.join(directory, 'store.json'),
    port: 0,
    importUrl: 'https://external.test/todos',
    ...overrides,
  });

  await api.listen(0, '127.0.0.1');
  t.after(async () => api.close());
  return { api, base: `http://127.0.0.1:${api.server.address().port}` };
}

async function call(base, pathname, { method = 'GET', token, body } = {}) {
  const headers = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  return { status: response.status, body: payload };
}

async function register(base, email) {
  const response = await call(base, '/api/auth/register', {
    method: 'POST',
    body: { email, password: 'password123', name: email.split('@')[0] },
  });
  assert.equal(response.status, 201);
  return response.body;
}

function taskPayload(id, title, updatedAt, overrides = {}) {
  return {
    id,
    title,
    description: `Descripción de ${title}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    ...overrides,
  };
}

async function openEventStream(base, token, t) {
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/tasks/events?token=${encodeURIComponent(token)}`, {
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);

  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';

  function consume(chunk) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf('\n\n');

    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = {};

      for (const line of frame.split('\n')) {
        if (!line || line.startsWith(':')) {
          continue;
        }

        const separator = line.indexOf(':');
        const name = separator === -1 ? line : line.slice(0, separator);
        const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');

        if (name === 'event') {
          event.event = value;
        }

        if (name === 'data') {
          event.data = value;
        }
      }

      if (event.event && event.data) {
        events.push({ event: event.event, task: JSON.parse(event.data) });
      }

      boundary = buffer.indexOf('\n\n');
    }
  }

  async function waitFor(count) {
    const timeout = setTimeout(() => controller.abort(), 4000);

    try {
      while (events.length < count) {
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        consume(value);
      }
    } finally {
      clearTimeout(timeout);
    }

    assert.equal(events.length, count, `Se esperaban ${count} eventos SSE y se recibieron ${events.length}.`);
    return events;
  }

  t.after(async () => {
    await reader.cancel().catch(() => undefined);
    controller.abort();
  });

  return { waitFor };
}

describe('Mis Tareas API', () => {
  it('scopes tasks per user and keeps accounts isolated', async (t) => {
    const { base } = await createTestApi(t);
    const first = await register(base, 'ana@example.com');
    const second = await register(base, 'bruno@example.com');

    const anonymous = await call(base, '/api/tasks');
    assert.equal(anonymous.status, 401);

    const created = await call(base, '/api/tasks', {
      method: 'PUT',
      token: first.token,
      body: taskPayload('task-1', 'Tarea de Ana', '2026-02-01T00:00:00.000Z'),
    });
    assert.equal(created.status, 200);

    const firstTasks = await call(base, '/api/tasks', { token: first.token });
    const secondTasks = await call(base, '/api/tasks', { token: second.token });

    assert.equal(firstTasks.body.tasks.length, 1);
    assert.equal(firstTasks.body.tasks[0].title, 'Tarea de Ana');
    assert.equal(secondTasks.body.tasks.length, 0);

    const login = await call(base, '/api/auth/login', {
      method: 'POST',
      body: { email: 'ana@example.com', password: 'password123' },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.id, first.user.id);
  });

  it('rejects invalid credentials and short passwords', async (t) => {
    const { base } = await createTestApi(t);

    const shortPassword = await call(base, '/api/auth/register', {
      method: 'POST',
      body: { email: 'corto@example.com', password: 'abc' },
    });
    assert.equal(shortPassword.status, 400);
    assert.match(shortPassword.body.error, /8 caracteres/);

    await register(base, 'valida@example.com');
    const badLogin = await call(base, '/api/auth/login', {
      method: 'POST',
      body: { email: 'valida@example.com', password: 'incorrecta' },
    });
    assert.equal(badLogin.status, 401);
  });

  it('is idempotent on repeated operations and applies last-write-wins', async (t) => {
    const { base } = await createTestApi(t);
    const session = await register(base, 'sync@example.com');
    const payload = { ...taskPayload('task-2', 'Original', '2026-03-01T00:00:00.000Z'), opId: 'op-1' };

    const first = await call(base, '/api/tasks', { method: 'PUT', token: session.token, body: payload });
    assert.equal(first.status, 200);

    const retry = await call(base, '/api/tasks', { method: 'PUT', token: session.token, body: payload });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.task.id, 'task-2');

    const older = await call(base, '/api/tasks', {
      method: 'PUT',
      token: session.token,
      body: { ...taskPayload('task-2', 'Obsoleta', '2026-02-01T00:00:00.000Z'), opId: 'op-2' },
    });
    assert.equal(older.status, 409);
    assert.equal(older.body.details.task.title, 'Original');

    const newer = await call(base, '/api/tasks', {
      method: 'PUT',
      token: session.token,
      body: { ...taskPayload('task-2', 'Actualizada', '2026-04-01T00:00:00.000Z'), opId: 'op-3' },
    });
    assert.equal(newer.status, 200);

    const tasks = await call(base, '/api/tasks', { token: session.token });
    assert.equal(tasks.body.tasks.length, 1);
    assert.equal(tasks.body.tasks[0].title, 'Actualizada');
  });

  it('propagates deletions as sync tombstones', async (t) => {
    const { base } = await createTestApi(t);
    const session = await register(base, 'delete@example.com');

    await call(base, '/api/tasks', {
      method: 'PUT',
      token: session.token,
      body: taskPayload('task-3', 'Eliminar', '2026-05-01T00:00:00.000Z'),
    });

    const deleted = await call(base, '/api/tasks/task-3?opId=delete-1&deletedAt=2026-05-02T00:00:00.000Z', {
      method: 'DELETE',
      token: session.token,
    });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.task.deleted, true);

    const since = await call(base, '/api/tasks?since=2026-05-01T12:00:00.000Z', { token: session.token });
    assert.equal(since.body.tasks.length, 1);
    assert.equal(since.body.tasks[0].deleted, true);
  });

  it('imports from an external API, maps extra fields and skips duplicates', async (t) => {
    const external = [
      { id: 11, title: 'Tarea externa', completed: false, userId: 4 },
      { id: 12, title: 'Otra tarea', completed: true, userId: 4 },
      { title: 'Sin identificador' },
    ];
    const { base } = await createTestApi(t, {
      fetchImpl: async () => new Response(JSON.stringify(external), { status: 200 }),
    });
    const session = await register(base, 'import@example.com');

    const first = await call(base, '/api/import/todos', { method: 'POST', token: session.token });
    assert.equal(first.status, 200);
    assert.equal(first.body.imported.length, 2);
    assert.equal(first.body.skippedInvalid, 1);
    assert.equal(first.body.imported[0].importInfo.completed, false);
    assert.equal(first.body.imported[0].importInfo.sourceUserId, 4);

    const second = await call(base, '/api/import/todos', { method: 'POST', token: session.token });
    assert.equal(second.body.imported.length, 0);
    assert.equal(second.body.skippedDuplicates, 2);

    const tasks = await call(base, '/api/tasks', { token: session.token });
    assert.equal(tasks.body.tasks.length, 2);
  });

  it('rejects invalid external responses with a Spanish error message', async (t) => {
    const { base } = await createTestApi(t, {
      fetchImpl: async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    });
    const session = await register(base, 'invalida@example.com');

    const response = await call(base, '/api/import/todos', { method: 'POST', token: session.token });
    assert.equal(response.status, 502);
    assert.match(response.body.error, /formato inválido/);
  });

  it('emits realtime changes over SSE only to the authenticated user', async (t) => {
    const { base } = await createTestApi(t);
    const first = await register(base, 'sse@example.com');
    const controller = new AbortController();

    const stream = await fetch(`${base}/api/tasks/events?token=${encodeURIComponent(first.token)}`, {
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let received = '';

    const created = await call(base, '/api/tasks', {
      method: 'PUT',
      token: first.token,
      body: taskPayload('task-4', 'Tarea en vivo', '2026-06-01T00:00:00.000Z'),
    });
    assert.equal(created.status, 200);

    while (!received.includes('event: task-upsert')) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      received += decoder.decode(value, { stream: true });
    }

    assert.match(received, /event: task-upsert/);
    assert.match(received, /Tarea en vivo/);
    await reader.cancel();
    controller.abort();
  });

  it('validates and maps the external response in isolation', () => {
    const result = mapExternalTodos(
      [{ id: 'a-1', title: 'Tarea', completed: true, userId: 9 }, { id: 'a-1', title: 'Duplicada', completed: false }],
      { sourceName: 'Demo', limit: 10, now: () => '2026-07-01T00:00:00.000Z' },
    );

    assert.equal(result.tasks.length, 1);
    assert.equal(result.skippedDuplicates, 1);
    assert.equal(result.tasks[0].importInfo.importKey, 'demo:a-1');
    assert.equal(result.tasks[0].createdAt, '2026-07-01T00:00:00.000Z');
  });

  it('returns a Spanish 502 when the external API connection fails', async (t) => {
    const { base } = await createTestApi(t, {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const session = await register(base, 'sin-red@example.com');

    const response = await call(base, '/api/import/todos', { method: 'POST', token: session.token });
    assert.equal(response.status, 502);
    assert.match(response.body.error, /No se pudo conectar con la API externa/);
  });

  it('returns a Spanish 502 when the external API request times out', async (t) => {
    const { base } = await createTestApi(t, {
      importTimeoutMs: 30,
      fetchImpl: (_url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }),
    });
    const session = await register(base, 'tiempo-agotado@example.com');

    const response = await call(base, '/api/import/todos', { method: 'POST', token: session.token });
    assert.equal(response.status, 502);
    assert.match(response.body.error, /tardó demasiado en responder/);
  });

  it('returns a Spanish 502 when the external API responds with an error', async (t) => {
    const { base } = await createTestApi(t, {
      fetchImpl: async () => new Response('', { status: 503 }),
    });
    const session = await register(base, 'error-externo@example.com');

    const response = await call(base, '/api/import/todos', { method: 'POST', token: session.token });
    assert.equal(response.status, 502);
    assert.match(response.body.error, /no está disponible/);
  });

  it('returns a Spanish 502 when the external API returns invalid JSON', async (t) => {
    const { base } = await createTestApi(t, {
      fetchImpl: async () => new Response('{no es json', { status: 200 }),
    });
    const session = await register(base, 'json-invalido@example.com');

    const response = await call(base, '/api/import/todos', { method: 'POST', token: session.token });
    assert.equal(response.status, 502);
    assert.match(response.body.error, /JSON inválido/);
  });

  it('returns a Spanish 502 when the external API returns invalid records', async (t) => {
    const { base } = await createTestApi(t, {
      fetchImpl: async () => new Response(JSON.stringify([{ title: 'Sin identificador' }]), { status: 200 }),
    });
    const session = await register(base, 'datos-invalidos@example.com');

    const response = await call(base, '/api/import/todos', { method: 'POST', token: session.token });
    assert.equal(response.status, 502);
    assert.match(response.body.error, /datos inválidos/);
  });

  it('uses the configurable source name when importing', async (t) => {
    const { base } = await createTestApi(t, {
      importSourceName: 'Tareas Demo',
      fetchImpl: async () =>
        new Response(JSON.stringify([{ id: 5, title: 'Externa', completed: true, userId: 2 }]), { status: 200 }),
    });
    const session = await register(base, 'origen-opcion@example.com');

    const response = await call(base, '/api/import/todos', { method: 'POST', token: session.token });
    assert.equal(response.status, 200);
    const task = response.body.imported[0];
    assert.equal(task.importInfo.source, 'Tareas Demo');
    assert.equal(task.importInfo.importKey, 'tareas demo:5');
    assert.equal(task.id, 'import-tareas-demo-5');
    assert.match(task.description, /Tareas Demo/);
  });

  it('reads the source name from the environment variable', (t) => {
    const previous = process.env.IMPORT_SOURCE_NAME;
    process.env.IMPORT_SOURCE_NAME = 'Desde Entorno';
    t.after(() => {
      if (previous === undefined) {
        delete process.env.IMPORT_SOURCE_NAME;
      } else {
        process.env.IMPORT_SOURCE_NAME = previous;
      }
    });

    assert.equal(createConfig({ importUrl: 'https://jsonplaceholder.typicode.com/todos' }).importSourceName, 'Desde Entorno');
  });

  it('derives the source name from the URL when not configured', (t) => {
    const previous = process.env.IMPORT_SOURCE_NAME;
    delete process.env.IMPORT_SOURCE_NAME;
    t.after(() => {
      if (previous !== undefined) {
        process.env.IMPORT_SOURCE_NAME = previous;
      }
    });

    assert.equal(createConfig({ importUrl: 'https://todos.ejemplo.test/api' }).importSourceName, 'Todos');
    assert.equal(
      createConfig({ importUrl: 'https://jsonplaceholder.typicode.com/todos' }).importSourceName,
      'JSONPlaceholder',
    );
    assert.equal(createConfig({ importUrl: 'http://127.0.0.1:3000/api/mock/todos' }).importSourceName, 'JSONPlaceholder');
  });

  it('reports records skipped by the import limit', async (t) => {
    const external = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      title: `Tarea ${index + 1}`,
      completed: false,
      userId: 1,
    }));
    const { base } = await createTestApi(t, {
      importLimit: 2,
      fetchImpl: async () => new Response(JSON.stringify(external), { status: 200 }),
    });
    const session = await register(base, 'limite@example.com');

    const response = await call(base, '/api/import/todos', { method: 'POST', token: session.token });
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 5);
    assert.equal(response.body.imported.length, 2);
    assert.equal(response.body.skippedLimit, 3);
    assert.equal(response.body.skippedInvalid, 0);
    assert.equal(response.body.skippedDuplicates, 0);
  });

  it('counts invalid and limit-skipped records separately', () => {
    const result = mapExternalTodos(
      [
        { id: 1, title: 'Uno' },
        { title: 'Inválido' },
        { id: 2, title: 'Dos' },
        { id: 3, title: 'Tres' },
      ],
      { sourceName: 'Demo', limit: 2, now: () => '2026-07-02T00:00:00.000Z' },
    );

    assert.equal(result.tasks.length, 2);
    assert.equal(result.skippedInvalid, 1);
    assert.equal(result.skippedLimit, 1);
  });

  it('keeps imports idempotent per user', async (t) => {
    const external = [
      { id: 21, title: 'Compartida', completed: false, userId: 8 },
      { id: 22, title: 'Otra', completed: true, userId: 8 },
    ];
    const { base } = await createTestApi(t, {
      importSourceName: 'Compartida',
      fetchImpl: async () => new Response(JSON.stringify(external), { status: 200 }),
    });
    const first = await register(base, 'import-idempotente-a@example.com');
    const second = await register(base, 'import-idempotente-b@example.com');

    for (const session of [first, second]) {
      const initial = await call(base, '/api/import/todos', { method: 'POST', token: session.token });
      assert.equal(initial.body.imported.length, 2);

      const repeated = await call(base, '/api/import/todos', { method: 'POST', token: session.token });
      assert.equal(repeated.body.imported.length, 0);
      assert.equal(repeated.body.skippedDuplicates, 2);

      const tasks = await call(base, '/api/tasks', { token: session.token });
      assert.equal(tasks.body.tasks.length, 2);
    }
  });

  it('accepts the client field limits and dataUrl photos', async (t) => {
    const { base } = await createTestApi(t);
    const session = await register(base, 'limites@example.com');
    const title = 'T'.repeat(TASK_LIMITS.title);
    const description = 'D'.repeat(TASK_LIMITS.description);
    const dataUrl = `data:image/png;base64,${'A'.repeat(2048)}`;

    const response = await call(base, '/api/tasks', {
      method: 'PUT',
      token: session.token,
      body: taskPayload('task-limites', title, '2026-09-01T00:00:00.000Z', {
        description,
        photo: { path: 'tasks/foto.png', name: 'foto.png', mimeType: 'image/png', dataUrl },
        location: { latitude: 1, longitude: 2, accuracy: null, capturedAt: '2026-09-01T00:00:00.000Z' },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.task.title, title);
    assert.equal(response.body.task.description, description);
    assert.equal(response.body.task.photo.dataUrl, dataUrl);

    const truncated = await call(base, '/api/tasks', {
      method: 'PUT',
      token: session.token,
      body: taskPayload('task-limites-2', 'T'.repeat(TASK_LIMITS.title + 20), '2026-09-02T00:00:00.000Z', {
        description: 'D'.repeat(TASK_LIMITS.description + 50),
      }),
    });
    assert.equal(truncated.status, 200);
    assert.equal(truncated.body.task.title.length, TASK_LIMITS.title);
    assert.equal(truncated.body.task.description.length, TASK_LIMITS.description);
  });

  it('accepts a dataUrl at the maximum allowed size via the API', async (t) => {
    const { base } = await createTestApi(t);
    const session = await register(base, 'foto-grande@example.com');
    const prefix = 'data:image/jpeg;base64,';
    const dataUrl = `${prefix}${'A'.repeat(TASK_LIMITS.photoDataUrl - prefix.length)}`;

    const response = await call(base, '/api/tasks', {
      method: 'PUT',
      token: session.token,
      body: taskPayload('task-foto-api', 'Foto grande', '2026-09-04T00:00:00.000Z', {
        photo: { path: 'tasks/f.jpg', name: 'f.jpg', mimeType: 'image/jpeg', dataUrl },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.task.photo.dataUrl, dataUrl);
  });

  it('caps the photo dataUrl size without dropping valid photos', () => {
    const basePhoto = { path: 'tasks/foto.jpg', name: 'foto.jpg', mimeType: 'image/jpeg' };
    const dataUrl = `data:image/jpeg;base64,${'A'.repeat(2048)}`;
    const valid = normalizeTask(
      taskPayload('task-foto-valida', 'Foto válida', '2026-09-03T00:00:00.000Z', {
        photo: { ...basePhoto, dataUrl },
      }),
      'user-1',
    );
    assert.equal(valid.photo.dataUrl, dataUrl);

    const oversized = normalizeTask(
      taskPayload('task-foto-grande', 'Foto grande', '2026-09-03T00:00:00.000Z', {
        photo: { ...basePhoto, dataUrl: `data:image/jpeg;base64,${'A'.repeat(TASK_LIMITS.photoDataUrl + 100)}` },
      }),
      'user-1',
    );
    assert.equal(oversized.photo.dataUrl.length, TASK_LIMITS.photoDataUrl);
  });

  it('sanitizes the sync tombstone by stripping photo and location', async (t) => {
    const { base } = await createTestApi(t);
    const session = await register(base, 'tumba@example.com');
    const photo = { path: 'tasks/f.jpg', name: 'f.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,QUJD' };
    const location = { latitude: 10, longitude: 20, accuracy: null, capturedAt: '2026-10-01T00:00:00.000Z' };

    await call(base, '/api/tasks', {
      method: 'PUT',
      token: session.token,
      body: taskPayload('task-tumba', 'Con foto', '2026-10-01T00:00:00.000Z', { photo, location }),
    });

    const deleted = await call(base, '/api/tasks/task-tumba?opId=op-tumba&deletedAt=2026-10-02T00:00:00.000Z', {
      method: 'DELETE',
      token: session.token,
    });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.task.deleted, true);
    assert.equal(deleted.body.task.title, 'Con foto');
    assert.equal(deleted.body.task.lastOpId, 'op-tumba');
    assert.ok(!Object.hasOwn(deleted.body.task, 'photo'));
    assert.ok(!Object.hasOwn(deleted.body.task, 'location'));

    const stored = await call(base, '/api/tasks', { token: session.token });
    assert.equal(stored.body.tasks[0].deleted, true);
    assert.ok(!Object.hasOwn(stored.body.tasks[0], 'photo'));
    assert.ok(!Object.hasOwn(stored.body.tasks[0], 'location'));
  });

  it('syncs the same account across two sessions via GET and SSE without reloading', async (t) => {
    const { base } = await createTestApi(t, { importSourceName: 'Fuente Prueba' });
    const sessionA = await register(base, 'dos-clientes@example.com');
    const loginB = await call(base, '/api/auth/login', {
      method: 'POST',
      body: { email: 'dos-clientes@example.com', password: 'password123' },
    });
    assert.equal(loginB.status, 200);
    assert.equal(loginB.body.user.id, sessionA.user.id);
    const sessionB = loginB.body;

    const events = await openEventStream(base, sessionB.token, t);
    const photo = {
      path: 'tasks/foto.jpg',
      name: 'foto.jpg',
      mimeType: 'image/jpeg',
      dataUrl: 'data:image/jpeg;base64,QUJD',
    };
    const location = { latitude: 40.4168, longitude: -3.7038, accuracy: 12, capturedAt: '2026-08-01T10:00:00.000Z' };
    const importInfo = {
      source: 'Fuente Prueba',
      sourceId: '77',
      importKey: 'fuente prueba:77',
      completed: false,
      sourceUserId: 3,
    };

    const created = await call(base, '/api/tasks', {
      method: 'PUT',
      token: sessionA.token,
      body: taskPayload('task-sync', 'Tarea compartida', '2026-08-01T12:00:00.000Z', {
        photo,
        location,
        importInfo,
        opId: 'op-crear',
      }),
    });
    assert.equal(created.status, 200);

    const afterCreate = await call(base, '/api/tasks', { token: sessionB.token });
    assert.equal(afterCreate.body.tasks.length, 1);
    const syncedCreate = afterCreate.body.tasks[0];
    assert.equal(syncedCreate.title, 'Tarea compartida');
    assert.deepEqual(syncedCreate.photo, photo);
    assert.deepEqual(syncedCreate.location, location);
    assert.deepEqual(syncedCreate.importInfo, importInfo);
    assert.equal(syncedCreate.updatedAt, '2026-08-01T12:00:00.000Z');
    assert.equal(syncedCreate.lastOpId, 'op-crear');

    const edited = await call(base, '/api/tasks', {
      method: 'PUT',
      token: sessionA.token,
      body: {
        ...created.body.task,
        title: 'Tarea compartida editada',
        description: 'Descripción editada desde la sesión A',
        updatedAt: '2026-08-01T13:00:00.000Z',
        photo: { ...photo, name: 'foto-editada.jpg' },
        location: { ...location, accuracy: 5 },
        opId: 'op-editar',
      },
    });
    assert.equal(edited.status, 200);

    const afterEdit = await call(base, '/api/tasks', { token: sessionB.token });
    assert.equal(afterEdit.body.tasks.length, 1);
    const syncedEdit = afterEdit.body.tasks[0];
    assert.equal(syncedEdit.title, 'Tarea compartida editada');
    assert.equal(syncedEdit.photo.name, 'foto-editada.jpg');
    assert.equal(syncedEdit.location.accuracy, 5);
    assert.deepEqual(syncedEdit.importInfo, importInfo);
    assert.equal(syncedEdit.updatedAt, '2026-08-01T13:00:00.000Z');
    assert.equal(syncedEdit.lastOpId, 'op-editar');

    const deleted = await call(base, '/api/tasks/task-sync?opId=op-eliminar&deletedAt=2026-08-01T14:00:00.000Z', {
      method: 'DELETE',
      token: sessionA.token,
    });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.task.deleted, true);
    assert.equal(deleted.body.task.updatedAt, '2026-08-01T14:00:00.000Z');
    assert.equal(deleted.body.task.lastOpId, 'op-eliminar');

    const afterDelete = await call(base, '/api/tasks', { token: sessionB.token });
    assert.equal(afterDelete.body.tasks.length, 1);
    assert.equal(afterDelete.body.tasks[0].deleted, true);
    assert.equal(afterDelete.body.tasks[0].updatedAt, '2026-08-01T14:00:00.000Z');
    assert.equal(afterDelete.body.tasks[0].lastOpId, 'op-eliminar');
    assert.ok(!Object.hasOwn(afterDelete.body.tasks[0], 'photo'));
    assert.ok(!Object.hasOwn(afterDelete.body.tasks[0], 'location'));

    const streamed = await events.waitFor(3);
    assert.deepEqual(
      streamed.map(({ event }) => event),
      ['task-upsert', 'task-upsert', 'task-delete'],
    );
    assert.deepEqual(streamed[0].task.photo, photo);
    assert.deepEqual(streamed[0].task.location, location);
    assert.deepEqual(streamed[0].task.importInfo, importInfo);
    assert.equal(streamed[0].task.updatedAt, '2026-08-01T12:00:00.000Z');
    assert.equal(streamed[0].task.lastOpId, 'op-crear');
    assert.equal(streamed[1].task.title, 'Tarea compartida editada');
    assert.equal(streamed[1].task.photo.name, 'foto-editada.jpg');
    assert.equal(streamed[1].task.location.accuracy, 5);
    assert.equal(streamed[1].task.updatedAt, '2026-08-01T13:00:00.000Z');
    assert.equal(streamed[1].task.lastOpId, 'op-editar');
    assert.equal(streamed[2].task.deleted, true);
    assert.equal(streamed[2].task.updatedAt, '2026-08-01T14:00:00.000Z');
    assert.equal(streamed[2].task.lastOpId, 'op-eliminar');
    assert.ok(!Object.hasOwn(streamed[2].task, 'photo'));
    assert.ok(!Object.hasOwn(streamed[2].task, 'location'));
  });
});
