import { expect, test, type Page } from '@playwright/test';

const baseURL = 'http://localhost:4200';
const photoBuffer = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

function uniqueEmail(label: string): string {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  return `${label}-${suffix}@ejemplo.test`;
}

async function fillAuthForm(page: Page, email: string, password: string, name?: string): Promise<void> {
  if (name !== undefined) {
    await page.getByTestId('name-input').locator('input:not(.cloned-input)').fill(name);
  }

  await page.getByTestId('email-input').locator('input:not(.cloned-input)').fill(email);
  await page.getByTestId('password-input').locator('input:not(.cloned-input)').fill(password);
}

async function register(page: Page, name: string, email: string, password = 'password123'): Promise<void> {
  await page.goto('/login');
  await expect(page.locator('h1')).toContainText('Bienvenido de nuevo');

  await page.getByTestId('auth-mode').click();
  await expect(page.locator('h1')).toContainText('Crea tu cuenta');

  await fillAuthForm(page, email, password, name);
  await page.getByTestId('auth-submit').click();

  await expect(page).toHaveURL(/\/home$/);
  await expect(page.locator('#page-heading')).toBeVisible();
}

async function login(page: Page, email: string, password = 'password123'): Promise<void> {
  await page.goto('/login');
  await expect(page.locator('h1')).toContainText('Bienvenido de nuevo');

  await fillAuthForm(page, email, password);
  await page.getByTestId('auth-submit').click();

  await expect(page).toHaveURL(/\/home$/);
  await expect(page.locator('#page-heading')).toBeVisible();
}

async function addTask(page: Page, title: string, description: string): Promise<void> {
  await page.getByTestId('title-input').locator('input:not(.cloned-input)').fill(title);
  await page.getByTestId('description-input').locator('textarea:not(.cloned-input)').fill(description);
  await page.getByTestId('save-task').click();
  await expect(page.locator('.task-item h2').first()).toHaveText(title);
}

async function failGeolocation(page: Page, code: number): Promise<void> {
  await page.addInitScript((errorCode) => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (_success: unknown, onError: (error: { code: number; message: string }) => void) =>
          onError({ code: errorCode, message: 'Ubicación simulada no disponible' }),
        watchPosition: () => 0,
        clearWatch: () => undefined,
      },
    });
  }, code);
}

// --use-fake-ui-for-media-stream (see playwright.config.ts) always auto-accepts the
// camera prompt, so a real permission denial can't be reproduced through Chromium
// flags or context.grantPermissions(). Stubbing getUserMedia's rejection is the only
// deterministic way to exercise that branch in headless E2E.
async function denyCameraStream(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (!navigator.mediaDevices) {
      return;
    }

    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
  });
}

test('registers a user and performs the full task CRUD with persistence', async ({ page }) => {
  await register(page, 'Ana Prueba', uniqueEmail('ana'));

  await expect(page.getByRole('heading', { name: '¿Qué tienes pendiente?' })).toBeVisible();
  await expect(page.getByText('Aún no tienes tareas')).toBeVisible();

  const submitButton = page.getByTestId('save-task');

  await page.getByTestId('title-input').locator('input:not(.cloned-input)').fill('   ');
  await page.getByTestId('description-input').locator('textarea:not(.cloned-input)').fill('   ');
  await expect(submitButton).toHaveClass(/button-disabled/);

  await addTask(page, 'Study Ionic', 'Review components and forms');
  await expect(page.locator('.task-item').first()).toContainText('Sin foto');
  await expect(page.locator('.task-item').first()).toContainText('Sin ubicación');
  await expect(page.getByTestId('task-counter')).toHaveText('1');

  await page.locator('.task-actions ion-button').first().click();
  await expect(page.locator('#page-heading')).toContainText('Edita tu tarea');
  await expect(page.getByTestId('title-input').locator('input:not(.cloned-input)')).toHaveValue('Study Ionic');

  await page.getByTestId('title-input').locator('input:not(.cloned-input)').fill('Study Ionic and Angular');
  await submitButton.click();
  await expect(page.locator('.task-item h2').first()).toHaveText('Study Ionic and Angular');

  await page.reload();
  await expect(page.locator('.task-item h2').first()).toHaveText('Study Ionic and Angular');

  await page.locator('.task-actions ion-button').last().click();
  await expect(page.locator('ion-alert')).toContainText('¿Seguro que quieres eliminar');
  await page.locator('ion-alert .alert-button', { hasText: 'Eliminar' }).click();

  await expect(page.getByText('Aún no tienes tareas')).toBeVisible();
  await expect(page.getByTestId('task-counter')).toHaveText('0');

  await page.reload();
  await expect(page.getByText('Aún no tienes tareas')).toBeVisible();
});

