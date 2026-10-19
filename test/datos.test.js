// Pruebas de la capa de datos (docs/datos.js) contra una nube falsa en memoria.
// Se ejecutan con:  npm test
// Las reglas de seguridad de Firestore se prueban aparte, en el proyecto real.

import test from 'node:test';
import assert from 'node:assert/strict';
import { crearDatos } from '../docs/datos.js';
import { crearNube } from './nube-falsa.js';

const nube = crearNube();
const espera = () => new Promise((r) => setTimeout(r, 10));

async function dispositivo() {
  const eventos = { cambios: 0, perdidas: [] };
  const datos = crearDatos(nube.cliente());
  await datos.iniciar({ alCambiar: () => (eventos.cambios += 1), alPerderSesion: (m) => eventos.perdidas.push(m) });
  const pedir = async (metodo, ruta, cuerpo) => {
    try {
      return { estado: 200, datos: await datos.api(metodo, ruta, cuerpo) };
    } catch (error) {
      return { estado: error.estado, datos: { error: error.message } };
    }
  };
  return { pedir, eventos };
}

const ids = {};
let admin;
let mecanico;

test('sin configurar: el sistema lo indica y no deja ver datos', async () => {
  const { pedir } = await dispositivo();
  const estado = await pedir('GET', '/api/estado');
  assert.equal(estado.datos.planta, 'PLANTA GRANULADORA EL PILAR');
  assert.equal(estado.datos.configurado, false);
  assert.equal(estado.datos.usuario, null);
  assert.deepEqual(estado.datos.fondo, { nombre: 'ninguno', url: null, urlPropia: null });
  assert.equal((await pedir('GET', '/api/equipos')).estado, 401);
});

test('configuración inicial: crea al administrador una sola vez', async () => {
  admin = await dispositivo();
  assert.equal((await admin.pedir('POST', '/api/configurar', { nombre: 'Ana', usuario: 'ana', contrasena: '123' })).estado, 400);
  const creada = await admin.pedir('POST', '/api/configurar', { nombre: 'Manuel Chávez', usuario: 'Manuel', contrasena: 'granuladora-2026' });
  assert.equal(creada.estado, 200, JSON.stringify(creada.datos));
  assert.equal(creada.datos.usuario.rol, 'admin');
  assert.equal(creada.datos.usuario.usuario, 'manuel');
  assert.equal(creada.datos.usuario.nombre, 'Manuel Chávez');

  const otro = await dispositivo();
  assert.equal((await otro.pedir('POST', '/api/configurar', { nombre: 'X', usuario: 'intruso', contrasena: 'contrasena-larga' })).estado, 409);
});

test('personal: mecánicos y soldadores con su propio usuario y contraseña', async () => {
  const pedro = await admin.pedir('POST', '/api/personal', {
    nombre: 'Pedro López',
    puesto: 'mecanico',
    cuenta: { usuario: 'pedro', contrasena: 'tornillo-88', rol: 'tecnico' },
  });
  assert.equal(pedro.estado, 200, JSON.stringify(pedro.datos));
  ids.pedro = pedro.datos.id;
  const luis = await admin.pedir('POST', '/api/personal', { nombre: 'Luis Ramírez', puesto: 'soldador' });
  ids.luis = luis.datos.id;

  const repetido = await admin.pedir('POST', '/api/personal', { nombre: 'Otro', puesto: 'mecanico', cuenta: { usuario: 'PEDRO', contrasena: 'tornillo-99', rol: 'tecnico' } });
  assert.equal(repetido.estado, 409);
  assert.equal((await admin.pedir('POST', '/api/personal', { nombre: 'Sin', puesto: 'soldador', cuenta: { usuario: 'sinclave', rol: 'tecnico' } })).estado, 400);
  assert.equal((await admin.pedir('POST', '/api/personal', { nombre: 'X', puesto: 'astronauta' })).estado, 400);

  const conCuenta = await admin.pedir('PUT', `/api/personal/${ids.luis}`, {
    nombre: 'Luis Ramírez',
    puesto: 'soldador',
    cuenta: { usuario: 'luis', contrasena: 'electrodo-7018', rol: 'tecnico' },
  });
  assert.equal(conCuenta.estado, 200, JSON.stringify(conCuenta.datos));
  await espera();
  const lista = await admin.pedir('GET', '/api/personal');
  assert.equal(lista.datos.length, 3);
  assert.equal(lista.datos.find((p) => p.id === ids.luis).usuario, 'luis');
});

