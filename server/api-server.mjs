import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { HttpError, hashPassword, signToken, verifyPassword, verifyToken } from './auth.mjs';
import { createConfig } from './config.mjs';
import { mapExternalTodos } from './import.mapper.mjs';
import { JsonStore, TASK_LIMITS, normalizeTask } from './store.mjs';

const MAX_BODY_BYTES = TASK_LIMITS.photoDataUrl + 1_000_000;

function sendJson(res, status, body) {
  if (res.headersSent) {
    return;
  }

  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res, error) {
  if (res.headersSent) {
    return;
  }

  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof HttpError ? error.message : 'Ocurrió un error inesperado en el servidor.';
  const body = { error: message };

  if (error instanceof HttpError && error.details) {
    body.details = error.details;
  }

  sendJson(res, status, body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'La solicitud es demasiado grande.');
    }

    chunks.push(chunk);
  }

  if (size === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'El cuerpo de la solicitud no es un JSON válido.');
  }
}

function validateCredentials(body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'Ingresa un correo electrónico válido.');
  }

  if (password.length < 8) {
    throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres.');
  }

  return { email, password };
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name };
}

export function createApiServer(options = {}) {
  const config = createConfig(options);
  const store = options.store || new JsonStore(config.storePath);
  const fetchImpl = options.fetchImpl || fetch;
  const subscribers = new Map();

  function applyCors(req, res) {
    const origin = req.headers.origin;
    const headers = {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Expose-Headers': 'Content-Type',
      Vary: 'Origin',
    };

    if (origin && config.allowedOrigins.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
    }

    res.setHeader('Vary', headers.Vary);

    if (headers['Access-Control-Allow-Origin']) {
      res.setHeader('Access-Control-Allow-Origin', headers['Access-Control-Allow-Origin']);
      res.setHeader('Access-Control-Allow-Methods', headers['Access-Control-Allow-Methods']);
      res.setHeader('Access-Control-Allow-Headers', headers['Access-Control-Allow-Headers']);
      res.setHeader('Access-Control-Expose-Headers', headers['Access-Control-Expose-Headers']);
    }
  }

  function authenticate(req, url) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
    const payload = verifyToken(token, config.secret);
    const user = store.getUserById(payload.sub);

    if (!user) {
      throw new HttpError(401, 'Sesión inválida. Vuelve a iniciar sesión.');
    }

    return user;
  }

  function broadcast(userId, event, task) {
    const connections = subscribers.get(userId);

    if (!connections) {
      return;
    }

    const message = `event: ${event}\ndata: ${JSON.stringify(task)}\n\n`;

    for (const res of connections) {
      if (!res.writableEnded) {
        res.write(message);
      }
    }
  }

  function openEventStream(req, res, user) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': conectado\n\n');

    if (!subscribers.has(user.id)) {
      subscribers.set(user.id, new Set());
    }

    subscribers.get(user.id).add(res);

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': ping\n\n');
      }
    }, 20_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      subscribers.get(user.id)?.delete(res);

      if (subscribers.get(user.id)?.size === 0) {
        subscribers.delete(user.id);
      }
    });
  }

  function upsertTaskForUser(user, body, taskId) {
    if (taskId && body.id && body.id !== taskId) {
      throw new HttpError(400, 'El identificador de la tarea no coincide.');
    }

    const id = taskId || body.id;
    const opId = typeof body.opId === 'string' ? body.opId.slice(0, TASK_LIMITS.opId) : '';
    const incoming = normalizeTask({ ...body, id }, user.id);
    const existing = store.getTask(user.id, id);

    if (existing && existing.lastOpId && existing.lastOpId === opId) {
      return { task: existing, saved: false };
    }

    if (existing && Date.parse(incoming.updatedAt) <= Date.parse(existing.updatedAt)) {
      throw new HttpError(409, 'Otra versión de la tarea es más reciente.', { task: existing });
    }

    const task = store.upsertTask(incoming, opId || undefined);
    broadcast(user.id, 'task-upsert', task);
    return { task, saved: true };
  }

  async function handleRequest(req, res) {
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, 'http://localhost');

    try {
      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/mock/todos') {
        sendJson(res, 200, [
          { id: 101, title: 'Preparar la evaluación', completed: false, userId: 7 },
          { id: 102, title: 'Revisar permisos de cámara', completed: true, userId: 7 },
          { id: 103, title: 'Probar sincronización', completed: false, userId: 7 },
        ]);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/register') {
        const body = await readJson(req);
        const { email, password } = validateCredentials(body);
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';

        if (store.getUserByEmail(email)) {
          throw new HttpError(409, 'Ya existe una cuenta con ese correo.');
        }

        const user = {
          id: randomUUID(),
          email,
          name: name.slice(0, 60),
          passwordHash: hashPassword(password),
        };

        store.addUser(user);
        sendJson(res, 201, { user: publicUser(user), token: signToken(user, config.secret) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJson(req);
        const { email, password } = validateCredentials(body);
        const user = store.getUserByEmail(email);

        if (!user || !verifyPassword(password, user.passwordHash)) {
          throw new HttpError(401, 'Correo o contraseña incorrectos.');
        }

        sendJson(res, 200, { user: publicUser(user), token: signToken(user, config.secret) });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        const user = authenticate(req, url);
        sendJson(res, 200, publicUser(user));
        return;
      }

      if (!url.pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'Ruta no encontrada.' });
        return;
      }

      const user = authenticate(req, url);

      if (req.method === 'GET' && url.pathname === '/api/tasks/events') {
        openEventStream(req, res, user);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/tasks') {
        const sinceValue = url.searchParams.get('since');
        const since = sinceValue ? Date.parse(sinceValue) : null;

        if (sinceValue && Number.isNaN(since)) {
          throw new HttpError(400, 'La fecha de sincronización no es válida.');
        }

        const tasks = store
          .tasksForUser(user.id)
          .filter((task) => since === null || Date.parse(task.updatedAt) > since)
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

        sendJson(res, 200, { tasks, serverTime: new Date().toISOString() });
        return;
      }

      if (req.method === 'PUT' && url.pathname === '/api/tasks') {
        const body = await readJson(req);
        const result = upsertTaskForUser(user, body);
        sendJson(res, 200, { task: result.task });
        return;
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);

      if (taskMatch && req.method === 'PUT') {
        const body = await readJson(req);
        const result = upsertTaskForUser(user, body, decodeURIComponent(taskMatch[1]));
        sendJson(res, 200, { task: result.task });
        return;
      }

      if (taskMatch && req.method === 'DELETE') {
        const taskId = decodeURIComponent(taskMatch[1]);
        const opId = url.searchParams.get('opId')?.slice(0, TASK_LIMITS.opId) || '';
        const deletedAt = url.searchParams.get('deletedAt') || new Date().toISOString();

        if (Number.isNaN(Date.parse(deletedAt))) {
          throw new HttpError(400, 'La fecha de eliminación no es válida.');
        }

        const existing = store.getTask(user.id, taskId);

        if (existing?.lastOpId && opId && existing.lastOpId === opId) {
          sendJson(res, 200, { task: existing });
          return;
        }

        const task = store.deleteTask(user.id, taskId, new Date(deletedAt).toISOString(), opId || undefined);
        broadcast(user.id, 'task-delete', task);
        sendJson(res, 200, { task });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/import/todos') {
        const existingKeys = store.importKeysForUser(user.id);
        let response;

        try {
          response = await fetchImpl(config.importUrl, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(config.importTimeoutMs),
          });
        } catch (error) {
          if (error instanceof HttpError) {
            throw error;
          }

          const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';

          throw new HttpError(
            502,
            timedOut
              ? 'La API externa tardó demasiado en responder.'
              : 'No se pudo conectar con la API externa. Inténtalo de nuevo más tarde.',
          );
        }

        if (!response.ok) {
          throw new HttpError(502, 'La API externa no está disponible en este momento.', {
            status: response.status,
          });
        }

        let payload;

        try {
          payload = await response.json();
        } catch {
          throw new HttpError(502, 'La API externa devolvió un JSON inválido.');
        }

        const mapped = mapExternalTodos(payload, {
          sourceName: config.importSourceName,
          existingKeys,
          limit: config.importLimit,
        });
        const imported = [];

        for (const task of mapped.tasks) {
          const saved = store.upsertTask(
            normalizeTask({ ...task, userId: user.id }, user.id),
            `import:${task.importInfo.importKey}`,
          );
          imported.push(saved);
          broadcast(user.id, 'task-upsert', saved);
        }

        sendJson(res, 200, {
          imported,
          skippedDuplicates: mapped.skippedDuplicates,
          skippedInvalid: mapped.skippedInvalid,
          skippedLimit: mapped.skippedLimit,
          total: payload.length,
        });
        return;
      }

      sendJson(res, 404, { error: 'Ruta no encontrada.' });
    } catch (error) {
      sendError(res, error);
    }
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  function listen(port = config.port, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve(server.address());
      });
    });
  }

  function close() {
    return new Promise((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  return { server, store, config, broadcast, listen, close };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const api = createApiServer();

  api.listen().then((address) => {
    if (api.config.ephemeralSecret) {
      console.warn('API_JWT_SECRET no definido: se generó una clave temporal. Configúrala en server/.env para producción.');
    }

    console.log(`API de Mis Tareas escuchando en http://localhost:${address.port}`);
  });
}
