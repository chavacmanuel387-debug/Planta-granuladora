'use strict';

// Pruebas del sistema de punta a punta contra un servidor real con una base
// de datos temporal. Se ejecutan con:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { crearServidor } = require('../server');

const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'planta-prueba-'));
const rutaBase = path.join(carpeta, 'planta.db');
let servidor;
let base;

function iniciar() {
  servidor = crearServidor({ rutaBase });
  return new Promise((resolver) => {
    servidor.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${servidor.address().port}`;
      resolver();
    });
  });
}

function detener() {
  return new Promise((resolver) => {
    servidor.close(resolver);
    servidor.closeAllConnections();
  });
}

// Cliente mínimo que recuerda la galleta de sesión, como lo haría un navegador.
function cliente() {
  let galleta = '';
  return async function pedir(metodo, ruta, cuerpo, cabeceras = {}) {
    const opciones = { method: metodo, headers: { ...cabeceras } };
    if (galleta) opciones.headers.Cookie = galleta;
    if (metodo !== 'GET') {
      opciones.headers['Content-Type'] = opciones.headers['Content-Type'] || 'application/json';
      opciones.body = typeof cuerpo === 'string' || Buffer.isBuffer(cuerpo) ? cuerpo : JSON.stringify(cuerpo || {});
    }
    const respuesta = await fetch(base + ruta, opciones);
    const nueva = respuesta.headers.get('set-cookie');
    if (nueva) galleta = nueva.split(';')[0];
    const tipo = respuesta.headers.get('content-type') || '';
    const datos = tipo.includes('json') ? await respuesta.json() : Buffer.from(await respuesta.arrayBuffer());
    return { estado: respuesta.status, datos, cabeceras: respuesta.headers };
  };
}

const admin = cliente();
const mecanico = cliente();
const ids = {};

test.before(iniciar);
test.after(async () => {
  await detener();
  fs.rmSync(carpeta, { recursive: true, force: true });
});

test('sin configurar: el sistema lo indica y no deja ver datos', async () => {
  const anonimo = cliente();
  const estado = await anonimo('GET', '/api/estado');
  assert.equal(estado.datos.planta, 'PLANTA GRANULADORA EL PILAR');
  assert.equal(estado.datos.configurado, false);
  assert.equal(estado.datos.usuario, null);
  assert.equal((await anonimo('GET', '/api/equipos')).estado, 401);
  assert.equal((await anonimo('GET', '/api/personal')).estado, 401);
  assert.equal((await anonimo('GET', '/api/respaldo')).estado, 401);
});

test('configuración inicial: crea al administrador una sola vez', async () => {
  const corta = await admin('POST', '/api/configurar', { nombre: 'Ana', usuario: 'ana', contrasena: '123' });
  assert.equal(corta.estado, 400);

  const creada = await admin('POST', '/api/configurar', {
    nombre: 'Manuel Chávez',
    usuario: 'Manuel',
    contrasena: 'granuladora-2026',
  });
  assert.equal(creada.estado, 200);
  assert.equal(creada.datos.usuario.rol, 'admin');
  assert.equal(creada.datos.usuario.usuario, 'manuel');
  assert.match(creada.cabeceras.get('set-cookie'), /HttpOnly; SameSite=Strict/);

  const repetida = await cliente()('POST', '/api/configurar', {
    nombre: 'Intruso',
    usuario: 'intruso',
    contrasena: 'contrasena-larga',
  });
  assert.equal(repetida.estado, 409);
});

test('personal: se agregan mecánicos y soldadores con su usuario y contraseña', async () => {
  const pedro = await admin('POST', '/api/personal', {
    nombre: 'Pedro López',
    puesto: 'mecanico',
    cuenta: { usuario: 'pedro', contrasena: 'tornillo-88', rol: 'tecnico' },
  });
  assert.equal(pedro.estado, 200);
  ids.pedro = pedro.datos.id;

  const luis = await admin('POST', '/api/personal', { nombre: 'Luis Ramírez', puesto: 'soldador' });
  assert.equal(luis.estado, 200);
  ids.luis = luis.datos.id;

  const duplicado = await admin('POST', '/api/personal', {
    nombre: 'Otro Pedro',
    puesto: 'mecanico',
    cuenta: { usuario: 'PEDRO', contrasena: 'tornillo-99', rol: 'tecnico' },
  });
  assert.equal(duplicado.estado, 409);

  const sinClave = await admin('POST', '/api/personal', {
    nombre: 'Sin Clave',
    puesto: 'soldador',
    cuenta: { usuario: 'sinclave', rol: 'tecnico' },
  });
  assert.equal(sinClave.estado, 400);

  const puestoMalo = await admin('POST', '/api/personal', { nombre: 'X', puesto: 'astronauta' });
  assert.equal(puestoMalo.estado, 400);

  // A Luis se le crea el usuario después.
  const conCuenta = await admin('PUT', `/api/personal/${ids.luis}`, {
    nombre: 'Luis Ramírez',
    puesto: 'soldador',
    cuenta: { usuario: 'luis', contrasena: 'electrodo-7018', rol: 'tecnico' },
  });
  assert.equal(conCuenta.estado, 200);

  const lista = await admin('GET', '/api/personal');
  assert.equal(lista.datos.length, 3);
  assert.equal(lista.datos.find((p) => p.id === ids.luis).usuario, 'luis');
  assert.ok(!JSON.stringify(lista.datos).includes('scrypt'), 'nunca se devuelven hashes de contraseñas');
});

test('entrada: contraseña correcta entra, incorrecta no', async () => {
  const mala = await mecanico('POST', '/api/entrar', { usuario: 'pedro', contrasena: 'equivocada' });
  assert.equal(mala.estado, 401);
  const inexistente = await mecanico('POST', '/api/entrar', { usuario: 'nadie', contrasena: 'equivocada' });
  assert.equal(inexistente.estado, 401);
  assert.equal(inexistente.datos.error, mala.datos.error, 'no se revela si el usuario existe');

  const buena = await mecanico('POST', '/api/entrar', { usuario: ' Pedro ', contrasena: 'tornillo-88' });
  assert.equal(buena.estado, 200);
  assert.equal(buena.datos.usuario.nombre, 'Pedro López');
  assert.equal(buena.datos.usuario.rol, 'tecnico');
});

test('equipos y piezas: el administrador los registra, el técnico solo los consulta', async () => {
  const equipo = await admin('POST', '/api/equipos', {
    nombre: 'Tambor granulador',
    ubicacion_tecnica: 'PGEP-GRAN-TG01',
    notas: 'Motor de 75 HP',
  });
  assert.equal(equipo.estado, 200);
  ids.tambor = equipo.datos.id;

  const otro = await admin('POST', '/api/equipos', { nombre: 'Secador rotativo', ubicacion_tecnica: 'PGEP-SEC-SR01' });
  ids.secador = otro.datos.id;

  const sinUbicacion = await admin('POST', '/api/equipos', { nombre: 'Criba' });
  assert.equal(sinUbicacion.estado, 400);

  const rodamiento = await admin('POST', `/api/equipos/${ids.tambor}/piezas`, {
    nombre: 'Rodamiento de rodillo',
    codigo: '22320-E1',
    cantidad: 4,
  });
  ids.rodamiento = rodamiento.datos.id;
  const faja = await admin('POST', `/api/equipos/${ids.secador}/piezas`, { nombre: 'Faja en V', codigo: 'B-112' });
  ids.faja = faja.datos.id;
  const cantidadMala = await admin('POST', `/api/equipos/${ids.tambor}/piezas`, { nombre: 'Perno', cantidad: 0 });
  assert.equal(cantidadMala.estado, 400);

  const prohibido = await mecanico('POST', '/api/equipos', { nombre: 'Molino', ubicacion_tecnica: 'X' });
  assert.equal(prohibido.estado, 403);
  assert.equal((await mecanico('DELETE', `/api/piezas/${ids.rodamiento}`)).estado, 403);
  assert.equal((await mecanico('POST', '/api/personal', { nombre: 'Y', puesto: 'mecanico' })).estado, 403);

  const lista = await mecanico('GET', '/api/equipos');
  assert.equal(lista.estado, 200);
  assert.equal(lista.datos.find((e) => e.id === ids.tambor).piezas, 1);

  const detalle = await mecanico('GET', `/api/equipos/${ids.tambor}`);
  assert.equal(detalle.datos.ubicacion_tecnica, 'PGEP-GRAN-TG01');
  assert.equal(detalle.datos.piezas[0].cantidad, 4);

  const vistaTecnico = await mecanico('GET', '/api/personal');
  assert.equal(vistaTecnico.datos[0].usuario, undefined, 'el técnico no ve los usuarios de los demás');
});

test('mantenimientos: programar, iniciar, terminar y permisos', async () => {
  const piezaAjena = await admin('POST', '/api/mantenimientos', {
    equipo_id: ids.tambor,
    tipo: 'preventivo',
    trabajo: 'Cambio de rodamientos',
    fecha_programada: '2026-10-15',
    pieza_ids: [ids.faja],
  });
  assert.equal(piezaAjena.estado, 400, 'la pieza debe ser del mismo equipo');

  const fechaMala = await admin('POST', '/api/mantenimientos', {
    equipo_id: ids.tambor,
    tipo: 'preventivo',
    trabajo: 'Cambio de rodamientos',
    fecha_programada: '2026-02-30',
  });
  assert.equal(fechaMala.estado, 400);

  const creado = await admin('POST', '/api/mantenimientos', {
    equipo_id: ids.tambor,
    tipo: 'preventivo',
    trabajo: 'Cambio de rodamientos',
    detalles: 'Revisar también el sello',
    fecha_programada: '2026-10-15',
    personal_ids: [ids.pedro, ids.luis],
    pieza_ids: [ids.rodamiento],
  });
  assert.equal(creado.estado, 200);
  ids.trabajo = creado.datos.id;

  // El técnico reporta una falla; es suyo y lo puede corregir.
  const reporte = await mecanico('POST', '/api/mantenimientos', {
    equipo_id: ids.secador,
    tipo: 'correctivo',
    trabajo: 'Faja rota',
    fecha_programada: '2026-10-09',
    personal_ids: [ids.pedro],
  });
  assert.equal(reporte.estado, 200);
  ids.reporte = reporte.datos.id;

  const lista = await mecanico('GET', '/api/mantenimientos');
  const trabajo = lista.datos.find((m) => m.id === ids.trabajo);
  assert.equal(trabajo.equipo_nombre, 'Tambor granulador');
  assert.deepEqual(trabajo.personal.map((p) => p.nombre), ['Luis Ramírez', 'Pedro López']);
  assert.equal(trabajo.piezas[0].codigo, '22320-E1');
  assert.equal(trabajo.puede_editar, false);
  assert.equal(lista.datos.find((m) => m.id === ids.reporte).puede_editar, true);

  const cuerpoEdicion = {
    equipo_id: ids.tambor,
    tipo: 'correctivo',
    trabajo: 'Otro',
    fecha_programada: '2026-10-16',
  };
  assert.equal((await mecanico('PUT', `/api/mantenimientos/${ids.trabajo}`, cuerpoEdicion)).estado, 403);
  assert.equal((await mecanico('DELETE', `/api/mantenimientos/${ids.trabajo}`)).estado, 403);

  assert.equal((await mecanico('POST', `/api/mantenimientos/${ids.trabajo}/estado`, { estado: 'en_proceso' })).estado, 200);
  const terminar = await mecanico('POST', `/api/mantenimientos/${ids.trabajo}/estado`, {
    estado: 'terminado',
    observaciones: 'Se cambiaron los 4 rodamientos',
  });
  assert.equal(terminar.estado, 200);
  assert.equal((await mecanico('POST', `/api/mantenimientos/${ids.trabajo}/estado`, { estado: 'listo' })).estado, 400);

  const detalle = await admin('GET', `/api/equipos/${ids.tambor}`);
  const terminado = detalle.datos.mantenimientos[0];
  assert.equal(terminado.estado, 'terminado');
  assert.equal(terminado.terminado_por_nombre, 'Pedro López');
  assert.match(terminado.fecha_terminado, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(terminado.observaciones, 'Se cambiaron los 4 rodamientos');

  // Reabrir limpia la fecha de terminado pero conserva las observaciones.
  await admin('POST', `/api/mantenimientos/${ids.trabajo}/estado`, { estado: 'pendiente' });
  const reabierto = (await admin('GET', `/api/equipos/${ids.tambor}`)).datos.mantenimientos[0];
  assert.equal(reabierto.fecha_terminado, null);
  assert.equal(reabierto.observaciones, 'Se cambiaron los 4 rodamientos');
});

test('personal con historial no se elimina; se desactiva y pierde el acceso', async () => {
  const eliminar = await admin('DELETE', `/api/personal/${ids.luis}`);
  assert.equal(eliminar.estado, 409);

  const soldador = cliente();
  assert.equal((await soldador('POST', '/api/entrar', { usuario: 'luis', contrasena: 'electrodo-7018' })).estado, 200);
  assert.equal((await soldador('GET', '/api/equipos')).estado, 200);

  const desactivar = await admin('PUT', `/api/personal/${ids.luis}`, {
    nombre: 'Luis Ramírez',
    puesto: 'soldador',
    activo: false,
  });
  assert.equal(desactivar.estado, 200);
  assert.equal((await soldador('GET', '/api/equipos')).estado, 401, 'su sesión abierta se cierra');
  assert.equal((await soldador('POST', '/api/entrar', { usuario: 'luis', contrasena: 'electrodo-7018' })).estado, 401);

  const asignar = await admin('POST', '/api/mantenimientos', {
    equipo_id: ids.tambor,
    tipo: 'preventivo',
    trabajo: 'Soldadura de aspas',
    fecha_programada: '2026-11-01',
    personal_ids: [ids.luis],
  });
  assert.equal(asignar.estado, 400, 'no se asignan trabajos nuevos a personal desactivado');
});

test('siempre queda un administrador', async () => {
  const yo = (await admin('GET', '/api/estado')).datos.usuario;
  const quitarme = await admin('PUT', `/api/personal/${yo.personal_id}`, {
    nombre: yo.nombre,
    puesto: 'supervisor',
    cuenta: null,
  });
  assert.equal(quitarme.estado, 409);
  const degradarme = await admin('PUT', `/api/personal/${yo.personal_id}`, {
    nombre: yo.nombre,
    puesto: 'supervisor',
    cuenta: { usuario: 'manuel', rol: 'tecnico' },
  });
  assert.equal(degradarme.estado, 409);
  assert.equal((await admin('DELETE', `/api/personal/${yo.personal_id}`)).estado, 409);
  assert.equal((await admin('GET', '/api/estado')).datos.usuario.rol, 'admin', 'nada cambió');
});

test('cambio de contraseña propia y restablecimiento por el administrador', async () => {
  const mal = await mecanico('POST', '/api/mi-contrasena', { actual: 'no-es', nueva: 'llave-inglesa-9' });
  assert.equal(mal.estado, 400);
  const bien = await mecanico('POST', '/api/mi-contrasena', { actual: 'tornillo-88', nueva: 'llave-inglesa-9' });
  assert.equal(bien.estado, 200);
  assert.equal((await mecanico('GET', '/api/equipos')).estado, 200, 'la sesión actual sigue abierta');

  const otro = cliente();
  assert.equal((await otro('POST', '/api/entrar', { usuario: 'pedro', contrasena: 'tornillo-88' })).estado, 401);
  assert.equal((await otro('POST', '/api/entrar', { usuario: 'pedro', contrasena: 'llave-inglesa-9' })).estado, 200);

  const restablecer = await admin('PUT', `/api/personal/${ids.pedro}`, {
    nombre: 'Pedro López',
    puesto: 'mecanico',
    cuenta: { usuario: 'pedro', contrasena: 'nueva-clave-1', rol: 'tecnico' },
  });
  assert.equal(restablecer.estado, 200);
  assert.equal((await mecanico('GET', '/api/equipos')).estado, 401, 'al restablecerla se cierran sus sesiones');
  assert.equal((await mecanico('POST', '/api/entrar', { usuario: 'pedro', contrasena: 'nueva-clave-1' })).estado, 200);
});

test('protecciones: origen ajeno, formato, datos ilegibles e intentos repetidos', async () => {
  const ajeno = await admin('POST', '/api/equipos', { nombre: 'X', ubicacion_tecnica: 'Y' }, { Origin: 'http://otro-sitio.example' });
  assert.equal(ajeno.estado, 403);
  const formulario = await admin('POST', '/api/equipos', 'nombre=X', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(formulario.estado, 415);
  assert.equal((await admin('POST', '/api/equipos', '{no es json')).estado, 400);
  assert.equal((await admin('POST', '/api/equipos', '[1,2]')).estado, 400);
  assert.equal((await admin('GET', '/api/no-existe')).estado, 404);
  assert.equal((await admin('GET', '/api/equipos/999999')).estado, 404);

  const pagina = await fetch(base + '/');
  assert.match(pagina.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(base + '/..%2Fserver.js')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);

  const atacante = cliente();
  await admin('POST', '/api/personal', {
    nombre: 'Víctima',
    puesto: 'mecanico',
    cuenta: { usuario: 'victima', contrasena: 'clave-real-123', rol: 'tecnico' },
  });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await atacante('POST', '/api/entrar', { usuario: 'victima', contrasena: `intento-${i}` })).estado, 401);
  }
  const bloqueado = await atacante('POST', '/api/entrar', { usuario: 'victima', contrasena: 'clave-real-123' });
  assert.equal(bloqueado.estado, 429, 'tras 5 fallos se bloquea aunque la contraseña sea correcta');
});

test('respaldo: el administrador descarga una base de datos SQLite válida', async () => {
  assert.equal((await mecanico('GET', '/api/respaldo')).estado, 403);
  const respaldo = await admin('GET', '/api/respaldo');
  assert.equal(respaldo.estado, 200);
  assert.equal(respaldo.datos.subarray(0, 15).toString(), 'SQLite format 3');
  assert.match(respaldo.cabeceras.get('content-disposition'), /respaldo-planta-el-pilar-\d{4}-\d{2}-\d{2}\.db/);
});

test('eliminar: pieza, mantenimiento y equipo con todo lo suyo', async () => {
  assert.equal((await admin('DELETE', `/api/piezas/${ids.rodamiento}`)).estado, 200);
  const trabajo = (await admin('GET', '/api/mantenimientos')).datos.find((m) => m.id === ids.trabajo);
  assert.deepEqual(trabajo.piezas, [], 'la pieza eliminada sale del mantenimiento, que se conserva');

  assert.equal((await admin('DELETE', `/api/mantenimientos/${ids.reporte}`)).estado, 200);
  assert.equal((await admin('DELETE', `/api/equipos/${ids.secador}`)).estado, 200);
  assert.equal((await admin('GET', `/api/equipos/${ids.secador}`)).estado, 404);
});

test('fondo de pantalla: fondos incluidos, imagen propia y permisos', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
  const comoPng = { 'Content-Type': 'image/png' };

  assert.deepEqual((await cliente()('GET', '/api/estado')).datos.fondo, { nombre: 'ninguno', url: null, urlPropia: null });

  // Solo el administrador cambia el fondo.
  assert.equal((await mecanico('PUT', '/api/fondo', { fondo: 'noche' })).estado, 403);
  assert.equal((await mecanico('POST', '/api/fondo/imagen', png, comoPng)).estado, 403);
  assert.equal((await cliente()('POST', '/api/fondo/imagen', png, comoPng)).estado, 401);

  const incluido = await admin('PUT', '/api/fondo', { fondo: 'atardecer' });
  assert.equal(incluido.estado, 200);
  assert.equal(incluido.datos.url, '/fondos/atardecer.svg');
  for (const nombre of ['atardecer', 'noche', 'cerezos']) {
    const dibujo = await fetch(`${base}/fondos/${nombre}.svg`);
    assert.equal(dibujo.status, 200);
    assert.match(dibujo.headers.get('content-type'), /image\/svg\+xml/);
  }
  assert.equal((await admin('PUT', '/api/fondo', { fondo: 'inventado' })).estado, 400);
  assert.equal((await admin('PUT', '/api/fondo', { fondo: 'propio' })).estado, 400, 'todavía no hay imagen propia');
  assert.equal((await fetch(`${base}/api/fondo/imagen`)).status, 404);

  // Solo se aceptan fotos de verdad: se revisa el contenido, no la etiqueta.
  const pagina = Buffer.from('<html><script>alert(1)</script></html>');
  assert.equal((await admin('POST', '/api/fondo/imagen', pagina, comoPng)).estado, 400);
  assert.equal((await admin('POST', '/api/fondo/imagen', png, { 'Content-Type': 'image/svg+xml' })).estado, 415);
  assert.equal((await admin('POST', '/api/fondo/imagen', '{"a":1}')).estado, 415);
  const enorme = Buffer.concat([png, Buffer.alloc(8 * 1024 * 1024)]);
  assert.equal((await admin('POST', '/api/fondo/imagen', enorme, comoPng)).estado, 413);
  assert.equal((await admin('GET', '/api/estado')).datos.fondo.nombre, 'atardecer', 'los intentos fallidos no cambian nada');

  const subida = await admin('POST', '/api/fondo/imagen', png, comoPng);
  assert.equal(subida.estado, 200);
  assert.equal(subida.datos.nombre, 'propio');
  assert.equal(subida.datos.url, '/api/fondo/imagen?v=1');

  // La imagen se ve sin sesión, porque la pantalla de entrada también la usa.
  const imagen = await fetch(base + subida.datos.url);
  assert.equal(imagen.status, 200);
  assert.equal(imagen.headers.get('content-type'), 'image/png');
  assert.equal(imagen.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await imagen.arrayBuffer()), png);

  // Se puede volver a un fondo incluido y regresar a la imagen propia sin subirla otra vez.
  assert.equal((await admin('PUT', '/api/fondo', { fondo: 'ninguno' })).datos.url, null);
  assert.equal((await admin('PUT', '/api/fondo', { fondo: 'propio' })).datos.url, '/api/fondo/imagen?v=1');
});

test('persistencia: al reiniciar el servidor todo sigue guardado y salir cierra la sesión', async () => {
  await detener();
  await iniciar();

  const estado = await admin('GET', '/api/estado');
  assert.equal(estado.datos.configurado, true);
  assert.equal(estado.datos.usuario.usuario, 'manuel', 'la sesión sobrevive al reinicio');
  assert.equal(estado.datos.fondo.nombre, 'propio', 'el fondo elegido también se conserva');

  const equipos = await admin('GET', '/api/equipos');
  assert.deepEqual(equipos.datos.map((e) => e.nombre), ['Tambor granulador']);
  const personal = await admin('GET', '/api/personal');
  assert.deepEqual(personal.datos.map((p) => p.nombre).sort(), ['Luis Ramírez', 'Manuel Chávez', 'Pedro López', 'Víctima']);

  assert.equal((await admin('POST', '/api/salir')).estado, 200);
  assert.equal((await admin('GET', '/api/equipos')).estado, 401);
});