test('entrar: contraseña correcta entra, incorrecta no', async () => {
  mecanico = await dispositivo();
  const mala = await mecanico.pedir('POST', '/api/entrar', { usuario: 'pedro', contrasena: 'equivocada' });
  assert.equal(mala.estado, 401);
  const inexistente = await mecanico.pedir('POST', '/api/entrar', { usuario: 'nadie', contrasena: 'equivocada' });
  assert.equal(inexistente.datos.error, mala.datos.error, 'no se revela si el usuario existe');
  const buena = await mecanico.pedir('POST', '/api/entrar', { usuario: ' Pedro ', contrasena: 'tornillo-88' });
  assert.equal(buena.estado, 200);
  assert.equal(buena.datos.usuario.nombre, 'Pedro López');
  assert.equal(buena.datos.usuario.rol, 'tecnico');
});

test('equipos y piezas: el administrador los registra, el técnico los consulta', async () => {
  ids.tambor = (await admin.pedir('POST', '/api/equipos', { nombre: 'Tambor granulador', ubicacion_tecnica: 'PGEP-GRAN-TG01', notas: 'Motor de 75 HP' })).datos.id;
  ids.secador = (await admin.pedir('POST', '/api/equipos', { nombre: 'Secador rotativo', ubicacion_tecnica: 'PGEP-SEC-SR01' })).datos.id;
  assert.equal((await admin.pedir('POST', '/api/equipos', { nombre: 'Criba' })).estado, 400);
  await espera();
  ids.rodamiento = (await admin.pedir('POST', `/api/equipos/${ids.tambor}/piezas`, { nombre: 'Rodamiento', codigo: '22320-E1', cantidad: 4 })).datos.id;
  ids.faja = (await admin.pedir('POST', `/api/equipos/${ids.secador}/piezas`, { nombre: 'Faja en V', codigo: 'B-112' })).datos.id;
  assert.equal((await admin.pedir('POST', `/api/equipos/${ids.tambor}/piezas`, { nombre: 'Perno', cantidad: 0 })).estado, 400);

  assert.equal((await mecanico.pedir('POST', '/api/equipos', { nombre: 'Molino', ubicacion_tecnica: 'X' })).estado, 403);
  assert.equal((await mecanico.pedir('DELETE', `/api/piezas/${ids.rodamiento}`)).estado, 403);
  assert.equal((await mecanico.pedir('POST', '/api/personal', { nombre: 'Y', puesto: 'mecanico' })).estado, 403);

  await espera();
  assert.ok(mecanico.eventos.cambios > 0, 'el técnico recibe los cambios en vivo');
  const lista = await mecanico.pedir('GET', '/api/equipos');
  assert.deepEqual(lista.datos.map((e) => e.nombre), ['Secador rotativo', 'Tambor granulador']);
  assert.equal(lista.datos.find((e) => e.id === ids.tambor).piezas, 1);
  const detalle = await mecanico.pedir('GET', `/api/equipos/${ids.tambor}`);
  assert.equal(detalle.datos.ubicacion_tecnica, 'PGEP-GRAN-TG01');
  assert.equal(detalle.datos.piezas[0].cantidad, 4);
  assert.equal((await mecanico.pedir('GET', '/api/personal')).datos[0].usuario, undefined, 'el técnico no ve los usuarios');
});

