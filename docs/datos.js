// Capa de datos del sistema sobre Firebase.
//
// La interfaz pide los datos con api(metodo, ruta, cuerpo), igual que cuando
// había un servidor propio. Aquí esas peticiones se resuelven con Firebase:
// Authentication guarda las contraseñas y Firestore guarda la información.
//
// Las reglas de seguridad de Firestore (archivo firestore.rules) son las que
// de verdad protegen los datos; las comprobaciones de este archivo sirven para
// dar mensajes claros antes de intentar algo que las reglas van a rechazar.
//
// `fb` es el adaptador con las funciones de Firebase (firebase.js en la página;
// uno falso en memoria en las pruebas). Así este archivo no depende de la red.

export const PLANTA = 'PLANTA GRANULADORA EL PILAR';
const PUESTOS = ['mecanico', 'soldador', 'electricista', 'supervisor', 'otro'];
const ROLES = ['admin', 'tecnico'];
const TIPOS = ['preventivo', 'correctivo'];
const ESTADOS = ['pendiente', 'en_proceso', 'terminado'];
const FONDOS_INCLUIDOS = ['atardecer', 'noche', 'cerezos'];
const CONTRASENA_MINIMA = 8;
// Firestore admite documentos de hasta 1 MiB; la imagen va reducida en el navegador.
const TAMANO_MAXIMO_IMAGEN = 950 * 1024;
// Las cuentas de Firebase necesitan un correo. Nadie lo ve ni recibe nada en él:
// se arma a partir del nombre de usuario.
const DOMINIO_CORREOS = 'usuarios.planta-el-pilar.com';

export class ErrorApi extends Error {
  constructor(estado, mensaje) {
    super(mensaje);
    this.estado = estado;
  }
}

// ---------- Validación de datos ----------