test('isolates tasks between accounts', async ({ page }) => {
  const firstEmail = uniqueEmail('user-a');
  const secondEmail = uniqueEmail('user-b');

  await register(page, 'Usuario Uno', firstEmail);
  await addTask(page, 'Solo del primer usuario', 'No debe aparecer para el segundo');
  await expect(page.getByTestId('task-counter')).toHaveText('1');

  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/\/login$/);

  await register(page, 'Usuario Dos', secondEmail);
  await expect(page.getByText('Aún no tienes tareas')).toBeVisible();
  await expect(page.getByTestId('task-counter')).toHaveText('0');

  await page.getByTestId('logout').click();
  await login(page, firstEmail);

  await expect(page.locator('.task-item h2').first()).toHaveText('Solo del primer usuario');
  await expect(page.getByTestId('task-counter')).toHaveText('1');
});

test('imports external todos and skips duplicates', async ({ page }) => {
  await register(page, 'Importador', uniqueEmail('import'));

  await page.getByTestId('import-tasks').click();

  await expect(page.getByTestId('status-message')).toContainText('Se importaron 3 tareas');
  await expect(page.getByTestId('task-counter')).toHaveText('3');
  await expect(page.getByTestId('import-details').filter({ hasText: 'JSONPlaceholder #101' })).toBeVisible();
  await expect(page.getByTestId('import-details').filter({ hasText: 'Usuario origen #7' }).first()).toBeVisible();

  await page.getByTestId('import-tasks').click();

  await expect(page.getByTestId('status-message')).toContainText('Se omitieron 3 registros');
  await expect(page.getByTestId('task-counter')).toHaveText('3');
});

test('queues changes offline and syncs them when the connection returns', async ({ page }) => {
  await register(page, 'Sin Conexión', uniqueEmail('offline'));

  await page.context().setOffline(true);
  await expect(page.getByTestId('sync-status')).toContainText('Sin conexión');

  await addTask(page, 'Creada sin conexión', 'Debe subir al recuperar la red');
  await expect(page.getByTestId('sync-status')).toContainText('1 cambio pendiente');

  await page.context().setOffline(false);
  await expect(page.getByTestId('sync-status')).toContainText('Sincronizado');

  await page.reload();
  await expect(page.locator('.task-item h2').first()).toHaveText('Creada sin conexión');
});

test('captures a photo and coordinates and keeps both after reopening the app', async ({ page, context }) => {
  await context.grantPermissions(['camera', 'geolocation'], { origin: baseURL });
  await context.setGeolocation({ latitude: -33.4489, longitude: -70.6693, accuracy: 10 });
  await register(page, 'Con Evidencia', uniqueEmail('evidencia'));

  await page.getByTestId('capture-photo').click();

  const captureButton = page.getByTestId('webcam-capture-button');
  await expect(captureButton).toBeEnabled();
  await captureButton.click();

  await expect(page.locator('.draft-photo img')).toBeVisible();
  await page.getByTestId('capture-location').click();
  await expect(page.getByTestId('draft-location')).toContainText('-33.44890');

  await addTask(page, 'Tarea con evidencia', 'Foto y coordenadas reales del navegador');
  await expect(page.locator('.task-photo')).toBeVisible();
  await expect(page.getByTestId('task-location')).toContainText('-33.44890');

  await page.reload();
  await expect(page.locator('.task-photo')).toBeVisible();
  await expect(page.getByTestId('task-location')).toContainText('-33.44890');
});

test('attaches an existing photo and saves it with the location', async ({ page, context }) => {
  await context.grantPermissions(['camera', 'geolocation'], { origin: baseURL });
  await context.setGeolocation({ latitude: -33.4489, longitude: -70.6693 });
  await register(page, 'Con Galería', uniqueEmail('galeria'));

  await expect(page.getByTestId('capture-photo')).toContainText('Tomar foto');
  await expect(page.getByTestId('attach-photo')).toHaveText('Adjuntar foto');

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('attach-photo').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: 'galeria.png', mimeType: 'image/png', buffer: photoBuffer });

  await expect(page.locator('.draft-photo img')).toBeVisible();
  await expect(page.getByTestId('status-message')).toContainText('Foto adjuntada');

  await page.getByTestId('title-input').locator('input:not(.cloned-input)').fill('Tarea con galería');
  await page.getByTestId('description-input').locator('textarea:not(.cloned-input)').fill('Foto adjunta');
  await page.evaluate(() => {
    const original = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    navigator.geolocation.getCurrentPosition = (success, error, options) => {
      window.addEventListener('resolve-test-location', () => original(success, error, options), { once: true });
    };
  });
  await page.getByTestId('capture-location').click();
  await expect(page.getByTestId('capture-location')).toContainText('Buscando ubicación');
  await expect(page.getByTestId('save-task').locator('button')).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('resolve-test-location')));
  await page.getByTestId('save-task').click();
  await expect(page.locator('.task-item')).toContainText('Tarea con galería');
  await page.reload();
  await expect(page.locator('.task-photo')).toBeVisible();
  await expect(page.getByTestId('task-location')).toContainText('-33.44890');
});

