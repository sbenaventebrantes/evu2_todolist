# Mis Tareas — Evaluación Sumativa Unidad 2

## Integrantes del equipo

- **Mixiu Perez**
- **Sofia Benavente**

---

## 1. Presentación

**Mis Tareas** es una aplicación móvil tipo lista de tareas construida con **Ionic, Angular y TypeScript**. La versión U2 conserva la interfaz de la U1 y agrega persistencia local, cámara, geolocalización, cuentas de usuario, una API propia, sincronización, importación desde una API externa y cobertura de pruebas.

La aplicación permite registrar tareas con título y descripción, adjuntar una foto y coordenadas cuando el dispositivo lo permita, trabajar sin conexión y sincronizar los cambios al recuperar la red.

## 2. Objetivo

Aplicar los contenidos de la Unidad 2: almacenamiento persistente, periféricos del dispositivo, permisos, autenticación, consumo y creación de APIs, sincronización, pruebas unitarias/de integración/de extremo a extremo y documentación de evidencias.

## 3. Tecnologías utilizadas

| Tecnología | Uso en el proyecto |
|------------|--------------------|
| **Ionic 9** | Componentes de interfaz móvil |
| **Angular 22** | Componentes standalone, formularios reactivos, señales y enrutamiento |
| **TypeScript 6** | Modelos, servicios y tipado estricto |
| **Capacitor 8** | Acceso a almacenamiento, cámara, GPS y red |
| `@capacitor/preferences` | Persistencia local de tareas, cola y sesión |
| `@capacitor/filesystem` | Persistencia de fotos nativas |
| `@capacitor/camera` | Captura de fotos |
| `@capacitor/geolocation` | Captura de coordenadas |
| `@capacitor/network` | Estado de conexión y eventos online/offline |
| **Node.js** | Servidor API propio sin dependencias externas |
| **Vitest** | Pruebas unitarias |
| **Node Test Runner** | Pruebas de la API |
| **Playwright** | Pruebas de extremo a extremo |

## 4. Requisitos previos e instalación

- Node.js compatible con Angular 22 y npm.
- Navegador Chromium para Playwright.

```bash
npm ci
npx playwright install chromium
```

## 5. Comandos

```bash
# Servidor API (terminal 1)
npm run api

# Aplicación web (terminal 2)
npm start

# Compilación de producción
npm run build

# Pruebas
npm run test:unit
npm run test:api
npm run test:e2e
npm test

# Calidad
npm run lint
npm run lint:fix
```

La aplicación web queda en `http://localhost:4200` y la API en `http://localhost:3000`. `npm test` ejecuta unitarias, API y E2E en ese orden.

## 6. Configuración

Si todavía no existe `server/.env`, copia el ejemplo y reemplaza el valor de `API_JWT_SECRET` por un secreto aleatorio.

```bash
cp server/.env.example server/.env
```

Variables disponibles:

| Variable | Descripción | Valor por defecto |
|----------|-------------|-------------------|
| `API_JWT_SECRET` | Secreto para firmar tokens JWT | Clave temporal aleatoria con aviso |
| `API_PORT` | Puerto del servidor API | `3000` |
| `API_STORE_PATH` | Archivo JSON del servidor | `server/data/store.json` |
| `IMPORT_SOURCE_URL` | API externa a importar | JSONPlaceholder |
| `IMPORT_SOURCE_NAME` | Etiqueta visible de la fuente importada | Derivada de `IMPORT_SOURCE_URL` |
| `IMPORT_LIMIT` | Cantidad máxima de registros importados | `10` sin configurar. El archivo de ejemplo usa `3`. |
| `ALLOWED_ORIGINS` | Orígenes de la app permitidos por CORS | `http://localhost:4200`, `http://localhost:8100` |

> `server/.env`, `server/data/` y otros archivos de entorno están ignorados por Git. No subir secretos reales al repositorio.

`apiUrl` en `src/environments/environment.ts` y `src/environments/environment.prod.ts` apunta a la API. Configura `ALLOWED_ORIGINS` con los orígenes desde los que se ejecuta la app. Para los valores de desarrollo nativo, consulta la sección 10.

## 7. Estructura principal

```text
src/
├── app/
│   ├── home/                 # Pantalla principal y elementos adjuntos
│   ├── login/                # Inicio de sesión y registro
│   ├── guards/               # Protección de rutas
│   ├── interceptors/         # Envío automático del token JWT
│   ├── models/               # Task, AuthSession, Sync
│   ├── services/             # Auth, TaskService, API, red, periféricos, storage
│   ├── testing/              # Dobles compartidos por pruebas unitarias
│   ├── tokens/               # Tokens de inyección para plugins
│   └── utils/                # Normalización y mensajes de error
├── environments/             # URL de la API
└── main.ts                   # Providers de HTTP e Ionic
server/
├── api-server.mjs            # Rutas, SSE e importación
├── auth.mjs                  # JWT y hash de contraseñas
├── config.mjs                # Configuración desde entorno
├── import.mapper.mjs         # Validación y mapeo externo
├── store.mjs                 # Persistencia JSON del servidor
└── api-server.test.mjs       # Pruebas de API
e2e/app.spec.ts               # Flujos completos con Playwright
playwright.config.ts          # Levanta la app y la API
capacitor.config.ts           # Identificador, nombre y permisos nativos
```

