# PLANTA GRANULADORA EL PILAR — Sistema de mantenimiento

Sistema web para llevar el mantenimiento de la planta. Se abre desde el navegador de cualquier computadora o teléfono conectado a la red de la planta.

## Qué hace

- **Personal**: registra mecánicos, soldadores, electricistas y supervisores. A cada persona se le puede crear **su propio usuario y contraseña**.
- **Equipos**: registra todos los equipos de la planta con su **nombre**, su **ubicación técnica** y las **piezas** que lleva cada uno (nombre, código o número de parte, cantidad y notas).
- **Mantenimientos**: programa trabajos preventivos y correctivos por equipo, con fecha, personal asignado y piezas a trabajar. Cada trabajo se inicia, se termina con observaciones y queda en el historial del equipo. Los atrasados se marcan en rojo.
- **Fondo de pantalla**: el administrador elige en **Mi cuenta** uno de los fondos de paisaje incluidos (atardecer, noche de estrellas, cerezos en flor) o sube una imagen propia. Todos los usuarios ven el fondo elegido.
- **Base de datos**: todo lo que se agrega queda guardado en un archivo de base de datos SQLite (`datos/planta.db`) y sigue ahí al apagar y encender la computadora.

## Cómo ponerlo en marcha

Solo necesita **Node.js 22.13 o más nuevo** (la versión LTS actual sirve). No hay nada más que instalar.

1. Instale Node.js desde <https://nodejs.org>.
2. Descargue este repositorio: botón verde **Code** → **Download ZIP**, y descomprímalo.
3. Inicie el sistema:
   - **Windows**: doble clic en `iniciar.bat`. Se abre el navegador solo.
   - **Mac o Linux**: en una terminal, dentro de la carpeta, ejecute `npm start` y abra <http://localhost:3000>.

Mientras la ventana negra esté abierta, el sistema está encendido. Para apagarlo, ciérrela.

### La primera vez

El sistema pide crear la cuenta del **administrador** (nombre, usuario y contraseña). Con esa cuenta se registran después los equipos, el personal y sus usuarios.

### Entrar desde otras computadoras o teléfonos

Al iniciar, la ventana muestra una dirección como `http://192.168.1.50:3000`. Escríbala en el navegador de cualquier equipo conectado a la misma red de la planta. Si Windows pregunta si permite el acceso a la red, acepte.

## Tipos de acceso

| | Técnico | Administrador |
|---|---|---|
| Ver equipos, piezas y mantenimientos | Sí | Sí |
| Programar, iniciar y terminar mantenimientos | Sí | Sí |
| Cambiar su propia contraseña | Sí | Sí |
| Agregar o cambiar equipos y piezas | No | Sí |
| Agregar personal, crear usuarios y contraseñas | No | Sí |
| Eliminar registros y descargar respaldos | No | Sí |

Una persona con historial de trabajos no se elimina: se **desactiva**. Así pierde el acceso pero su historial se conserva.

## Dónde quedan guardados los datos

En la carpeta `datos/`, dentro de la carpeta del sistema. **No borre esa carpeta**: ahí está toda la información de la planta. Esa carpeta no se sube a GitHub.

Para sacar una copia de seguridad entre como administrador a **Mi cuenta → Descargar respaldo** y guarde el archivo en una memoria USB o en otra computadora. Hágalo con regularidad.

El respaldo no incluye la imagen propia de fondo (archivo `datos/fondo-propio`); si la pierde, basta con subirla de nuevo.

Para restaurar un respaldo: apague el sistema, borre los archivos de la carpeta `datos/`, copie ahí el respaldo con el nombre `planta.db` y vuelva a iniciar.

## Seguridad

- Las contraseñas no se guardan tal cual, sino como una huella scrypt: nadie puede leerlas, ni siquiera el administrador.
- Después de 5 intentos fallidos, un usuario queda bloqueado 5 minutos.
- La sesión se cierra sola a las 12 horas. En computadoras compartidas, use **Salir** al terminar.
- El sistema está pensado para la red interna de la planta. No lo publique en internet sin ponerle antes una conexión segura (HTTPS).

## Opciones

Se configuran con variables de entorno antes de iniciar:

| Variable | Para qué sirve | Valor normal |
|---|---|---|
| `PUERTO` | Puerto del servidor | `3000` |
| `ANFITRION` | `127.0.0.1` para que solo se pueda usar en esa computadora | `0.0.0.0` (toda la red) |
| `BASE_DE_DATOS` | Ruta del archivo de base de datos | `datos/planta.db` |

## Para quien mantenga el código

```
server.js          Servidor web y arranque
src/db.js          Esquema de la base de datos y migraciones
src/seguridad.js   Contraseñas y sesiones
src/api.js         Rutas de la API, permisos y validaciones
public/            Interfaz (HTML, CSS y JavaScript sin bibliotecas)
public/fondos/     Fondos de paisaje incluidos (dibujos propios en SVG)
test/api.test.js   Pruebas de punta a punta
```

No usa dependencias externas: el servidor, la base de datos (`node:sqlite`) y las pruebas (`node:test`) vienen con Node.js. Las pruebas se ejecutan con `npm test`.