test('mantenimientos: programar, iniciar, terminar y permisos', async () => {
  const base = { equipo_id: ids.tambor, tipo: 'preventivo', trabajo: 'Cambio de rodamientos', fecha_programada: '2026-10-15' };
  assert.equal((await admin.pedir('POST', '/api/mantenimientos', { ...base, pieza_ids: [ids.faja] })).estado, 400, 'pieza de otro equipo');
  assert.equal((await admin.pedir('POST', '/api/mantenimientos', { ...base, fecha_programada: '2026-02-30' })).estado, 400);
  const creado = await admin.pedir('POST', '/api/mantenimientos', { ...base, detalles: 'Revisar sello', personal_ids: [ids.pedro, ids.luis], pieza_ids: [ids.rodamiento] });
  assert.equal(creado.estado, 200, JSON.stringify(creado.datos));
  ids.trabajo = creado.datos.id;
  await espera();
  const reporte = await mecanico.pedir('POST', '/api/mantenimientos', { equipo_id: ids.secador, tipo: 'correctivo', trabajo: 'Faja rota', fecha_programada: '2026-10-09', personal_ids: [ids.pedro] });
  ids.reporte = reporte.datos.id;
  await espera();

  const lista = await mecanico.pedir('GET', '/api/mantenimientos');
  const trabajo = lista.datos.find((m) => m.id === ids.trabajo);
  assert.equal(trabajo.equipo_nombre, 'Tambor granulador');
  assert.deepEqual(trabajo.personal.map((p) => p.nombre), ['Luis Ramírez', 'Pedro López']);
  assert.equal(trabajo.piezas[0].codigo, '22320-E1');
  assert.equal(trabajo.puede_editar, false);
  assert.equal(lista.datos.find((m) => m.id === ids.reporte).puede_editar, true);
  assert.deepEqual(lista.datos.map((m) => m.fecha_programada), ['2026-10-09', '2026-10-15']);

  assert.equal((await mecanico.pedir('PUT', `/api/mantenimientos/${ids.trabajo}`, { ...base, trabajo: 'Otro' })).estado, 403);
  assert.equal((await mecanico.pedir('DELETE', `/api/mantenimientos/${ids.trabajo}`)).estado, 403);
  assert.equal((await mecanico.pedir('POST', `/api/mantenimientos/${ids.trabajo}/estado`, { estado: 'en_proceso' })).estado, 200);
  assert.equal((await mecanico.pedir('POST', `/api/mantenimientos/${ids.trabajo}/estado`, { estado: 'terminado', observaciones: 'Se cambiaron los 4' })).estado, 200);
  assert.equal((await mecanico.pedir('POST', `/api/mantenimientos/${ids.trabajo}/estado`, { estado: 'listo' })).estado, 400);
  await espera();
  const terminado = (await admin.pedir('GET', `/api/equipos/${ids.tambor}`)).datos.mantenimientos[0];
  assert.equal(terminado.estado, 'terminado');
  assert.equal(terminado.terminado_por_nombre, 'Pedro López');
  assert.match(terminado.fecha_terminado, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(terminado.observaciones, 'Se cambiaron los 4');

  await admin.pedir('POST', `/api/mantenimientos/${ids.trabajo}/estado`, { estado: 'pendiente' });
  await espera();
  const reabierto = (await admin.pedir('GET', `/api/equipos/${ids.tambor}`)).datos.mantenimientos[0];
  assert.equal(reabierto.fecha_terminado, null);
  assert.equal(reabierto.observaciones, 'Se cambiaron los 4');
});

test('personal con historial no se elimina; al desactivarlo pierde el acceso al instante', async () => {
  assert.equal((await admin.pedir('DELETE', `/api/personal/${ids.luis}`)).estado, 409);
  const soldador = await dispositivo();
  assert.equal((await soldador.pedir('POST', '/api/entrar', { usuario: 'luis', contrasena: 'electrodo-7018' })).estado, 200);
  assert.equal((await soldador.pedir('GET', '/api/equipos')).estado, 200);

  assert.equal((await admin.pedir('PUT', `/api/personal/${ids.luis}`, { nombre: 'Luis Ramírez', puesto: 'soldador', activo: false })).estado, 200);
  await espera();
  assert.equal(soldador.eventos.perdidas.length, 1, 'su sesión abierta se cierra');
  assert.equal((await soldador.pedir('GET', '/api/equipos')).estado, 401);
  assert.equal((await soldador.pedir('POST', '/api/entrar', { usuario: 'luis', contrasena: 'electrodo-7018' })).estado, 401);
  const asignar = await admin.pedir('POST', '/api/mantenimientos', { equipo_id: ids.tambor, tipo: 'preventivo', trabajo: 'Soldar aspas', fecha_programada: '2026-11-01', personal_ids: [ids.luis] });
  assert.equal(asignar.estado, 400);
});

test('siempre queda un administrador', async () => {
  const yo = (await admin.pedir('GET', '/api/estado')).datos.usuario;
  assert.equal((await admin.pedir('PUT', `/api/personal/${yo.personal_id}`, { nombre: yo.nombre, puesto: 'supervisor', cuenta: null })).estado, 409);
  assert.equal((await admin.pedir('PUT', `/api/personal/${yo.personal_id}`, { nombre: yo.nombre, puesto: 'supervisor', cuenta: { usuario: 'manuel', rol: 'tecnico' } })).estado, 409);
  assert.equal((await admin.pedir('PUT', `/api/personal/${yo.personal_id}`, { nombre: yo.nombre, puesto: 'supervisor', activo: false })).estado, 409);
  assert.equal((await admin.pedir('DELETE', `/api/personal/${yo.personal_id}`)).estado, 409);
  assert.equal((await admin.pedir('GET', '/api/estado')).datos.usuario.rol, 'admin');
});

test('contraseñas: cambiar la propia y restablecer la de otro', async () => {
  assert.equal((await mecanico.pedir('POST', '/api/mi-contrasena', { actual: 'no-es', nueva: 'llave-inglesa-9' })).estado, 400);
  assert.equal((await mecanico.pedir('POST', '/api/mi-contrasena', { actual: 'tornillo-88', nueva: 'llave-inglesa-9' })).estado, 200);
  const otro = await dispositivo();
  assert.equal((await otro.pedir('POST', '/api/entrar', { usuario: 'pedro', contrasena: 'tornillo-88' })).estado, 401);
  assert.equal((await otro.pedir('POST', '/api/entrar', { usuario: 'pedro', contrasena: 'llave-inglesa-9' })).estado, 200);

  const restablecer = await admin.pedir('PUT', `/api/personal/${ids.pedro}`, { nombre: 'Pedro López', puesto: 'mecanico', cuenta: { usuario: 'pedro', contrasena: 'nueva-clave-1', rol: 'tecnico' } });
  assert.equal(restablecer.estado, 200, JSON.stringify(restablecer.datos));
  await espera();
  assert.equal(mecanico.eventos.perdidas.length, 1, 'al restablecerla se cierran sus sesiones');
  assert.equal((await mecanico.pedir('POST', '/api/entrar', { usuario: 'pedro', contrasena: 'llave-inglesa-9' })).estado, 401);
  assert.equal((await mecanico.pedir('POST', '/api/entrar', { usuario: 'pedro', contrasena: 'nueva-clave-1' })).estado, 200);
  const yo = (await admin.pedir('GET', '/api/estado')).datos.usuario;
  const propia = await admin.pedir('PUT', `/api/personal/${yo.personal_id}`, { nombre: yo.nombre, puesto: 'supervisor', cuenta: { usuario: 'manuel', rol: 'admin', contrasena: 'otra-clave-123' } });
  assert.equal(propia.estado, 409, 'la propia se cambia en Mi cuenta');
});

test('cambiar el nombre de usuario', async () => {
  assert.equal((await admin.pedir('PUT', `/api/personal/${ids.pedro}`, { nombre: 'Pedro López', puesto: 'mecanico', cuenta: { usuario: 'plopez', rol: 'tecnico' } })).estado, 200);
  const d = await dispositivo();
  assert.equal((await d.pedir('POST', '/api/entrar', { usuario: 'pedro', contrasena: 'nueva-clave-1' })).estado, 401);
  assert.equal((await d.pedir('POST', '/api/entrar', { usuario: 'plopez', contrasena: 'nueva-clave-1' })).estado, 200);
});

test('fondo de pantalla e imagen propia', async () => {
  assert.equal((await mecanico.pedir('PUT', '/api/fondo', { fondo: 'noche' })).estado, 403);
  assert.equal((await admin.pedir('PUT', '/api/fondo', { fondo: 'propio' })).estado, 400);
  assert.equal((await admin.pedir('PUT', '/api/fondo', { fondo: 'inventado' })).estado, 400);
  const incluido = await admin.pedir('PUT', '/api/fondo', { fondo: 'atardecer' });
  assert.equal(incluido.datos.url, 'fondos/atardecer.svg');
  assert.equal((await admin.pedir('POST', '/api/fondo/imagen', { imagen: 'data:text/html;base64,PHNjcmlwdD4=' })).estado, 400);
  assert.equal((await admin.pedir('POST', '/api/fondo/imagen', { imagen: `data:image/jpeg;base64,${'A'.repeat(1000 * 1024)}` })).estado, 413);
  const imagen = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';
  const subida = await admin.pedir('POST', '/api/fondo/imagen', { imagen });
  assert.equal(subida.datos.nombre, 'propio');
  assert.equal(subida.datos.url, imagen);
  const anonimo = await dispositivo();
  assert.equal((await anonimo.pedir('GET', '/api/estado')).datos.fondo.url, imagen, 'la pantalla de entrada también lo ve');
});

test('respaldo y eliminaciones en cadena', async () => {
  assert.equal((await mecanico.pedir('GET', '/api/respaldo')).estado, 403);
  const copia = await admin.pedir('GET', '/api/respaldo');
  assert.equal(copia.datos.equipos.length, 2);
  assert.ok(copia.datos.usuarios.every((u) => !('clave' in u)));

  assert.equal((await admin.pedir('DELETE', `/api/piezas/${ids.rodamiento}`)).estado, 200);
  await espera();
  assert.deepEqual((await admin.pedir('GET', '/api/mantenimientos')).datos.find((m) => m.id === ids.trabajo).piezas, []);
  assert.equal((await admin.pedir('DELETE', `/api/equipos/${ids.secador}`)).estado, 200);
  await espera();
  assert.equal((await admin.pedir('GET', `/api/equipos/${ids.secador}`)).estado, 404);
  assert.equal([...nube.documentos.keys()].filter((r) => r.startsWith('piezas/')).length, 0);
  assert.ok(!(await admin.pedir('GET', '/api/mantenimientos')).datos.some((m) => m.id === ids.reporte));
});

test('la sesión se recuerda al volver a abrir la página, y salir la cierra', async () => {
  const cliente = nube.cliente();
  const primera = crearDatos(cliente);
  await primera.iniciar();
  await primera.api('POST', '/api/entrar', { usuario: 'manuel', contrasena: 'granuladora-2026' });
  const segunda = crearDatos(cliente); // misma página recargada
  await segunda.iniciar();
  assert.equal((await segunda.api('GET', '/api/estado')).usuario.usuario, 'manuel');
  await segunda.api('POST', '/api/salir');
  await assert.rejects(segunda.api('GET', '/api/equipos'), (e) => e.estado === 401);
});