function texto(valor, campo, { max = 120, requerido = true } = {}) {
  if (valor === undefined || valor === null) valor = '';
  if (typeof valor !== 'string') throw new ErrorApi(400, `El dato "${campo}" no es válido.`);
  const limpio = valor.trim();
  if (requerido && !limpio) throw new ErrorApi(400, `Falta llenar: ${campo}.`);
  if (limpio.length > max) throw new ErrorApi(400, `"${campo}" es demasiado largo (máximo ${max} caracteres).`);
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

const ID_VALIDO = /^[A-Za-z0-9_-]{1,40}$/;

function listaIds(valor, campo) {
  if (valor === undefined || valor === null) return [];
  if (!Array.isArray(valor) || valor.length > 200 || !valor.every((id) => typeof id === 'string' && ID_VALIDO.test(id))) {
    throw new ErrorApi(400, `La lista "${campo}" no es válida.`);
  }
  return [...new Set(valor)];
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

function ahora() {
  return new Date().toISOString();
}

const ordenTexto = (a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' });

// Traduce los errores de Firebase a mensajes para el usuario.
function traducir(error) {
  if (error instanceof ErrorApi) return error;
  const codigo = String((error && error.code) || '');
  if (codigo.endsWith('permission-denied')) {
    return new ErrorApi(403, 'No tiene permiso para hacer este cambio, o su acceso fue desactivado.');
  }
  if (codigo === 'auth/too-many-requests') {
    return new ErrorApi(429, 'Demasiados intentos fallidos. Espere unos minutos y vuelva a intentar.');
  }
  if (codigo === 'auth/network-request-failed' || codigo.endsWith('unavailable')) {
    return new ErrorApi(503, 'No hay conexión a internet. Revise la conexión y vuelva a intentar.');
  }
  if (codigo === 'auth/email-already-in-use') {
    return new ErrorApi(409, 'Ese usuario ya existe. Elija otro nombre de usuario.');
  }
  if (codigo === 'auth/weak-password') {
    return new ErrorApi(400, `La contraseña debe tener al menos ${CONTRASENA_MINIMA} caracteres.`);
  }
  console.error('Error inesperado de Firebase:', error);
  return new ErrorApi(500, 'Ocurrió un error inesperado. Intente de nuevo.');
}

const CLAVE_INCORRECTA = ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email', 'auth/user-disabled', 'auth/invalid-login-credentials'];

// ---------- Sistema ----------

export function crearDatos(fb) {
  const COLECCIONES = ['personal', 'equipos', 'piezas', 'mantenimientos'];
  const cache = { personal: new Map(), cuentas: new Map(), equipos: new Map(), piezas: new Map(), mantenimientos: new Map() };
  let sesion = null; // { uid, email, usuario, rol, personal_id }
  let cancelaciones = [];
  let avisarCambio = () => {};
  let avisarSesionPerdida = () => {};

  // ----- Sesión y datos en vivo -----

  function detenerEscucha() {
    for (const cancelar of cancelaciones) cancelar();
    cancelaciones = [];
    for (const mapa of Object.values(cache)) mapa.clear();
  }

  function perderSesion(mensaje) {
    if (!sesion) return;
    sesion = null;
    detenerEscucha();
    fb.auth.salir().catch(() => {});
    avisarSesionPerdida(mensaje);
  }

  // Lee la cuenta del usuario conectado y empieza a recibir los datos en vivo.
  // Devuelve null si esa cuenta no puede usar el sistema.
  async function abrirSesion(usuarioFirebase) {
    detenerEscucha();
    const cuenta = await fb.db.leer(`cuentas/${usuarioFirebase.uid}`);
    if (!cuenta) return null;
    const persona = await fb.db.leer(`personal/${cuenta.personal_id}`).catch(() => null);
    if (!persona || !persona.activo) return null;
    sesion = { uid: usuarioFirebase.uid, email: usuarioFirebase.email, usuario: cuenta.usuario, rol: cuenta.rol, personal_id: cuenta.personal_id };

    const colecciones = sesion.rol === 'admin' ? [...COLECCIONES, 'cuentas'] : COLECCIONES;
    const primeras = colecciones.map(
      (nombre) =>
        new Promise((listo, fallo) => {
          let primera = true;
          const cancelar = fb.db.escuchar(
            nombre,
            (documentos) => {
              const mapa = cache[nombre];
              mapa.clear();
              for (const d of documentos) mapa.set(d.id, d);
              if (primera) {
                primera = false;
                listo();
              } else {
                revisarMiAcceso();
                avisarCambio();
              }
            },
            (error) => {
              if (primera) fallo(error);
              else perderSesion('Su acceso al sistema cambió. Entre de nuevo con su usuario y contraseña.');
            },
          );
          cancelaciones.push(cancelar);
        }),
    );
    // Si un administrador le quita el usuario o le cambia el acceso, se nota al instante.
    cancelaciones.push(
      fb.db.escucharDoc(`cuentas/${sesion.uid}`, (cuentaNueva) => {
        if (!sesion) return;
        if (!cuentaNueva) return perderSesion('Su usuario fue eliminado o su contraseña fue restablecida. Entre de nuevo.');
        if (cuentaNueva.rol !== sesion.rol) return perderSesion('Su tipo de acceso cambió. Entre de nuevo con su usuario y contraseña.');
        sesion.usuario = cuentaNueva.usuario;
      }),
    );
    try {
      await Promise.all(primeras);
    } catch (error) {
      sesion = null;
      detenerEscucha();
      throw traducir(error);
    }
    return sesion;
  }

  function revisarMiAcceso() {
    if (!sesion) return;
    const persona = cache.personal.get(sesion.personal_id);
    if (!persona || !persona.activo) perderSesion('Su acceso al sistema fue desactivado.');
  }

  function datosDeUsuario() {
    const persona = cache.personal.get(sesion.personal_id) || {};
    return { personal_id: sesion.personal_id, nombre: persona.nombre || '', puesto: persona.puesto || 'otro', usuario: sesion.usuario, rol: sesion.rol };
  }

  async function iniciar({ alCambiar, alPerderSesion } = {}) {
    if (alCambiar) avisarCambio = alCambiar;
    if (alPerderSesion) avisarSesionPerdida = alPerderSesion;
    const usuarioFirebase = await fb.auth.esperarUsuario();
    if (!usuarioFirebase) return;
    try {
      if (!(await abrirSesion(usuarioFirebase))) await fb.auth.salir();
    } catch {
      await fb.auth.salir().catch(() => {});
    }
  }

  // ----- Rutas -----

  const rutas = [];
  function ruta(metodo, patron, permiso, manejador) {
    const nombres = [];
    const fuente = patron.replace(/:(\w+)/g, (_, nombre) => {
      nombres.push(nombre);
      return '([A-Za-z0-9_-]{1,40})';
    });
    rutas.push({ metodo, expresion: new RegExp(`^${fuente}$`), nombres, permiso, manejador });
  }

  async function api(metodo, direccion, cuerpo = {}) {
    try {
      const elegida = rutas.find((r) => r.metodo === metodo && r.expresion.test(direccion));
      if (!elegida) throw new ErrorApi(404, 'Esa dirección no existe.');
      if (elegida.permiso !== 'publico') {
        if (!sesion) throw new ErrorApi(401, 'Su sesión terminó. Entre de nuevo con su usuario y contraseña.');
        if (elegida.permiso === 'admin' && sesion.rol !== 'admin') throw new ErrorApi(403, 'Solo un administrador puede hacer este cambio.');
      }
      if (cuerpo === null || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) throw new ErrorApi(400, 'Los datos enviados no se pudieron leer.');
      const params = {};
      const coincidencia = elegida.expresion.exec(direccion);
      elegida.nombres.forEach((nombre, i) => (params[nombre] = coincidencia[i + 1]));
      const resultado = await elegida.manejador({ cuerpo, params, yo: sesion });
      return resultado === undefined ? { ok: true } : resultado;
    } catch (error) {
      throw traducir(error);
    }
  }

  // ----- Estado, configuración inicial y entrada -----

  async function fondoActual() {
    const [elegido, propio] = await Promise.all([fb.db.leer('ajustes/fondo'), fb.db.leer('ajustes/fondo_propio')]);
    const urlPropia = propio && typeof propio.imagen === 'string' ? propio.imagen : null;
    let nombre = (elegido && elegido.nombre) || 'ninguno';
    if (nombre === 'propio' && !urlPropia) nombre = 'ninguno';
    let url = null;
    if (nombre === 'propio') url = urlPropia;
    else if (FONDOS_INCLUIDOS.includes(nombre)) url = `fondos/${nombre}.svg`;
    return { nombre, url, urlPropia };
  }

  ruta('GET', '/api/estado', 'publico', async () => {
    const [sistema, fondo] = await Promise.all([fb.db.leer('ajustes/sistema'), fondoActual()]);
    return { planta: PLANTA, configurado: Boolean(sistema), usuario: sesion ? datosDeUsuario() : null, fondo };
  });

  function correoPara(usuario) {
    // El sufijo al azar permite crear una cuenta nueva con el mismo nombre de
    // usuario cuando el administrador restablece una contraseña.
    return `${usuario}.${fb.nuevoId().slice(0, 8).toLowerCase()}@${DOMINIO_CORREOS}`;
  }

  // Crea al primer administrador. Las reglas solo lo permiten mientras el
  // sistema no esté configurado.
  ruta('POST', '/api/configurar', 'publico', async ({ cuerpo }) => {
    if (await fb.db.leer('ajustes/sistema')) throw new ErrorApi(409, 'El sistema ya tiene un administrador. Entre con su usuario.');
    const nombre = texto(cuerpo.nombre, 'nombre completo');
    const usuario = nombreUsuario(cuerpo.usuario);
    const contrasena = contrasenaNueva(cuerpo.contrasena);
    const email = correoPara(usuario);
    const uid = await fb.auth.registrarYEntrar(email, contrasena);
    const personalId = fb.nuevoId();
    try {
      await fb.db.escribir([
        { tipo: 'set', ruta: 'ajustes/sistema', datos: { configurado: true, admin_inicial: uid, creado_en: ahora() } },
        { tipo: 'set', ruta: `personal/${personalId}`, datos: { nombre, puesto: 'supervisor', activo: true, creado_en: ahora() } },
        { tipo: 'set', ruta: `cuentas/${uid}`, datos: { personal_id: personalId, usuario, rol: 'admin' } },
        { tipo: 'set', ruta: `nombres/${usuario}`, datos: { uid, email } },
      ]);
    } catch (error) {
      await fb.auth.salir().catch(() => {});
      if (String(error && error.code).endsWith('permission-denied')) {
        throw new ErrorApi(409, 'El sistema ya tiene un administrador. Entre con su usuario.');
      }
      throw error;
    }
    await abrirSesion({ uid, email });
    return { usuario: datosDeUsuario() };
  });

  ruta('POST', '/api/entrar', 'publico', async ({ cuerpo }) => {
    const usuario = typeof cuerpo.usuario === 'string' ? cuerpo.usuario.trim().toLowerCase().slice(0, 30) : '';
    const contrasena = typeof cuerpo.contrasena === 'string' ? cuerpo.contrasena.slice(0, 200) : '';
    const incorrecto = new ErrorApi(401, 'Usuario o contraseña incorrectos.');
    if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(usuario) || !contrasena) throw incorrecto;
    const nombre = await fb.db.leer(`nombres/${usuario}`);
    if (!nombre) throw incorrecto;
    let usuarioFirebase;
    try {
      usuarioFirebase = await fb.auth.entrar(nombre.email, contrasena);
    } catch (error) {
      if (CLAVE_INCORRECTA.includes(error && error.code)) throw incorrecto;
      throw error;
    }
    let abierta = null;
    try {
      abierta = await abrirSesion(usuarioFirebase);
    } catch {
      abierta = null;
    }
    if (!abierta) {
      await fb.auth.salir().catch(() => {});
      throw incorrecto;
    }
    return { usuario: datosDeUsuario() };
  });

  ruta('POST', '/api/salir', 'publico', async () => {
    sesion = null;
    detenerEscucha();
    await fb.auth.salir();
    return { ok: true };
  });

  ruta('POST', '/api/mi-contrasena', 'sesion', async ({ cuerpo }) => {
    const actual = typeof cuerpo.actual === 'string' ? cuerpo.actual.slice(0, 200) : '';
    const nueva = contrasenaNueva(cuerpo.nueva);
    try {
      await fb.auth.cambiarClave(actual, nueva);
    } catch (error) {
      if (CLAVE_INCORRECTA.includes(error && error.code)) throw new ErrorApi(400, 'La contraseña actual no es correcta.');
      throw error;
    }
    return { ok: true };
  });

  // ----- Personal y usuarios -----

  function cuentaDe(personalId) {
    for (const [uid, cuenta] of cache.cuentas) if (cuenta.personal_id === personalId) return { uid, ...cuenta };
    return null;
  }

  function personaPorId(id) {
    const persona = cache.personal.get(id);
    if (!persona) throw new ErrorApi(404, 'Esa persona ya no existe.');
    const cuenta = cuentaDe(id);
    return { ...persona, id, usuario_id: cuenta ? cuenta.uid : null, usuario: cuenta ? cuenta.usuario : null, rol: cuenta ? cuenta.rol : null };
  }

  function leerCuenta(cuenta, { exigirContrasena }) {
    if (typeof cuenta !== 'object' || Array.isArray(cuenta)) throw new ErrorApi(400, 'Los datos del usuario no son válidos.');
    const usuario = nombreUsuario(cuenta.usuario);
    const rol = opcion(cuenta.rol, ROLES, 'tipo de acceso');
    const tieneContrasena = typeof cuenta.contrasena === 'string' && cuenta.contrasena !== '';
    if (exigirContrasena && !tieneContrasena) throw new ErrorApi(400, 'Escriba una contraseña para el usuario.');
    return { usuario, rol, contrasena: tieneContrasena ? contrasenaNueva(cuenta.contrasena) : null };
  }

  async function exigirUsuarioLibre(usuario, exceptoUid = null) {
    const ocupado = await fb.db.leer(`nombres/${usuario}`);
    if (ocupado && ocupado.uid !== exceptoUid) throw new ErrorApi(409, `Ya existe el usuario "${usuario}". Elija otro nombre de usuario.`);
  }

  function trabajosDe(personalId) {
    let n = 0;
    for (const m of cache.mantenimientos.values()) if ((m.personal_ids || []).includes(personalId)) n += 1;
    return n;
  }

  ruta('GET', '/api/personal', 'sesion', ({ yo }) => {
    const lista = [...cache.personal.entries()].map(([id, p]) => ({ id, nombre: p.nombre, puesto: p.puesto, activo: p.activo ? 1 : 0 }));
    lista.sort((a, b) => ordenTexto(a.nombre, b.nombre));
    if (yo.rol !== 'admin') return lista;
    return lista.map((p) => {
      const cuenta = cuentaDe(p.id);
      return { ...p, usuario: cuenta ? cuenta.usuario : null, rol: cuenta ? cuenta.rol : null, trabajos: trabajosDe(p.id) };
    });
  });

  ruta('POST', '/api/personal', 'admin', async ({ cuerpo }) => {
    const nombre = texto(cuerpo.nombre, 'nombre completo');
    const puesto = opcion(cuerpo.puesto, PUESTOS, 'puesto');
    const id = fb.nuevoId();
    const operaciones = [{ tipo: 'set', ruta: `personal/${id}`, datos: { nombre, puesto, activo: true, creado_en: ahora() } }];
    if (cuerpo.cuenta) {
      const cuenta = leerCuenta(cuerpo.cuenta, { exigirContrasena: true });
      await exigirUsuarioLibre(cuenta.usuario);
      const email = correoPara(cuenta.usuario);
      const uid = await fb.auth.crearCuenta(email, cuenta.contrasena);
      operaciones.push(
        { tipo: 'set', ruta: `cuentas/${uid}`, datos: { personal_id: id, usuario: cuenta.usuario, rol: cuenta.rol } },
        { tipo: 'set', ruta: `nombres/${cuenta.usuario}`, datos: { uid, email } },
      );
    }
    await fb.db.escribir(operaciones);
    return { id };
  });

  ruta('PUT', '/api/personal/:id', 'admin', async ({ cuerpo, params, yo }) => {
    const anterior = personaPorId(params.id);
    const esYo = anterior.id === yo.personal_id;
    const nombre = texto(cuerpo.nombre, 'nombre completo');
    const puesto = opcion(cuerpo.puesto, PUESTOS, 'puesto');
    const activo = cuerpo.activo === undefined ? Boolean(anterior.activo) : Boolean(cuerpo.activo);
    const operaciones = [{ tipo: 'update', ruta: `personal/${anterior.id}`, datos: { nombre, puesto, activo } }];

    // cuenta: undefined = no tocar, null = quitar el usuario, objeto = crear o cambiar.
    if (esYo && (!activo || cuerpo.cuenta === null || (cuerpo.cuenta && cuerpo.cuenta.rol !== 'admin'))) {
      throw new ErrorApi(409, 'No puede quitarse a sí mismo el acceso de administrador. Pídale a otro administrador que lo haga.');
    }
    if (cuerpo.cuenta === null && anterior.usuario_id) {
      operaciones.push({ tipo: 'delete', ruta: `cuentas/${anterior.usuario_id}` }, { tipo: 'delete', ruta: `nombres/${anterior.usuario}` });
    } else if (cuerpo.cuenta) {
      const cuenta = leerCuenta(cuerpo.cuenta, { exigirContrasena: !anterior.usuario_id });
      if (esYo && cuenta.contrasena) throw new ErrorApi(409, 'Para cambiar su propia contraseña use la sección Mi cuenta.');
      await exigirUsuarioLibre(cuenta.usuario, anterior.usuario_id);
      if (cuenta.contrasena) {
        // Firebase no deja cambiar desde aquí la contraseña de otra persona, así
        // que se le crea una cuenta nueva y la anterior deja de funcionar.
        const email = correoPara(cuenta.usuario);
        const uid = await fb.auth.crearCuenta(email, cuenta.contrasena);
        if (anterior.usuario_id) {
          operaciones.push({ tipo: 'delete', ruta: `cuentas/${anterior.usuario_id}` });
          if (anterior.usuario !== cuenta.usuario) operaciones.push({ tipo: 'delete', ruta: `nombres/${anterior.usuario}` });
        }
        operaciones.push(
          { tipo: 'set', ruta: `cuentas/${uid}`, datos: { personal_id: anterior.id, usuario: cuenta.usuario, rol: cuenta.rol } },
          { tipo: 'set', ruta: `nombres/${cuenta.usuario}`, datos: { uid, email } },
        );
      } else {
        const nombreAnterior = await fb.db.leer(`nombres/${anterior.usuario}`);
        operaciones.push({ tipo: 'update', ruta: `cuentas/${anterior.usuario_id}`, datos: { usuario: cuenta.usuario, rol: cuenta.rol } });
        if (anterior.usuario !== cuenta.usuario) {
          operaciones.push(
            { tipo: 'delete', ruta: `nombres/${anterior.usuario}` },
            { tipo: 'set', ruta: `nombres/${cuenta.usuario}`, datos: { uid: anterior.usuario_id, email: nombreAnterior ? nombreAnterior.email : '' } },
          );
        }
      }
    }
    await fb.db.escribir(operaciones);
    return { ok: true };
  });

  ruta('DELETE', '/api/personal/:id', 'admin', async ({ params, yo }) => {
    const persona = personaPorId(params.id);
    if (persona.id === yo.personal_id) throw new ErrorApi(409, 'No puede eliminarse a sí mismo. Pídale a otro administrador que lo haga.');
    const n = trabajosDe(persona.id);
    if (n > 0) {
      throw new ErrorApi(
        409,
        `${persona.nombre} aparece en ${n} ${n === 1 ? 'mantenimiento' : 'mantenimientos'}. ` +
          'Para conservar ese historial, desactive a la persona en lugar de eliminarla.',
      );
    }
    const operaciones = [{ tipo: 'delete', ruta: `personal/${persona.id}` }];
    if (persona.usuario_id) {
      operaciones.push({ tipo: 'delete', ruta: `cuentas/${persona.usuario_id}` }, { tipo: 'delete', ruta: `nombres/${persona.usuario}` });
    }
    await fb.db.escribir(operaciones);
    return { ok: true };
  });

  // ----- Equipos y piezas -----

  function equipoPorId(id) {
    const equipo = cache.equipos.get(id);
    if (!equipo) throw new ErrorApi(404, 'Ese equipo ya no existe.');
    return { id, nombre: equipo.nombre, ubicacion_tecnica: equipo.ubicacion_tecnica, notas: equipo.notas || '', creado_en: equipo.creado_en };
  }

  function leerEquipo(cuerpo) {
    return {
      nombre: texto(cuerpo.nombre, 'nombre del equipo'),
      ubicacion_tecnica: texto(cuerpo.ubicacion_tecnica, 'ubicación técnica', { max: 60 }),
      notas: texto(cuerpo.notas, 'notas', { max: 1000, requerido: false }),
    };
  }

  function leerPieza(cuerpo) {
    return {
      nombre: texto(cuerpo.nombre, 'nombre de la pieza'),
      codigo: texto(cuerpo.codigo, 'código o número de parte', { max: 60, requerido: false }),
      cantidad: entero(cuerpo.cantidad === undefined || cuerpo.cantidad === '' ? 1 : cuerpo.cantidad, 'cantidad', { max: 100000 }),
      notas: texto(cuerpo.notas, 'notas', { max: 500, requerido: false }),
    };
  }

  function piezasDe(equipoId) {
    return [...cache.piezas.entries()]
      .filter(([, p]) => p.equipo_id === equipoId)
      .map(([id, p]) => ({ id, nombre: p.nombre, codigo: p.codigo || '', cantidad: p.cantidad, notas: p.notas || '' }))
      .sort((a, b) => ordenTexto(a.nombre, b.nombre));
  }

  function mantenimientosDe(equipoId) {
    return [...cache.mantenimientos.entries()].filter(([, m]) => m.equipo_id === equipoId);
  }

  ruta('GET', '/api/equipos', 'sesion', () =>
    [...cache.equipos.keys()]
      .map((id) => {
        const trabajos = mantenimientosDe(id);
        return { ...equipoPorId(id), piezas: piezasDe(id).length, mantenimientos: trabajos.length, abiertos: trabajos.filter(([, m]) => m.estado !== 'terminado').length };
      })
      .sort((a, b) => ordenTexto(a.nombre, b.nombre)),
  );

  ruta('POST', '/api/equipos', 'admin', async ({ cuerpo }) => {
    const id = fb.nuevoId();
    await fb.db.escribir([{ tipo: 'set', ruta: `equipos/${id}`, datos: { ...leerEquipo(cuerpo), creado_en: ahora() } }]);
    return { id };
  });

  ruta('GET', '/api/equipos/:id', 'sesion', ({ params, yo }) => {
    const equipo = equipoPorId(params.id);
    equipo.piezas = piezasDe(equipo.id);
    equipo.mantenimientos = listarMantenimientos(yo, equipo.id);
    return equipo;
  });

  ruta('PUT', '/api/equipos/:id', 'admin', async ({ cuerpo, params }) => {
    const equipo = equipoPorId(params.id);
    await fb.db.escribir([{ tipo: 'update', ruta: `equipos/${equipo.id}`, datos: leerEquipo(cuerpo) }]);
    return { ok: true };
  });

  // Elimina el equipo junto con sus piezas y su historial de mantenimientos.
  ruta('DELETE', '/api/equipos/:id', 'admin', async ({ params }) => {
    const equipo = equipoPorId(params.id);
    const operaciones = [{ tipo: 'delete', ruta: `equipos/${equipo.id}` }];
    for (const p of piezasDe(equipo.id)) operaciones.push({ tipo: 'delete', ruta: `piezas/${p.id}` });
    for (const [id] of mantenimientosDe(equipo.id)) operaciones.push({ tipo: 'delete', ruta: `mantenimientos/${id}` });
    await fb.db.escribir(operaciones);
    return { ok: true };
  });

  ruta('POST', '/api/equipos/:id/piezas', 'admin', async ({ cuerpo, params }) => {
    const equipo = equipoPorId(params.id);
    const id = fb.nuevoId();
    await fb.db.escribir([{ tipo: 'set', ruta: `piezas/${id}`, datos: { equipo_id: equipo.id, ...leerPieza(cuerpo) } }]);
    return { id };
  });

  function exigirPieza(id) {
    if (!cache.piezas.has(id)) throw new ErrorApi(404, 'Esa pieza ya no existe.');
  }

  ruta('PUT', '/api/piezas/:id', 'admin', async ({ cuerpo, params }) => {
    exigirPieza(params.id);
    await fb.db.escribir([{ tipo: 'update', ruta: `piezas/${params.id}`, datos: leerPieza(cuerpo) }]);
    return { ok: true };
  });

  // La pieza se quita también de los mantenimientos donde aparecía; esos
  // mantenimientos se conservan.
  ruta('DELETE', '/api/piezas/:id', 'admin', async ({ params }) => {
    exigirPieza(params.id);
    const operaciones = [{ tipo: 'delete', ruta: `piezas/${params.id}` }];
    for (const [id, m] of cache.mantenimientos) {
      if ((m.pieza_ids || []).includes(params.id)) {
        operaciones.push({ tipo: 'update', ruta: `mantenimientos/${id}`, datos: { pieza_ids: m.pieza_ids.filter((p) => p !== params.id) } });
      }
    }
    await fb.db.escribir(operaciones);
    return { ok: true };
  });

  // ----- Mantenimientos -----

  function listarMantenimientos(yo, equipoId = null) {
    const nombreDe = (id) => (id && cache.personal.has(id) ? cache.personal.get(id).nombre : null);
    return [...cache.mantenimientos.entries()]
      .filter(([, m]) => (equipoId ? m.equipo_id === equipoId : true) && cache.equipos.has(m.equipo_id))
      .map(([id, m]) => {
        const equipo = cache.equipos.get(m.equipo_id);
        const personal = (m.personal_ids || [])
          .filter((p) => cache.personal.has(p))
          .map((p) => ({ id: p, nombre: cache.personal.get(p).nombre, puesto: cache.personal.get(p).puesto }))
          .sort((a, b) => ordenTexto(a.nombre, b.nombre));
        const piezas = (m.pieza_ids || [])
          .filter((p) => cache.piezas.has(p))
          .map((p) => ({ id: p, nombre: cache.piezas.get(p).nombre, codigo: cache.piezas.get(p).codigo || '' }))
          .sort((a, b) => ordenTexto(a.nombre, b.nombre));
        return {
          id,
          equipo_id: m.equipo_id,
          tipo: m.tipo,
          trabajo: m.trabajo,
          detalles: m.detalles || '',
          fecha_programada: m.fecha_programada,
          estado: m.estado,
          fecha_terminado: m.fecha_terminado || null,
          observaciones: m.observaciones || '',
          creado_por: m.creado_por || null,
          creado_en: m.creado_en || '',
          equipo_nombre: equipo.nombre,
          ubicacion_tecnica: equipo.ubicacion_tecnica,
          creado_por_nombre: nombreDe(m.creado_por),
          terminado_por_nombre: nombreDe(m.terminado_por),
          personal,
          piezas,
          puede_editar: yo.rol === 'admin' || m.creado_por === yo.personal_id,
        };
      })
      .sort((a, b) => a.fecha_programada.localeCompare(b.fecha_programada) || a.creado_en.localeCompare(b.creado_en));
  }

  function mantenimientoPorId(id) {
    const m = cache.mantenimientos.get(id);
    if (!m) throw new ErrorApi(404, 'Ese mantenimiento ya no existe.');
    return { id, ...m };
  }

  function leerMantenimiento(cuerpo, anterior = null) {
    if (typeof cuerpo.equipo_id !== 'string' || !cache.equipos.has(cuerpo.equipo_id)) throw new ErrorApi(400, 'Elija un equipo de la lista.');
    const datos = {
      equipo_id: cuerpo.equipo_id,
      tipo: opcion(cuerpo.tipo, TIPOS, 'tipo de mantenimiento'),
      trabajo: texto(cuerpo.trabajo, 'trabajo a realizar', { max: 160 }),
      detalles: texto(cuerpo.detalles, 'detalles', { max: 2000, requerido: false }),
      fecha_programada: fecha(cuerpo.fecha_programada, 'fecha programada'),
      personal_ids: listaIds(cuerpo.personal_ids, 'personal asignado'),
      pieza_ids: listaIds(cuerpo.pieza_ids, 'piezas'),
    };
    const yaAsignados = new Set(anterior ? anterior.personal_ids || [] : []);
    for (const id of datos.personal_ids) {
      const persona = cache.personal.get(id);
      if (!persona) throw new ErrorApi(400, 'Una de las personas asignadas ya no existe.');
      if (!persona.activo && !yaAsignados.has(id)) throw new ErrorApi(400, 'No se puede asignar a una persona desactivada.');
    }
    for (const id of datos.pieza_ids) {
      const pieza = cache.piezas.get(id);
      if (!pieza || pieza.equipo_id !== datos.equipo_id) throw new ErrorApi(400, 'Una de las piezas elegidas no pertenece a ese equipo.');
    }
    return datos;
  }

  ruta('GET', '/api/mantenimientos', 'sesion', ({ yo }) => listarMantenimientos(yo));

  ruta('POST', '/api/mantenimientos', 'sesion', async ({ cuerpo, yo }) => {
    const datos = leerMantenimiento(cuerpo);
    const id = fb.nuevoId();
    await fb.db.escribir([
      {
        tipo: 'set',
        ruta: `mantenimientos/${id}`,
        datos: { ...datos, estado: 'pendiente', fecha_terminado: null, observaciones: '', creado_por: yo.personal_id, terminado_por: null, creado_en: ahora() },
      },
    ]);
    return { id };
  });

  ruta('PUT', '/api/mantenimientos/:id', 'sesion', async ({ cuerpo, params, yo }) => {
    const anterior = mantenimientoPorId(params.id);
    if (yo.rol !== 'admin' && anterior.creado_por !== yo.personal_id) {
      throw new ErrorApi(403, 'Solo un administrador o quien programó este mantenimiento puede modificarlo.');
    }
    await fb.db.escribir([{ tipo: 'update', ruta: `mantenimientos/${anterior.id}`, datos: leerMantenimiento(cuerpo, anterior) }]);
    return { ok: true };
  });

  // Cualquier persona con usuario puede avanzar un trabajo: iniciarlo, terminarlo
  // o reabrirlo. Queda registrado quién lo terminó y en qué fecha.
  ruta('POST', '/api/mantenimientos/:id/estado', 'sesion', async ({ cuerpo, params, yo }) => {
    const anterior = mantenimientoPorId(params.id);
    const estado = opcion(cuerpo.estado, ESTADOS, 'estado');
    const terminado = estado === 'terminado';
    const datos = { estado, fecha_terminado: terminado ? hoyLocal() : null, terminado_por: terminado ? yo.personal_id : null };
    if (cuerpo.observaciones !== undefined) datos.observaciones = texto(cuerpo.observaciones, 'observaciones', { max: 2000, requerido: false });
    await fb.db.escribir([{ tipo: 'update', ruta: `mantenimientos/${anterior.id}`, datos }]);
    return { ok: true };
  });

  ruta('DELETE', '/api/mantenimientos/:id', 'admin', async ({ params }) => {
    const anterior = mantenimientoPorId(params.id);
    await fb.db.escribir([{ tipo: 'delete', ruta: `mantenimientos/${anterior.id}` }]);
    return { ok: true };
  });

  // ----- Fondo de pantalla -----

  ruta('PUT', '/api/fondo', 'admin', async ({ cuerpo }) => {
    const nombre = opcion(cuerpo.fondo, ['ninguno', 'propio', ...FONDOS_INCLUIDOS], 'fondo');
    if (nombre === 'propio' && !(await fb.db.leer('ajustes/fondo_propio'))) {
      throw new ErrorApi(400, 'Primero suba una imagen para usarla como fondo.');
    }
    await fb.db.escribir([{ tipo: 'set', ruta: 'ajustes/fondo', datos: { nombre } }]);
    return fondoActual();
  });

  // Recibe la imagen ya reducida por el navegador, como texto "data:image/jpeg;base64,...".
  ruta('POST', '/api/fondo/imagen', 'admin', async ({ cuerpo }) => {
    const imagen = cuerpo.imagen;
    if (typeof imagen !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(imagen)) {
      throw new ErrorApi(400, 'El archivo no es una imagen JPG, PNG o WebP.');
    }
    if (imagen.length > TAMANO_MAXIMO_IMAGEN) throw new ErrorApi(413, 'La imagen es demasiado grande, incluso reducida. Pruebe con otra.');
    await fb.db.escribir([
      { tipo: 'set', ruta: 'ajustes/fondo_propio', datos: { imagen, subida_en: ahora() } },
      { tipo: 'set', ruta: 'ajustes/fondo', datos: { nombre: 'propio' } },
    ]);
    return fondoActual();
  });

  // ----- Respaldo -----

  // Copia de todo lo guardado, para descargarla como archivo.
  ruta('GET', '/api/respaldo', 'admin', () => {
    const coleccion = (nombre) => [...cache[nombre].entries()].map(([id, d]) => ({ id, ...d }));
    return {
      sistema: PLANTA,
      creado_en: ahora(),
      personal: coleccion('personal'),
      usuarios: coleccion('cuentas').map(({ id, ...c }) => ({ ...c })),
      equipos: coleccion('equipos'),
      piezas: coleccion('piezas'),
      mantenimientos: coleccion('mantenimientos'),
    };
  });

  return { api, iniciar };
}
