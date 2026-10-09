'use strict';

// API del sistema. Todas las rutas viven bajo /api y hablan JSON.
// Permisos:
//   publico -> sin sesión (estado, configuración inicial, entrar)
//   sesion  -> cualquier persona con usuario activo
//   admin   -> solo administradores

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { transaccion } = require('./db');
const { crearHash, verificarHash, nuevoToken, hashToken } = require('./seguridad');

const PLANTA = 'PLANTA GRANULADORA EL PILAR';
const PUESTOS = ['mecanico', 'soldador', 'electricista', 'supervisor', 'otro'];
const ROLES = ['admin', 'tecnico'];
const TIPOS = ['preventivo', 'correctivo'];
const ESTADOS = ['pendiente', 'en_proceso', 'terminado'];

const DURACION_SESION_S = 12 * 60 * 60;
const TAMANO_MAXIMO_CUERPO = 100 * 1024;
const INTENTOS_PERMITIDOS = 5;
const BLOQUEO_MS = 5 * 60 * 1000;
const CONTRASENA_MINIMA = 8;

// Fondos de pantalla. Los incluidos son dibujos propios del sistema; "propio"
// es una imagen que sube el administrador y que queda solo en esta computadora.
const FONDOS_INCLUIDOS = ['atardecer', 'noche', 'cerezos'];
const TAMANO_MAXIMO_IMAGEN = 8 * 1024 * 1024;
const TIPOS_DE_IMAGEN = ['image/jpeg', 'image/png', 'image/webp'];

// Reconoce el formato por los primeros bytes del archivo, no por lo que diga
// quien lo envía. Solo se aceptan fotos (JPG, PNG, WebP), nunca SVG ni HTML.
function tipoDeImagen(bytes) {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

class ErrorApi extends Error {
  constructor(estado, mensaje) {
    super(mensaje);
    this.estado = estado;
  }
}

// ---------- Lectura y validación de datos recibidos ----------

function texto(valor, campo, { max = 120, requerido = true } = {}) {
  if (valor === undefined || valor === null) valor = '';
  if (typeof valor !== 'string') throw new ErrorApi(400, `El dato "${campo}" no es válido.`);
  const limpio = valor.trim();
  if (requerido && !limpio) throw new ErrorApi(400, `Falta llenar: ${campo}.`);
  if (limpio.length > max) {
    throw new ErrorApi(400, `"${campo}" es demasiado largo (máximo ${max} caracteres).`);
  }
  return limpio;
}

function opcion(valor, permitidas, campo) {
  if (!permitidas.includes(valor)) throw new ErrorApi(400, `Elija una opción válida en: ${campo}.`);
  return valor;
}

function entero(valor, campo, { min = 1, max = 1000000 } = {}) {
  const numero = typeof valor === 'string' && valor.trim() !== '' ? Number(valor) : valor;
  if (!Number.isInteger(numero) || numero < min || numero > max) {
    throw new ErrorApi(400, `"${campo}" debe ser un número entero entre ${min} y ${max}.`);
  }
  return numero;
}

function fecha(valor, campo) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    throw new ErrorApi(400, `Elija una fecha válida en: ${campo}.`);
  }
  const [anio, mes, dia] = valor.split('-').map(Number);
  const real = new Date(Date.UTC(anio, mes - 1, dia));
  if (real.getUTCFullYear() !== anio || real.getUTCMonth() !== mes - 1 || real.getUTCDate() !== dia) {
    throw new ErrorApi(400, `Elija una fecha válida en: ${campo}.`);
  }
  return valor;
}

function listaIds(valor, campo) {
  if (valor === undefined || valor === null) return [];
  if (!Array.isArray(valor) || valor.length > 200) {
    throw new ErrorApi(400, `La lista "${campo}" no es válida.`);
  }
  return [...new Set(valor.map((id) => entero(id, campo)))];
}

function nombreUsuario(valor) {
  const usuario = texto(valor, 'usuario', { max: 30 }).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(usuario)) {
    throw new ErrorApi(
      400,
      'El usuario debe tener de 3 a 30 caracteres: solo letras sin tilde, números, punto, guion o guion bajo.',
    );
  }
  return usuario;
}

function contrasenaNueva(valor) {
  if (typeof valor !== 'string' || valor.length < CONTRASENA_MINIMA) {
    throw new ErrorApi(400, `La contraseña debe tener al menos ${CONTRASENA_MINIMA} caracteres.`);
  }
  if (valor.length > 200) throw new ErrorApi(400, 'La contraseña es demasiado larga.');
  return valor;
}

function hoyLocal() {
  const d = new Date();
  const dos = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
}

// ---------- API ----------