## 8. Funcionalidades implementadas

### Periféricos y permisos

- La app ofrece dos acciones independientes: **Tomar foto** abre la cámara y **Adjuntar foto** abre la galería o un selector de archivos.
- Los permisos se solicitan **cuando el usuario pulsa** una de esas acciones o "Registrar ubicación", no al iniciar la app.
- La cámara usa `takePhoto`, la galería usa `chooseFromGallery` y el GPS usa `getCurrentPosition` con alta precisión.
- Si el permiso es denegado, el GPS está deshabilitado o la captura se cancela, la app muestra un mensaje en español y permite guardar la tarea sin ese dato. En navegador usa las APIs web como respaldo para seleccionar/capturar una imagen y solicitar la ubicación.
- Las fotos se guardan en `Directory.Data` en nativo y como `dataUrl` en navegador.
- La pantalla muestra **Buscando ubicación…** y espera el resultado antes de habilitar el guardado. Si la búsqueda tiene éxito, muestra latitud, longitud y precisión aproximada. La foto y las coordenadas quedan asociadas a la misma tarea.

### Almacenamiento local

- Las tareas, la cola de cambios y la última sincronización se guardan por usuario: `tasks:<userId>`, `queue:<userId>` y `lastSync:<userId>`.
- La sesión se guarda por separado en `auth:session`.
- En web se usa `localStorage`; en dispositivo se usa Capacitor Preferences.
- Si falla una escritura local, la operación se rechaza y el estado de la lista no cambia.

### Autenticación

- Registro e inicio de sesión contra la API propia.
- Contraseñas hasheadas con `scrypt` y tokens JWT firmados.
- `AuthGuard` protege `/home` y `AuthInterceptor` agrega el token a las solicitudes.
- La sesión se restaura al abrir la app y se cierra al presionar "Cerrar sesión".
- Los datos están aislados entre cuentas.

### API y sincronización

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/mock/todos` | Datos locales para E2E e importación |
| `POST` | `/api/auth/register` | Crear cuenta |
| `POST` | `/api/auth/login` | Iniciar sesión |
| `GET` | `/api/auth/me` | Validar sesión |
| `GET` | `/api/tasks` | Tareas del usuario, con filtro `since` |
| `PUT` | `/api/tasks` | Crear o actualizar tarea |
| `DELETE` | `/api/tasks/:id` | Eliminar tarea con tombstone |
| `GET` | `/api/tasks/events` | Cambios en tiempo real por SSE |
| `POST` | `/api/import/todos` | Importar desde `IMPORT_SOURCE_URL` |

- Cola offline con reintento automático al recuperar conexión.
- Idempotencia con `opId` y `lastOpId`.
- Resolución de conflictos por `updatedAt` (last-write-wins); el servidor gana en empate y responde `409`.
- Los cambios remotos llegan por Server-Sent Events.
- Los botones "Reintentar" e "Importar" permiten ejecutar las acciones manualmente.

### Importación

La importación consulta la API configurada, valida y mapea `id`, `title`, `completed` y `userId`, evita duplicados y muestra en cada tarea:

- Fuente e identificador remoto.
- Estado remoto (completada/pendiente).
- Usuario de origen.
- Registros duplicados o inválidos omitidos.

Para las pruebas E2E se usa `http://localhost:3000/api/mock/todos`, por lo que no dependen de internet.

## 9. Pruebas

| Tipo | Comando | Cobertura |
|------|---------|-----------|
| Unitarias | `npm run test:unit` | Persistencia, rollback, cola offline con reinicio, reconnect SSE, conflictos, importación, cámara, GPS, permisos, cancelaciones y páginas |
| API | `npm run test:api` | Registro, login, autorización, CRUD, idempotencia, conflictos, importación, errores 502, `skippedLimit` y dos sesiones con GET+SSE |
| E2E | `npm run test:e2e` | CRUD, aislamiento, importación, offline, foto, ubicación, cancelación, denegación, segundo cliente y reinicio offline |

Resultados verificados en este entorno: **89 pruebas unitarias**, **24 pruebas de API** y **10 pruebas E2E** correctas.

## 10. Compilación nativa

Los proyectos `android/` e `ios/` ya están generados y sincronizados con `@capacitor/android@8.6.0` y `@capacitor/ios@8.6.0`. Después de cambiar el código web o `apiUrl`, ejecuta lo siguiente desde la raíz. `npm run build` regenera `www/`, el directorio web que usa Capacitor y que está excluido de Git.

```bash
npm run build
npx cap sync
npx cap open android
npx cap open ios
```

Permisos declarados:

