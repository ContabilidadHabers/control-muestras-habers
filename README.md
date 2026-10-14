# HABERS · Control de préstamo de muestras

SPA en HTML5 + CSS3 + JavaScript vanilla, conectada a Firebase (Auth anónima, Firestore y Storage), lista para publicarse en GitHub Pages.

```
index.html   → estructura (3 pestañas + modal de comprobante)
styles.css   → diseño (beige, gris claro, acentos oscuros; responsivo)
app.js       → lógica + Firebase Web SDK modular v10 (API v9+) por CDN
```

---

## 1. Crear el proyecto en Firebase

1. Entra a <https://console.firebase.google.com> → **Agregar proyecto** → nombre, p. ej. `habers-muestras`.
2. Google Analytics: opcional (no lo usa la app).

## 2. Registrar la app web y pegar la configuración

1. En la página del proyecto, clic en el ícono **`</>` (Web)** → apodo `muestras-web` → **Registrar app** (no marques Hosting).
2. Copia el objeto `firebaseConfig` que te muestra.
3. Abre `app.js` y reemplaza el bloque `firebaseConfig` (líneas ~19-26) con el tuyo.

> La `apiKey` de Firebase **no es secreta**: identifica al proyecto. La protección real son las reglas de los pasos 4 y 5.

## 3. Habilitar Authentication (anónima)

1. **Compilación → Authentication → Comenzar**.
2. Pestaña **Método de acceso** → **Anónimo** → Habilitar → Guardar.
3. Pestaña **Configuración → Dominios autorizados** → **Agregar dominio** → `TU-USUARIO.github.io` (lo harás de nuevo si usas dominio propio).

Cada dispositivo obtiene una sesión anónima persistente; nadie tiene que iniciar sesión, pero sin ella Firestore rechaza el acceso.

## 4. Crear Firestore y publicar reglas

1. **Compilación → Firestore Database → Crear base de datos**.
2. Ubicación: la más cercana disponible (p. ej. `nam5`). **No se puede cambiar después.**
3. Modo: **producción**.
4. Pestaña **Reglas** → reemplaza todo por esto → **Publicar**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function sesion() { return request.auth != null; }

    match /prestamos/{id} {
      allow read, create, update: if sesion();
      allow delete: if false;                 // los registros no se borran desde la app
    }
    match /vendedores/{id} {
      allow read, write: if sesion();
    }
    match /config/admin {
      allow read, create: if sesion();
      allow update, delete: if false;         // la contraseña solo se cambia desde la consola
    }
    match /config/contador {
      allow read, write: if sesion();
    }
  }
}
```

No necesitas crear colecciones ni índices: la app crea los 4 vendedores iniciales (Moisés Haber, María José González, Carmen Peñaloza, Norma Hernández) y el contador de folios la primera vez que se abre.

## 5. Storage para las firmas (opcional)

Firebase pide el plan **Blaze** (pago por uso, con cuota gratuita) para activar Storage en proyectos nuevos. Tienes dos opciones:

**A) Sin Storage (plan gratuito Spark)** — en `app.js` cambia `usarStorage: true` a `usarStorage: false`. Las firmas se guardan como imagen PNG pequeña (~600 px) dentro de cada documento de Firestore. Funciona perfectamente para este volumen.

**B) Con Storage** — actualiza a Blaze, ve a **Compilación → Storage → Comenzar**, y en **Reglas** publica:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /firmas/{prestamo}/{archivo} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
                    && request.resource.size < 1 * 1024 * 1024
                    && request.resource.contentType.matches('image/.*');
      allow update, delete: if false;
    }
  }
}
```

Si Storage falla o no hay conexión, la app guarda la firma en Firestore automáticamente; nunca se pierde el registro.

## 6. Probar en tu computadora (opcional)

`app.js` es un módulo ES, así que **no funciona abriendo `index.html` con doble clic** (`file://`). Usa un servidor local en la carpeta:

```bash
python3 -m http.server 8080
# abre http://localhost:8080
```

`localhost` ya viene autorizado en Firebase.

## 7. Publicar en GitHub Pages

1. En <https://github.com/new> crea un repositorio, p. ej. `muestras-habers` (puede ser privado si tu plan de GitHub lo permite con Pages; si es público, recuerda que el código queda visible — los datos no, siguen protegidos por las reglas).
2. **Add file → Upload files** → sube `index.html`, `styles.css`, `app.js` y este `README.md` → **Commit changes**.
3. **Settings → Pages** → *Build and deployment* → Source: **Deploy from a branch** → Branch: `main` / `(root)` → **Save**.
4. En 1-2 minutos la app queda en `https://TU-USUARIO.github.io/muestras-habers/`.
5. Confirma que `TU-USUARIO.github.io` esté en **Authentication → Dominios autorizados** (paso 3).

Para actualizar: sube los archivos modificados al repositorio y Pages se vuelve a publicar solo.

## 8. Primer uso

1. Abre la app → el indicador superior debe decir **«En línea · sincronizado»**.
2. **Dashboard → Administración de vendedores**: la primera vez te pide **crear** la contraseña de administrador (mín. 6 caracteres). Después solo pide ingresarla.
   - Para cambiarla: Consola Firebase → Firestore → `config` → borra el documento `admin` y vuelve a crearla desde la app.
3. **Formulario**: captura, firma en ambos lienzos, presiona **Guardar firma** en cada uno y luego **Guardar préstamo**. Se genera un folio consecutivo `HAB-M-00001` y se abre el comprobante (imprimible o guardable como PDF).
4. **Detalle**: busca, filtra, cambia el estatus directo en la fila (Devuelto registra la fecha real de devolución), abre la ficha y exporta a CSV (abre directo en Excel con acentos correctos).

---

## Disponibilidad permanente (sin cierres por inactividad)

- **GitHub Pages** sirve archivos estáticos: no hay servidor que se «duerma».
- **Firebase** no pausa proyectos por inactividad, y Firestore/Auth no tienen arranque en frío.
- La app usa **listeners en tiempo real** (`onSnapshot`) que se reconectan solos y **caché persistente** (IndexedDB): si se va el internet se sigue capturando y consultando; los cambios se sincronizan al volver la conexión (las filas pendientes muestran un punto ámbar).
- La sesión anónima se renueva automáticamente; no expira por inactividad.

## Notas de seguridad (honestas)

- La contraseña de administrador se guarda como hash SHA-256 con sal, pero **es un candado de interfaz**, no de servidor: alguien con conocimientos técnicos y la app abierta podría escribir en `vendedores` sin ella. Para una herramienta interna es razonable; si necesitas control real por usuario, el siguiente paso es cambiar la sesión anónima por inicio de sesión con correo (`@habers.com.mx`) y restringir las reglas por usuario.
- Recomendado: en Google Cloud Console → **APIs y servicios → Credenciales**, restringe la API key por **referentes HTTP** a `https://TU-USUARIO.github.io/*` y `http://localhost:8080/*`.
- Los registros no se pueden borrar desde la app (regla `allow delete: if false`); si alguno se captura mal, cámbialo de estatus o bórralo desde la consola.

## Personalización rápida (`app.js`, objeto `AJUSTES`)

| Ajuste | Para qué |
|---|---|
| `usarStorage` | `true` = Storage, `false` = firmas en Firestore |
| `prefijoFolio` | Prefijo del folio (`HAB-M-`) |
| `diasDevolucionDefault` | Días sugeridos para la devolución (7) |
| `vendedoresIniciales` | Solo se usan si la colección está vacía |
| `empresa`, `leyenda` | Texto del comprobante impreso |