function crearApi(db, { carpetaDatos = null } = {}) {
  const rutas = [];
  const archivoFondo = carpetaDatos ? path.join(carpetaDatos, 'fondo-propio') : null;
  const fallosDeEntrada = new Map();
  let hashSenuelo = null;

  // opciones.imagen: la ruta recibe una imagen en lugar de datos JSON.
  function ruta(metodo, patron, permiso, manejador, opciones = {}) {
    const nombres = [];
    const fuente = patron.replace(/:(\w+)/g, (_, nombre) => {
      nombres.push(nombre);
      return '(\\d{1,9})';
    });
    rutas.push({ metodo, expresion: new RegExp(`^${fuente}$`), nombres, permiso, manejador, ...opciones });
  }

  // ----- Sesiones -----

  const consultaSesion = db.prepare(`
    SELECT u.id AS usuario_id, u.usuario, u.rol, p.id AS personal_id, p.nombre, p.puesto
    FROM sesiones s
    JOIN usuarios u ON u.id = s.usuario_id
    JOIN personal p ON p.id = u.personal_id
    WHERE s.token_hash = ? AND s.vence_en > ? AND p.activo = 1`);

  function tokenDeLaPeticion(req) {
    const galletas = req.headers.cookie || '';
    for (const parte of galletas.split(';')) {
      const [nombre, ...resto] = parte.trim().split('=');
      if (nombre === 'sesion') return resto.join('=');
    }
    return null;
  }

  function sesionActual(req) {
    const token = tokenDeLaPeticion(req);
    if (!token) return null;
    const tokenHash = hashToken(token);
    const fila = consultaSesion.get(tokenHash, Math.floor(Date.now() / 1000));
    return fila ? { ...fila, tokenHash } : null;
  }

  function galleta(req, valor, duracion) {
    const segura = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return `sesion=${valor}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${duracion}${segura}`;
  }

  function abrirSesion(req, res, usuarioId) {
    const ahora = Math.floor(Date.now() / 1000);
    db.prepare('DELETE FROM sesiones WHERE vence_en <= ?').run(ahora);
    const token = nuevoToken();
    db.prepare('INSERT INTO sesiones (token_hash, usuario_id, vence_en) VALUES (?, ?, ?)').run(
      hashToken(token),
      usuarioId,
      ahora + DURACION_SESION_S,
    );
    res.setHeader('Set-Cookie', galleta(req, token, DURACION_SESION_S));
  }

  function cerrarSesionesDe(usuarioId, exceptoHash = '') {
    db.prepare('DELETE FROM sesiones WHERE usuario_id = ? AND token_hash <> ?').run(usuarioId, exceptoHash);
  }

  function datosDeUsuario(sesion) {
    return {
      personal_id: sesion.personal_id,
      nombre: sesion.nombre,
      puesto: sesion.puesto,
      usuario: sesion.usuario,
      rol: sesion.rol,
    };
  }

  function hayUsuarios() {
    return db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n > 0;
  }

  function exigirUnAdministrador() {
    const { n } = db
      .prepare(
        `SELECT COUNT(*) AS n FROM usuarios u JOIN personal p ON p.id = u.personal_id
         WHERE u.rol = 'admin' AND p.activo = 1`,
      )
      .get();
    if (n === 0) {
      throw new ErrorApi(409, 'Debe quedar al menos un administrador activo con usuario en el sistema.');
    }
  }

  // ----- Estado, configuración inicial y entrada -----

  ruta('GET', '/api/estado', 'publico', ({ req }) => {
    const sesion = sesionActual(req);
    return {
      planta: PLANTA,
      configurado: hayUsuarios(),
      usuario: sesion ? datosDeUsuario(sesion) : null,
      fondo: fondoActual(),
    };
  });

  // Solo funciona mientras no exista ningún usuario: crea al primer administrador.
  ruta('POST', '/api/configurar', 'publico', async ({ req, res, cuerpo }) => {
    if (hayUsuarios()) throw new ErrorApi(409, 'El sistema ya tiene un administrador. Entre con su usuario.');
    const nombre = texto(cuerpo.nombre, 'nombre completo');
    const usuario = nombreUsuario(cuerpo.usuario);
    const claveHash = await crearHash(contrasenaNueva(cuerpo.contrasena));
    const usuarioId = transaccion(db, () => {
      if (hayUsuarios()) throw new ErrorApi(409, 'El sistema ya tiene un administrador. Entre con su usuario.');
      const persona = db
        .prepare("INSERT INTO personal (nombre, puesto) VALUES (?, 'supervisor')")
        .run(nombre);
      return db
        .prepare("INSERT INTO usuarios (personal_id, usuario, clave_hash, rol) VALUES (?, ?, ?, 'admin')")
        .run(persona.lastInsertRowid, usuario, claveHash).lastInsertRowid;
    });
    abrirSesion(req, res, usuarioId);
    return { usuario: datosDeUsuario(sesionPorUsuario(usuarioId)) };
  });

  function sesionPorUsuario(usuarioId) {
    return db
      .prepare(
        `SELECT u.id AS usuario_id, u.usuario, u.rol, p.id AS personal_id, p.nombre, p.puesto
         FROM usuarios u JOIN personal p ON p.id = u.personal_id WHERE u.id = ?`,
      )
      .get(usuarioId);
  }

  ruta('POST', '/api/entrar', 'publico', async ({ req, res, cuerpo }) => {
    const usuario = typeof cuerpo.usuario === 'string' ? cuerpo.usuario.trim().toLowerCase().slice(0, 30) : '';
    const contrasena = typeof cuerpo.contrasena === 'string' ? cuerpo.contrasena.slice(0, 200) : '';

    const registro = fallosDeEntrada.get(usuario);
    if (registro && registro.hasta > Date.now()) {
      const minutos = Math.ceil((registro.hasta - Date.now()) / 60000);
      throw new ErrorApi(
        429,
        `Demasiados intentos fallidos. Espere ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'} y vuelva a intentar.`,
      );
    }

    const fila = db
      .prepare(
        `SELECT u.id, u.clave_hash, p.activo FROM usuarios u
         JOIN personal p ON p.id = u.personal_id WHERE u.usuario = ?`,
      )
      .get(usuario);
    // Si el usuario no existe se verifica contra un hash de relleno, para que la
    // respuesta tarde lo mismo y no revele qué usuarios existen.
    if (!fila && !hashSenuelo) hashSenuelo = await crearHash(nuevoToken());
    const coincide = await verificarHash(contrasena, fila ? fila.clave_hash : hashSenuelo);

    if (!fila || !coincide || !fila.activo) {
      if (fallosDeEntrada.size > 5000) fallosDeEntrada.clear();
      const fallos = (registro && registro.hasta === 0 ? registro.fallos : 0) + 1;
      fallosDeEntrada.set(
        usuario,
        fallos >= INTENTOS_PERMITIDOS ? { fallos: 0, hasta: Date.now() + BLOQUEO_MS } : { fallos, hasta: 0 },
      );
      throw new ErrorApi(401, 'Usuario o contraseña incorrectos.');
    }

    fallosDeEntrada.delete(usuario);
    abrirSesion(req, res, fila.id);
    return { usuario: datosDeUsuario(sesionPorUsuario(fila.id)) };
  });

  ruta('POST', '/api/salir', 'publico', ({ req, res }) => {
    const token = tokenDeLaPeticion(req);
    if (token) db.prepare('DELETE FROM sesiones WHERE token_hash = ?').run(hashToken(token));
    res.setHeader('Set-Cookie', galleta(req, '', 0));
    return { ok: true };
  });

  ruta('POST', '/api/mi-contrasena', 'sesion', async ({ cuerpo, yo }) => {
    const actual = typeof cuerpo.actual === 'string' ? cuerpo.actual.slice(0, 200) : '';
    const fila = db.prepare('SELECT clave_hash FROM usuarios WHERE id = ?').get(yo.usuario_id);
    if (!(await verificarHash(actual, fila.clave_hash))) {
      throw new ErrorApi(400, 'La contraseña actual no es correcta.');
    }
    const claveHash = await crearHash(contrasenaNueva(cuerpo.nueva));
    db.prepare('UPDATE usuarios SET clave_hash = ? WHERE id = ?').run(claveHash, yo.usuario_id);
    cerrarSesionesDe(yo.usuario_id, yo.tokenHash);
    return { ok: true };
  });

  // ----- Personal y usuarios -----

  function leerCuenta(cuenta, { exigirContrasena }) {
    if (typeof cuenta !== 'object' || Array.isArray(cuenta)) {
      throw new ErrorApi(400, 'Los datos del usuario no son válidos.');
    }
    const usuario = nombreUsuario(cuenta.usuario);
    const rol = opcion(cuenta.rol, ROLES, 'tipo de acceso');
    const tieneContrasena = typeof cuenta.contrasena === 'string' && cuenta.contrasena !== '';
    if (exigirContrasena && !tieneContrasena) {
      throw new ErrorApi(400, 'Escriba una contraseña para el usuario.');
    }
    return { usuario, rol, contrasena: tieneContrasena ? contrasenaNueva(cuenta.contrasena) : null };
  }

  function exigirUsuarioLibre(usuario, exceptoPersonalId = 0) {
    const ocupado = db
      .prepare('SELECT 1 FROM usuarios WHERE usuario = ? AND personal_id <> ?')
      .get(usuario, exceptoPersonalId);
    if (ocupado) throw new ErrorApi(409, `Ya existe el usuario "${usuario}". Elija otro nombre de usuario.`);
  }

  function personaPorId(id) {
    const persona = db
      .prepare(
        `SELECT p.id, p.nombre, p.puesto, p.activo, u.id AS usuario_id, u.usuario, u.rol
         FROM personal p LEFT JOIN usuarios u ON u.personal_id = p.id WHERE p.id = ?`,
      )
      .get(id);
    if (!persona) throw new ErrorApi(404, 'Esa persona ya no existe.');
    return persona;
  }

  ruta('GET', '/api/personal', 'sesion', ({ yo }) => {
    if (yo.rol !== 'admin') {
      return db.prepare('SELECT id, nombre, puesto, activo FROM personal ORDER BY nombre COLLATE NOCASE').all();
    }
    return db
      .prepare(
        `SELECT p.id, p.nombre, p.puesto, p.activo, u.usuario, u.rol,
                (SELECT COUNT(*) FROM mantenimiento_personal mp WHERE mp.personal_id = p.id) AS trabajos
         FROM personal p LEFT JOIN usuarios u ON u.personal_id = p.id
         ORDER BY p.nombre COLLATE NOCASE`,
      )
      .all();
  });

  ruta('POST', '/api/personal', 'admin', async ({ cuerpo }) => {
    const nombre = texto(cuerpo.nombre, 'nombre completo');
    const puesto = opcion(cuerpo.puesto, PUESTOS, 'puesto');
    let cuenta = null;
    let claveHash = null;
    if (cuerpo.cuenta) {
      cuenta = leerCuenta(cuerpo.cuenta, { exigirContrasena: true });
      exigirUsuarioLibre(cuenta.usuario);
      claveHash = await crearHash(cuenta.contrasena);
    }
    const id = transaccion(db, () => {
      const persona = db.prepare('INSERT INTO personal (nombre, puesto) VALUES (?, ?)').run(nombre, puesto);
      if (cuenta) {
        exigirUsuarioLibre(cuenta.usuario);
        db.prepare('INSERT INTO usuarios (personal_id, usuario, clave_hash, rol) VALUES (?, ?, ?, ?)').run(
          persona.lastInsertRowid,
          cuenta.usuario,
          claveHash,
          cuenta.rol,
        );
      }
      return Number(persona.lastInsertRowid);
    });
    return { id };
  });

  ruta('PUT', '/api/personal/:id', 'admin', async ({ cuerpo, params, yo }) => {
    const anterior = personaPorId(params.id);
    const nombre = texto(cuerpo.nombre, 'nombre completo');
    const puesto = opcion(cuerpo.puesto, PUESTOS, 'puesto');
    const activo = cuerpo.activo === undefined ? anterior.activo : cuerpo.activo ? 1 : 0;

    // cuenta: undefined = no tocar, null = quitar el usuario, objeto = crear o cambiar.
    let cuenta;
    let claveHash = null;
    if (cuerpo.cuenta === null) {
      cuenta = null;
    } else if (cuerpo.cuenta !== undefined) {
      cuenta = leerCuenta(cuerpo.cuenta, { exigirContrasena: !anterior.usuario_id });
      exigirUsuarioLibre(cuenta.usuario, anterior.id);
      if (cuenta.contrasena) claveHash = await crearHash(cuenta.contrasena);
    }

    transaccion(db, () => {
      db.prepare('UPDATE personal SET nombre = ?, puesto = ?, activo = ? WHERE id = ?').run(
        nombre,
        puesto,
        activo,
        anterior.id,
      );
      if (cuenta === null) {
        db.prepare('DELETE FROM usuarios WHERE personal_id = ?').run(anterior.id);
      } else if (cuenta && anterior.usuario_id) {
        exigirUsuarioLibre(cuenta.usuario, anterior.id);
        db.prepare('UPDATE usuarios SET usuario = ?, rol = ? WHERE id = ?').run(
          cuenta.usuario,
          cuenta.rol,
          anterior.usuario_id,
        );
        if (claveHash) {
          db.prepare('UPDATE usuarios SET clave_hash = ? WHERE id = ?').run(claveHash, anterior.usuario_id);
        }
      } else if (cuenta) {
        exigirUsuarioLibre(cuenta.usuario, anterior.id);
        db.prepare('INSERT INTO usuarios (personal_id, usuario, clave_hash, rol) VALUES (?, ?, ?, ?)').run(
          anterior.id,
          cuenta.usuario,
          claveHash,
          cuenta.rol,
        );
      }
      // Al desactivar a alguien o cambiarle la contraseña se cierran sus sesiones
      // abiertas (menos la de quien está haciendo el cambio sobre sí mismo).
      if (anterior.usuario_id && (!activo || claveHash)) {
        const propia = anterior.usuario_id === yo.usuario_id ? yo.tokenHash : '';
        cerrarSesionesDe(anterior.usuario_id, propia);
      }
      exigirUnAdministrador();
    });
    return { ok: true };
  });

  ruta('DELETE', '/api/personal/:id', 'admin', ({ params, yo }) => {
    const persona = personaPorId(params.id);
    if (persona.id === yo.personal_id) {
      throw new ErrorApi(409, 'No puede eliminarse a sí mismo. Pídale a otro administrador que lo haga.');
    }
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM mantenimiento_personal WHERE personal_id = ?')
      .get(persona.id);
    if (n > 0) {
      throw new ErrorApi(
        409,
        `${persona.nombre} aparece en ${n} ${n === 1 ? 'mantenimiento' : 'mantenimientos'}. ` +
          'Para conservar ese historial, desactive a la persona en lugar de eliminarla.',
      );
    }
    transaccion(db, () => {
      db.prepare('DELETE FROM personal WHERE id = ?').run(persona.id);
      exigirUnAdministrador();
    });
    return { ok: true };
  });

  // ----- Equipos y piezas -----

  function equipoPorId(id) {
    const equipo = db
      .prepare('SELECT id, nombre, ubicacion_tecnica, notas, creado_en FROM equipos WHERE id = ?')
      .get(id);
    if (!equipo) throw new ErrorApi(404, 'Ese equipo ya no existe.');
    return equipo;
  }

  function leerEquipo(cuerpo) {
    return {
      nombre: texto(cuerpo.nombre, 'nombre del equipo'),
      ubicacion: texto(cuerpo.ubicacion_tecnica, 'ubicación técnica', { max: 60 }),
      notas: texto(cuerpo.notas, 'notas', { max: 1000, requerido: false }),
    };
  }

  function leerPieza(cuerpo) {
    return {
      nombre: texto(cuerpo.nombre, 'nombre de la pieza'),
      codigo: texto(cuerpo.codigo, 'código o número de parte', { max: 60, requerido: false }),
      cantidad: entero(cuerpo.cantidad === undefined || cuerpo.cantidad === '' ? 1 : cuerpo.cantidad, 'cantidad', {
        max: 100000,
      }),
      notas: texto(cuerpo.notas, 'notas', { max: 500, requerido: false }),
    };
  }

  ruta('GET', '/api/equipos', 'sesion', () =>
    db
      .prepare(
        `SELECT e.id, e.nombre, e.ubicacion_tecnica, e.notas,
                (SELECT COUNT(*) FROM piezas p WHERE p.equipo_id = e.id) AS piezas,
                (SELECT COUNT(*) FROM mantenimientos m WHERE m.equipo_id = e.id) AS mantenimientos,
                (SELECT COUNT(*) FROM mantenimientos m
                  WHERE m.equipo_id = e.id AND m.estado <> 'terminado') AS abiertos
         FROM equipos e ORDER BY e.nombre COLLATE NOCASE`,
      )
      .all(),
  );

  ruta('POST', '/api/equipos', 'admin', ({ cuerpo }) => {
    const e = leerEquipo(cuerpo);
    const resultado = db
      .prepare('INSERT INTO equipos (nombre, ubicacion_tecnica, notas) VALUES (?, ?, ?)')
      .run(e.nombre, e.ubicacion, e.notas);
    return { id: Number(resultado.lastInsertRowid) };
  });

  ruta('GET', '/api/equipos/:id', 'sesion', ({ params, yo }) => {
    const equipo = equipoPorId(params.id);
    equipo.piezas = db
      .prepare(
        `SELECT id, nombre, codigo, cantidad, notas FROM piezas
         WHERE equipo_id = ? ORDER BY nombre COLLATE NOCASE`,
      )
      .all(equipo.id);
    equipo.mantenimientos = listarMantenimientos(yo, equipo.id);
    return equipo;
  });

  ruta('PUT', '/api/equipos/:id', 'admin', ({ cuerpo, params }) => {
    const equipo = equipoPorId(params.id);
    const e = leerEquipo(cuerpo);
    db.prepare('UPDATE equipos SET nombre = ?, ubicacion_tecnica = ?, notas = ? WHERE id = ?').run(
      e.nombre,
      e.ubicacion,
      e.notas,
      equipo.id,
    );
    return { ok: true };
  });

  // Elimina el equipo junto con sus piezas y su historial de mantenimientos.
  ruta('DELETE', '/api/equipos/:id', 'admin', ({ params }) => {
    const equipo = equipoPorId(params.id);
    db.prepare('DELETE FROM equipos WHERE id = ?').run(equipo.id);
    return { ok: true };
  });

  ruta('POST', '/api/equipos/:id/piezas', 'admin', ({ cuerpo, params }) => {
    const equipo = equipoPorId(params.id);
    const p = leerPieza(cuerpo);
    const resultado = db
      .prepare('INSERT INTO piezas (equipo_id, nombre, codigo, cantidad, notas) VALUES (?, ?, ?, ?, ?)')
      .run(equipo.id, p.nombre, p.codigo, p.cantidad, p.notas);
    return { id: Number(resultado.lastInsertRowid) };
  });

  function exigirPieza(id) {
    if (!db.prepare('SELECT 1 FROM piezas WHERE id = ?').get(id)) {
      throw new ErrorApi(404, 'Esa pieza ya no existe.');
    }
  }

  ruta('PUT', '/api/piezas/:id', 'admin', ({ cuerpo, params }) => {
    exigirPieza(params.id);
    const p = leerPieza(cuerpo);
    db.prepare('UPDATE piezas SET nombre = ?, codigo = ?, cantidad = ?, notas = ? WHERE id = ?').run(
      p.nombre,
      p.codigo,
      p.cantidad,
      p.notas,
      params.id,
    );
    return { ok: true };
  });

  ruta('DELETE', '/api/piezas/:id', 'admin', ({ params }) => {
    exigirPieza(params.id);
    db.prepare('DELETE FROM piezas WHERE id = ?').run(params.id);
    return { ok: true };
  });

  // ----- Mantenimientos -----

  function listarMantenimientos(yo, equipoId = null) {
    const filtro = equipoId ? 'WHERE m.equipo_id = ?' : '';
    const argumentos = equipoId ? [equipoId] : [];
    const filas = db
      .prepare(
        `SELECT m.id, m.equipo_id, m.tipo, m.trabajo, m.detalles, m.fecha_programada, m.estado,
                m.fecha_terminado, m.observaciones, m.creado_por,
                e.nombre AS equipo_nombre, e.ubicacion_tecnica,
                c.nombre AS creado_por_nombre, t.nombre AS terminado_por_nombre
         FROM mantenimientos m
         JOIN equipos e ON e.id = m.equipo_id
         LEFT JOIN personal c ON c.id = m.creado_por
         LEFT JOIN personal t ON t.id = m.terminado_por
         ${filtro}
         ORDER BY m.fecha_programada, m.id`,
      )
      .all(...argumentos);

    const porId = new Map();
    for (const fila of filas) {
      fila.personal = [];
      fila.piezas = [];
      fila.puede_editar = yo.rol === 'admin' || fila.creado_por === yo.personal_id;
      porId.set(fila.id, fila);
    }
    const asignados = db
      .prepare(
        `SELECT mp.mantenimiento_id, p.id, p.nombre, p.puesto
         FROM mantenimiento_personal mp JOIN personal p ON p.id = mp.personal_id
         JOIN mantenimientos m ON m.id = mp.mantenimiento_id ${filtro}
         ORDER BY p.nombre COLLATE NOCASE`,
      )
      .all(...argumentos);
    for (const a of asignados) {
      porId.get(a.mantenimiento_id).personal.push({ id: a.id, nombre: a.nombre, puesto: a.puesto });
    }
    const piezas = db
      .prepare(
        `SELECT mz.mantenimiento_id, z.id, z.nombre, z.codigo
         FROM mantenimiento_piezas mz JOIN piezas z ON z.id = mz.pieza_id
         JOIN mantenimientos m ON m.id = mz.mantenimiento_id ${filtro}
         ORDER BY z.nombre COLLATE NOCASE`,
      )
      .all(...argumentos);
    for (const z of piezas) {
      porId.get(z.mantenimiento_id).piezas.push({ id: z.id, nombre: z.nombre, codigo: z.codigo });
    }
    return filas;
  }

  function mantenimientoPorId(id) {
    const m = db.prepare('SELECT id, equipo_id, estado, creado_por FROM mantenimientos WHERE id = ?').get(id);
    if (!m) throw new ErrorApi(404, 'Ese mantenimiento ya no existe.');
    return m;
  }

  function leerMantenimiento(cuerpo, anterior = null) {
    const equipoId = entero(cuerpo.equipo_id, 'equipo');
    if (!db.prepare('SELECT 1 FROM equipos WHERE id = ?').get(equipoId)) {
      throw new ErrorApi(400, 'Elija un equipo de la lista.');
    }
    const datos = {
      equipoId,
      tipo: opcion(cuerpo.tipo, TIPOS, 'tipo de mantenimiento'),
      trabajo: texto(cuerpo.trabajo, 'trabajo a realizar', { max: 160 }),
      detalles: texto(cuerpo.detalles, 'detalles', { max: 2000, requerido: false }),
      fecha: fecha(cuerpo.fecha_programada, 'fecha programada'),
      personalIds: listaIds(cuerpo.personal_ids, 'personal asignado'),
      piezaIds: listaIds(cuerpo.pieza_ids, 'piezas'),
    };

    const yaAsignados = new Set(
      anterior
        ? db
            .prepare('SELECT personal_id FROM mantenimiento_personal WHERE mantenimiento_id = ?')
            .all(anterior.id)
            .map((f) => f.personal_id)
        : [],
    );
    for (const id of datos.personalIds) {
      const persona = db.prepare('SELECT activo FROM personal WHERE id = ?').get(id);
      if (!persona) throw new ErrorApi(400, 'Una de las personas asignadas ya no existe.');
      if (!persona.activo && !yaAsignados.has(id)) {
        throw new ErrorApi(400, 'No se puede asignar a una persona desactivada.');
      }
    }
    for (const id of datos.piezaIds) {
      const pieza = db.prepare('SELECT equipo_id FROM piezas WHERE id = ?').get(id);
      if (!pieza || pieza.equipo_id !== equipoId) {
        throw new ErrorApi(400, 'Una de las piezas elegidas no pertenece a ese equipo.');
      }
    }
    return datos;
  }

  function guardarRelaciones(mantenimientoId, datos) {
    db.prepare('DELETE FROM mantenimiento_personal WHERE mantenimiento_id = ?').run(mantenimientoId);
    db.prepare('DELETE FROM mantenimiento_piezas WHERE mantenimiento_id = ?').run(mantenimientoId);
    const ponerPersona = db.prepare(
      'INSERT INTO mantenimiento_personal (mantenimiento_id, personal_id) VALUES (?, ?)',
    );
    const ponerPieza = db.prepare('INSERT INTO mantenimiento_piezas (mantenimiento_id, pieza_id) VALUES (?, ?)');
    for (const id of datos.personalIds) ponerPersona.run(mantenimientoId, id);
    for (const id of datos.piezaIds) ponerPieza.run(mantenimientoId, id);
  }

  ruta('GET', '/api/mantenimientos', 'sesion', ({ yo }) => listarMantenimientos(yo));

  ruta('POST', '/api/mantenimientos', 'sesion', ({ cuerpo, yo }) => {
    const id = transaccion(db, () => {
      const datos = leerMantenimiento(cuerpo);
      const resultado = db
        .prepare(
          `INSERT INTO mantenimientos (equipo_id, tipo, trabajo, detalles, fecha_programada, creado_por)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(datos.equipoId, datos.tipo, datos.trabajo, datos.detalles, datos.fecha, yo.personal_id);
      guardarRelaciones(resultado.lastInsertRowid, datos);
      return Number(resultado.lastInsertRowid);
    });
    return { id };
  });

  ruta('PUT', '/api/mantenimientos/:id', 'sesion', ({ cuerpo, params, yo }) => {
    const anterior = mantenimientoPorId(params.id);
    if (yo.rol !== 'admin' && anterior.creado_por !== yo.personal_id) {
      throw new ErrorApi(403, 'Solo un administrador o quien programó este mantenimiento puede modificarlo.');
    }
    transaccion(db, () => {
      const datos = leerMantenimiento(cuerpo, anterior);
      db.prepare(
        `UPDATE mantenimientos SET equipo_id = ?, tipo = ?, trabajo = ?, detalles = ?, fecha_programada = ?
         WHERE id = ?`,
      ).run(datos.equipoId, datos.tipo, datos.trabajo, datos.detalles, datos.fecha, anterior.id);
      guardarRelaciones(anterior.id, datos);
    });
    return { ok: true };
  });

  // Cualquier persona con usuario puede avanzar un trabajo: iniciarlo, terminarlo
  // o reabrirlo. Queda registrado quién lo terminó y en qué fecha.
  ruta('POST', '/api/mantenimientos/:id/estado', 'sesion', ({ cuerpo, params, yo }) => {
    const anterior = mantenimientoPorId(params.id);
    const estado = opcion(cuerpo.estado, ESTADOS, 'estado');
    const observaciones =
      cuerpo.observaciones === undefined
        ? null
        : texto(cuerpo.observaciones, 'observaciones', { max: 2000, requerido: false });
    const terminado = estado === 'terminado';
    db.prepare(
      `UPDATE mantenimientos
       SET estado = ?, fecha_terminado = ?, terminado_por = ?, observaciones = COALESCE(?, observaciones)
       WHERE id = ?`,
    ).run(estado, terminado ? hoyLocal() : null, terminado ? yo.personal_id : null, observaciones, anterior.id);
    return { ok: true };
  });

  ruta('DELETE', '/api/mantenimientos/:id', 'admin', ({ params }) => {
    const anterior = mantenimientoPorId(params.id);
    db.prepare('DELETE FROM mantenimientos WHERE id = ?').run(anterior.id);
    return { ok: true };
  });

  // ----- Fondo de pantalla -----

  function ajuste(clave, porDefecto) {
    const fila = db.prepare('SELECT valor FROM ajustes WHERE clave = ?').get(clave);
    return fila ? fila.valor : porDefecto;
  }

  function guardarAjuste(clave, valor) {
    db.prepare(
      'INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor',
    ).run(clave, String(valor));
  }

  function hayImagenPropia() {
    return Boolean(archivoFondo && ajuste('fondo_propio_tipo', '') && fs.existsSync(archivoFondo));
  }

  function fondoActual() {
    const propia = hayImagenPropia();
    const urlPropia = propia ? `/api/fondo/imagen?v=${ajuste('fondo_propio_version', '0')}` : null;
    let nombre = ajuste('fondo', 'ninguno');
    if (nombre === 'propio' && !propia) nombre = 'ninguno';
    let url = null;
    if (nombre === 'propio') url = urlPropia;
    else if (FONDOS_INCLUIDOS.includes(nombre)) url = `/fondos/${nombre}.svg`;
    return { nombre, url, urlPropia };
  }

  ruta('PUT', '/api/fondo', 'admin', ({ cuerpo }) => {
    const nombre = opcion(cuerpo.fondo, ['ninguno', 'propio', ...FONDOS_INCLUIDOS], 'fondo');
    if (nombre === 'propio' && !hayImagenPropia()) {
      throw new ErrorApi(400, 'Primero suba una imagen para usarla como fondo.');
    }
    guardarAjuste('fondo', nombre);
    return fondoActual();
  });

  // Recibe la imagen tal cual (no JSON) y la deja como fondo del sistema.
  ruta(
    'POST',
    '/api/fondo/imagen',
    'admin',
    ({ cuerpo }) => {
      if (!archivoFondo) throw new ErrorApi(500, 'Este servidor no tiene dónde guardar imágenes.');
      const tipo = tipoDeImagen(cuerpo);
      if (!tipo) throw new ErrorApi(400, 'El archivo no es una imagen JPG, PNG o WebP.');
      // Se escribe primero en un archivo temporal para no dejar una imagen a medias.
      const temporal = `${archivoFondo}.tmp`;
      fs.writeFileSync(temporal, cuerpo);
      fs.renameSync(temporal, archivoFondo);
      guardarAjuste('fondo_propio_tipo', tipo);
      guardarAjuste('fondo_propio_version', Number(ajuste('fondo_propio_version', '0')) + 1);
      guardarAjuste('fondo', 'propio');
      return fondoActual();
    },
    { imagen: true },
  );

  // Pública a propósito: la pantalla de entrada también muestra el fondo.
  ruta('GET', '/api/fondo/imagen', 'publico', ({ res }) => {
    if (!hayImagenPropia()) throw new ErrorApi(404, 'No hay una imagen de fondo.');
    res.writeHead(200, {
      'Content-Type': ajuste('fondo_propio_tipo', 'application/octet-stream'),
      'Content-Length': fs.statSync(archivoFondo).size,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    const flujo = fs.createReadStream(archivoFondo);
    flujo.on('error', () => res.destroy());
    flujo.pipe(res);
  });

  // ----- Respaldo -----

  // Descarga una copia completa y consistente de la base de datos.
  ruta('GET', '/api/respaldo', 'admin', ({ res }) => {
    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'respaldo-'));
    const archivo = path.join(carpeta, 'respaldo.db');
    const limpiar = () => fs.rm(carpeta, { recursive: true, force: true }, () => {});
    try {
      db.prepare('VACUUM INTO ?').run(archivo);
    } catch (error) {
      limpiar();
      throw error;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': fs.statSync(archivo).size,
      'Content-Disposition': `attachment; filename="respaldo-planta-el-pilar-${hoyLocal()}.db"`,
      'Cache-Control': 'no-store',
    });
    const flujo = fs.createReadStream(archivo);
    flujo.on('close', limpiar);
    flujo.on('error', () => res.destroy());
    flujo.pipe(res);
  });

  // ---------- Atención de peticiones ----------

  function leerBytes(req, maximo, mensajeExceso) {
    return new Promise((resolver, rechazar) => {
      const trozos = [];
      let total = 0;
      let excedido = false;
      req.on('data', (trozo) => {
        if (excedido) return;
        total += trozo.length;
        if (total > maximo) {
          // Se deja de guardar, pero se sigue recibiendo para poder responder
          // con un mensaje claro en lugar de cortar la conexión.
          excedido = true;
          trozos.length = 0;
          rechazar(new ErrorApi(413, mensajeExceso));
          return;
        }
        trozos.push(trozo);
      });
      req.on('error', rechazar);
      req.on('end', () => {
        if (!excedido) resolver(Buffer.concat(trozos));
      });
    });
  }

  async function leerCuerpo(req) {
    const bytes = await leerBytes(req, TAMANO_MAXIMO_CUERPO, 'Los datos enviados son demasiado grandes.');
    if (bytes.length === 0) return {};
    try {
      const datos = JSON.parse(bytes.toString('utf8'));
      if (datos === null || typeof datos !== 'object' || Array.isArray(datos)) throw new Error('forma');
      return datos;
    } catch {
      throw new ErrorApi(400, 'Los datos enviados no se pudieron leer.');
    }
  }

  function responder(res, estado, datos) {
    const cuerpo = JSON.stringify(datos);
    res.writeHead(estado, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(cuerpo),
      'Cache-Control': 'no-store',
    });
    res.end(cuerpo);
  }

  async function atender(req, res, url) {
    try {
      const candidatas = rutas.filter((r) => r.expresion.test(url.pathname));
      if (candidatas.length === 0) throw new ErrorApi(404, 'Esa dirección no existe.');
      const elegida = candidatas.find((r) => r.metodo === req.method);
      if (!elegida) throw new ErrorApi(405, 'Operación no permitida en esa dirección.');

      // Primero se revisa quién pide: nadie sin permiso llega a enviar datos.
      let yo = null;
      if (elegida.permiso !== 'publico') {
        yo = sesionActual(req);
        if (!yo) throw new ErrorApi(401, 'Su sesión terminó. Entre de nuevo con su usuario y contraseña.');
        if (elegida.permiso === 'admin' && yo.rol !== 'admin') {
          throw new ErrorApi(403, 'Solo un administrador puede hacer este cambio.');
        }
      }

      let cuerpo = {};
      if (req.method !== 'GET') {
        // Las peticiones que cambian datos deben venir de las páginas del propio
        // sistema y en formato JSON; así otro sitio web no puede enviarlas a
        // nombre de alguien que tiene la sesión abierta.
        const origen = req.headers.origin;
        if (origen) {
          let anfitrion = null;
          try {
            anfitrion = new URL(origen).host;
          } catch {
            /* origen ilegible: se rechaza abajo */
          }
          if (anfitrion !== req.headers.host) throw new ErrorApi(403, 'Petición rechazada: origen no permitido.');
        }
        const tipo = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (elegida.imagen) {
          if (!TIPOS_DE_IMAGEN.includes(tipo)) throw new ErrorApi(415, 'Suba una imagen JPG, PNG o WebP.');
          cuerpo = await leerBytes(req, TAMANO_MAXIMO_IMAGEN, 'La imagen es demasiado grande. El máximo es 8 MB.');
        } else {
          if (tipo !== 'application/json') throw new ErrorApi(415, 'Los datos deben enviarse en formato JSON.');
          cuerpo = await leerCuerpo(req);
        }
      }

      const coincidencia = elegida.expresion.exec(url.pathname);
      const params = {};
      elegida.nombres.forEach((nombre, i) => {
        params[nombre] = Number(coincidencia[i + 1]);
      });

      const resultado = await elegida.manejador({ req, res, url, cuerpo, yo, params });
      if (!res.headersSent) responder(res, 200, resultado === undefined ? { ok: true } : resultado);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      req.resume(); // descarta lo que falte por llegar para que la respuesta salga limpia
      if (error instanceof ErrorApi) {
        responder(res, error.estado, { error: error.message });
      } else {
        console.error('Error inesperado:', error);
        responder(res, 500, { error: 'Ocurrió un error en el servidor. Intente de nuevo.' });
      }
    }
  }

  return { atender };
}

module.exports = { crearApi, PLANTA };