test('continues after a cancelled photo capture', async ({ page, context }) => {
  await context.grantPermissions(['camera'], { origin: baseURL });
  await register(page, 'Cancelación', uniqueEmail('cancel'));

  await page.getByTestId('capture-photo').click();
  await page.getByTestId('webcam-cancel-button').click();
  await expect(page.getByTestId('status-message')).toContainText('Captura cancelada');

  await addTask(page, 'Guardada tras cancelar', 'La cancelación no bloquea el guardado');
  await expect(page.locator('.task-item').first()).toContainText('Sin foto');
});

test('saves a task when camera permission is denied and GPS times out', async ({ page }) => {
  await denyCameraStream(page);
  await failGeolocation(page, 3);
  await register(page, 'Sin Permisos', uniqueEmail('permisos'));

  await page.getByTestId('capture-photo').click();
  await expect(page.getByTestId('status-message')).toContainText('Permiso de cámara denegado');

  await page.getByTestId('capture-location').click();
  await expect(page.getByTestId('status-message')).toContainText('tiempo');

  await addTask(page, 'Guardada sin periféricos', 'Los permisos no bloquean el guardado');
  await expect(page.locator('.task-item').first()).toContainText('Sin foto');
  await expect(page.locator('.task-item').first()).toContainText('Sin ubicación');
});

test('propagates create, edit and delete to a second client of the same account', async ({ browser }) => {
  const email = uniqueEmail('realtime');
  const firstContext = await browser.newContext({ baseURL });
  const secondContext = await browser.newContext({ baseURL });
  const firstClient = await firstContext.newPage();
  const secondClient = await secondContext.newPage();

  await register(firstClient, 'Cliente Uno', email);
  await addTask(firstClient, 'Cambio en vivo', 'Creada por el primer cliente');

  await login(secondClient, email);
  await expect(secondClient.locator('.task-item h2').first()).toHaveText('Cambio en vivo', { timeout: 10_000 });

  const item = firstClient.locator('.task-item').filter({ hasText: 'Cambio en vivo' });
  await item.getByTestId('edit-task').click();
  await firstClient.getByTestId('title-input').locator('input:not(.cloned-input)').fill('Cambio editado en vivo');
  await firstClient.getByTestId('save-task').click();
  await expect(secondClient.locator('.task-item h2').first()).toHaveText('Cambio editado en vivo', { timeout: 10_000 });

  await secondClient
    .locator('.task-item')
    .filter({ hasText: 'Cambio editado en vivo' })
    .getByTestId('delete-task')
    .click();
  await secondClient.locator('ion-alert .alert-button', { hasText: 'Eliminar' }).click();
  await expect(firstClient.getByText('Aún no tienes tareas')).toBeVisible({ timeout: 10_000 });
});

test('restores offline edits and deletions after reopening and reconnecting', async ({ page }) => {
  const email = uniqueEmail('offline-restart');
  await register(page, 'Reinicio Offline', email);
  await addTask(page, 'Persistente A', 'Se editará sin conexión');
  await addTask(page, 'Persistente B', 'Se eliminará sin conexión');

  await page.route('**/api/**', (route) => route.abort('failed'));

  const editedItem = page.locator('.task-item').filter({ hasText: 'Persistente A' });
  await editedItem.getByTestId('edit-task').click();
  await page.getByTestId('title-input').locator('input:not(.cloned-input)').fill('Persistente A editada');
  await page.getByTestId('save-task').click();
  await expect(page.locator('.task-item').filter({ hasText: 'Persistente A editada' })).toBeVisible();

  const deletedItem = page.locator('.task-item').filter({ hasText: 'Persistente B' });
  await deletedItem.getByTestId('delete-task').click();
  await page.locator('ion-alert .alert-button', { hasText: 'Eliminar' }).click();
  await expect(page.getByTestId('sync-status')).toContainText('2 cambios pendientes');

  await page.reload();
  await expect(page.locator('.task-item').filter({ hasText: 'Persistente A editada' })).toBeVisible();
  await expect(page.locator('.task-item').filter({ hasText: 'Persistente B' })).toHaveCount(0);
  await expect(page.getByTestId('sync-status')).toContainText('2 cambios pendientes');

  await page.unroute('**/api/**');
  await expect(page.getByTestId('sync-button')).toBeEnabled();
  await page.getByTestId('sync-button').click();
  await expect(page.getByTestId('sync-status')).toContainText('Sincronizado');
  await expect(page.getByTestId('sync-status')).not.toContainText('pendiente');

  await page.reload();
  await expect(page.locator('.task-item').filter({ hasText: 'Persistente A editada' })).toBeVisible();
  await expect(page.locator('.task-item').filter({ hasText: 'Persistente B' })).toHaveCount(0);
});
