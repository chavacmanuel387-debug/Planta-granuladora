# PLANTA GRANULADORA EL PILAR — Sistema de mantenimiento

Sistema web para llevar el mantenimiento de la planta. Se usa desde el navegador de cualquier computadora o teléfono con internet, sin instalar nada:

**https://chavacmanuel387-debug.github.io/Planta-granuladora/**

## Qué hace

- **Personal**: registra mecánicos, soldadores, electricistas y supervisores. A cada persona se le puede crear **su propio usuario y contraseña**.
- **Equipos**: registra todos los equipos de la planta con su **nombre**, su **ubicación técnica** y las **piezas** que lleva cada uno (nombre, código o número de parte, cantidad y notas).
- **Mantenimientos**: programa trabajos preventivos y correctivos por equipo, con fecha, personal asignado y piezas a trabajar. Cada trabajo se inicia, se termina con observaciones y queda en el historial del equipo. Los atrasados se marcan en rojo.
- **En vivo**: cuando alguien termina o programa un trabajo, los demás lo ven al momento, sin recargar la página.
- **Fondo de pantalla**: el administrador elige en **Mi cuenta** uno de los paisajes incluidos o sube una imagen propia.
- **Base de datos**: todo queda guardado en Firebase (Google), con conexión segura HTTPS.

## Cómo está armado

| Parte | Servicio | Costo |
|---|---|---|
| La página | GitHub Pages (carpeta `docs/` de este repositorio) | Gratis |
| Usuarios y contraseñas | Firebase Authentication | Gratis (plan Spark) |
| Datos | Cloud Firestore | Gratis (plan Spark: 1 GB, 50 000 lecturas y 20 000 escrituras por día) |

No hay ningún servidor propio: no hace falta dejar una computadora encendida.

## Puesta en marcha (una sola vez)

1. En [console.firebase.google.com](https://console.firebase.google.com) cree un proyecto.
2. **Authentication → Comenzar → Correo electrónico/contraseña**: actívelo.
3. **Authentication → Configuración → Dominios autorizados**: agregue `chavacmanuel387-debug.github.io`.
4. **Firestore Database → Crear base de datos** en modo de producción.
5. **Firestore Database → Reglas**: borre lo que haya, pegue el contenido de [`firestore.rules`](firestore.rules) y presione **Publicar**.
6. **Configuración del proyecto → Tus apps → Web**: registre la app y copie el bloque `firebaseConfig` en [`docs/config.js`](docs/config.js).
7. Abra la página. La primera vez pide crear la cuenta del **administrador**: hágalo enseguida, porque hasta entonces cualquiera que abra la página podría crearla.

## Tipos de acceso

| | Técnico | Administrador |
|---|---|---|
| Ver equipos, piezas y mantenimientos | Sí | Sí |
| Programar, iniciar y terminar mantenimientos | Sí | Sí |
| Cambiar su propia contraseña | Sí | Sí |
| Agregar o cambiar equipos y piezas | No | Sí |
| Agregar personal, crear usuarios y contraseñas | No | Sí |
| Eliminar registros, cambiar el fondo y descargar respaldos | No | Sí |

Una persona con historial de trabajos no se elimina: se **desactiva**. Así pierde el acceso al instante, pero su historial se conserva.

Si alguien olvida su contraseña, el administrador le pone una nueva en **Personal → Editar**. Su sesión abierta se cierra y debe entrar con la nueva.

## Seguridad

- Las contraseñas las guarda Firebase Authentication; nadie puede leerlas, ni siquiera el administrador.
- Firebase bloquea temporalmente los intentos repetidos de entrar con una contraseña equivocada.
- Lo que cada persona puede leer o cambiar lo deciden las reglas de [`firestore.rules`](firestore.rules), en los servidores de Google.
- Los datos de `docs/config.js` no son secretos: Firebase los diseña para ir dentro de la página.

## Respaldo

Los datos ya quedan guardados en Firebase. Para tener además una copia propia, entre como administrador a **Mi cuenta → Descargar respaldo**.

## Para quien mantenga el código

```
docs/index.html       Página
docs/app.js           Interfaz (JavaScript sin bibliotecas)
docs/datos.js         Lógica y validaciones sobre Firebase
docs/firebase.js      Conexión con Firebase (SDK web 10.12.2 desde gstatic)
docs/config.js        Datos del proyecto de Firebase
docs/fondos/          Fondos de paisaje incluidos (dibujos propios en SVG)
firestore.rules       Reglas de seguridad de Firestore
test/                 Pruebas de datos.js con una nube falsa en memoria
```

Las pruebas se ejecutan con `npm test` (Node.js 20 o más nuevo). Los cambios que se suben a la carpeta `docs/` de la rama principal se publican solos en GitHub Pages.