- Android: `CAMERA`, `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`, `android.hardware.camera`, `android.hardware.location.gps` y `usesCleartextTraffic` para la API local.
- iOS: `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSLocationWhenInUseUsageDescription`, `NSLocationAlwaysUsageDescription`, `NSLocationAlwaysAndWhenInUseUsageDescription` y excepción ATS para `localhost`.

Pasos en emulador Android o dispositivo:

1. En ambos archivos de entorno, configura `apiUrl` como `http://10.0.2.2:3000` en el emulador de Android Studio o usa la IP del Mac en la red local para un dispositivo físico. Agrega `https://localhost` a `ALLOWED_ORIGINS` en `server/.env` y conserva los orígenes web que uses. [Red del emulador de Android](https://developer.android.com/studio/run/emulator-networking-address?hl=es-419).
2. Inicia la API con `npm run api` en una terminal y, en otra, ejecuta `npm run build && npx cap sync android && npx cap open android`.
3. En Android Studio ejecutar la app, conceder cámara y ubicación, activar GPS, capturar foto y coordenadas, cortar red, crear/editar/eliminar una tarea, reiniciar la app y restaurar red.
4. Capturar los estados de permisos, foto, coordenadas, pendientes y sincronizado.

Pasos en simulador iOS o dispositivo:

1. En el simulador iOS con la API en el mismo Mac, conserva `http://localhost:3000` y agrega `capacitor://localhost` a `ALLOWED_ORIGINS` en `server/.env`. En un iPhone físico, usa una URL HTTPS accesible desde el teléfono en ambos archivos de entorno.
2. Inicia la API con `npm run api` en una terminal y, en otra, ejecuta `npm run build && npx cap sync ios && npx cap open ios`.
3. En Xcode ejecutar la app, aceptar los diálogos de cámara y ubicación, repetir el recorrido offline y capturar la evidencia.

En este entorno se compiló y ejecutó la app real en un **simulador de iOS** (ver evidencia abajo); no se probó en un dispositivo físico ni en emulador Android por no estar disponible el SDK de Android en esta máquina.

## 11. Evidencias sugeridas

Clasificación de evidencias:

- **Navegador (ya ejecutado):** E2E de Playwright en Mobile Chrome; cubre toma de foto y adjunción desde galería por selector de archivos, geolocalización simulada, cancelación, denegación, segundo cliente y reinicio offline.
- **Simulado (ya ejecutado):** pruebas unitarias con dobles de plugins y servidor API local para importación.
- **Nativo — simulador iOS:** se compiló e instaló la app en iPhone 15 Pro (iOS 17.2) y iPhone 17 (iOS 26.5). En el iPhone 15 Pro se verificaron registro, restauración de la sesión al cerrar y reabrir la app, cierre de sesión y nuevo inicio de sesión. En el iPhone 17 se comprobó manualmente el acceso a la ubicación simulada. Las capturas del inicio de sesión y de la fototeca del iPhone 15 Pro están en [evidence/ios-simulator-nativo](evidence/ios-simulator-nativo/). Queda pendiente verificar el flujo completo de cámara, ubicación y reapertura sin conexión en un dispositivo físico.
- **Nativo — Android (pendiente):** no hay SDK/emulador de Android disponible en esta máquina; el proyecto `android/` está generado y los permisos declarados, pero no se ejecutó.

Recorrido de demostración en navegador:

1. Registrar `demo@ejemplo.test` con contraseña `password123`; cerrar sesión y volver a entrar.
2. Dejar vacío el título para comprobar la validación y luego escribir «Preparar evaluación».
3. Pulsar **Tomar foto** para capturar con la cámara o **Adjuntar foto** para elegir una imagen; pulsar **Registrar ubicación** y guardar.
4. Editar el título, recargar y comprobar persistencia; eliminar y comprobar que no vuelve tras recargar.
5. Con el límite de importación del archivo de ejemplo y una cuenta nueva, pulsar **Importar** dos veces para ver las tareas importadas y comprobar que no se duplican.
6. Abrir una segunda cuenta para comprobar aislamiento; abrir dos sesiones de la misma cuenta para ver SSE.
7. Bloquear `/api/**`, crear/editar/eliminar, recargar, liberar la red y sincronizar.

Tomar capturas de los pasos anteriores y de la salida de `npm run test:unit`, `npm run test:api`, `npm run test:e2e` y `npm run lint`.

El informe `EVU2_BENAVENTE_SOFIA` se entrega por separado en Word o PDF, con el formato indicado por la cátedra.

## 12. Limitaciones

- La URL de la API es local por defecto; debe ajustarse para un dispositivo físico.
- No se probó en dispositivos Android/iOS reales dentro de este entorno.
- El proveedor externo por defecto es JSONPlaceholder. Las pruebas usan el endpoint local simulado.
- Las fotos capturadas en nativo se guardan en el dispositivo de origen. La API sincroniza su referencia local, por lo que el archivo de imagen no está disponible en otro dispositivo.
- No se implementaron marcar como completada, búsqueda ni ordenamiento.
