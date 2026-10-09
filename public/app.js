'use strict';

// Interfaz del sistema de mantenimiento. JavaScript puro, sin bibliotecas.
// Todo el contenido se arma con h(), que inserta el texto como texto (nunca
// como HTML), así lo que escriba un usuario no puede alterar la página.

const PUESTOS = {
  mecanico: 'Mecánico',
  soldador: 'Soldador',
  electricista: 'Electricista',
  supervisor: 'Supervisor',
  otro: 'Otro puesto',
};
const TIPOS = { preventivo: 'Preventivo', correctivo: 'Correctivo' };
const ESTADOS = { pendiente: 'Pendiente', en_proceso: 'En proceso', terminado: 'Terminado' };
const CONTRASENA_MINIMA = 8;

const $app = document.getElementById('app');
let planta = 'PLANTA GRANULADORA EL PILAR';
let yo = null;
let serie = 0;
const filtros = { estado: 'abiertos', texto: '', equipos: '' };

// ---------- Utilidades ----------

function h(etiqueta, atributos, ...hijos) {
  const el = document.createElement(etiqueta);
  for (const [clave, valor] of Object.entries(atributos || {})) {
    if (valor === false || valor === null || valor === undefined) continue;
    if (clave.startsWith('on')) el.addEventListener(clave.slice(2), valor);
    else if (clave === 'class') el.className = valor;
    else if (clave in el && !clave.startsWith('aria')) el[clave] = valor;
    else el.setAttribute(clave, valor === true ? '' : valor);
  }
  for (const hijo of hijos.flat(Infinity)) {
    if (hijo === null || hijo === undefined || hijo === false || hijo === '') continue;
    el.append(hijo.nodeType ? hijo : String(hijo));
  }
  return el;
}

async function api(metodo, ruta, cuerpo) {
  let respuesta;
  try {
    respuesta = await fetch(ruta, {
      method: metodo,
      credentials: 'same-origin',
      headers: metodo === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: metodo === 'GET' ? undefined : JSON.stringify(cuerpo || {}),
    });
  } catch {
    throw new Error('No hay conexión con el servidor. Revise que el sistema esté encendido y vuelva a intentar.');
  }
  let datos = null;
  try {
    datos = await respuesta.json();
  } catch {
    /* respuesta sin JSON */
  }
  if (!respuesta.ok) {
    const error = new Error((datos && datos.error) || 'Ocurrió un error. Intente de nuevo.');
    error.estado = respuesta.status;
    if (respuesta.status === 401 && yo) {
      yo = null;
      document.querySelectorAll('dialog').forEach((d) => d.close());
      pantallaEntrar(error.message);
    }
    throw error;
  }
  return datos;
}

function dos(n) {
  return String(n).padStart(2, '0');
}

function aTexto(fecha) {
  return `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())}`;
}

function aFecha(texto) {
  const [anio, mes, dia] = texto.split('-').map(Number);
  return new Date(anio, mes - 1, dia);
}

function hoy() {
  return aTexto(new Date());
}

function sumarDias(texto, dias) {
  const fecha = aFecha(texto);
  fecha.setDate(fecha.getDate() + dias);
  return aTexto(fecha);
}

const formatoLargo = new Intl.DateTimeFormat('es-GT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const formatoCorto = new Intl.DateTimeFormat('es-GT', { day: 'numeric', month: 'long', year: 'numeric' });
const formatoMes = new Intl.DateTimeFormat('es-GT', { month: 'short' });

function plural(n, uno, varios) {
  return `${n} ${n === 1 ? uno : varios}`;
}

function sinTildes(texto) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function coincide(busqueda, ...textos) {
  const palabras = sinTildes(busqueda).split(/\s+/).filter(Boolean);
  const todo = sinTildes(textos.join(' '));
  return palabras.every((p) => todo.includes(p));
}

let relojAviso = 0;
function avisar(mensaje, fallo = false) {
  document.querySelectorAll('.aviso').forEach((a) => a.remove());
  const aviso = h('div', { class: fallo ? 'aviso fallo' : 'aviso', role: fallo ? 'alert' : 'status' }, mensaje);
  // Dentro de un diálogo abierto el aviso debe ir en el propio diálogo para verse.
  (document.querySelector('dialog[open]') || document.body).append(aviso);
  clearTimeout(relojAviso);
  relojAviso = setTimeout(() => aviso.remove(), fallo ? 6000 : 3500);
}

function boton(texto, accion, clase = '') {
  return h('button', { type: 'button', class: `boton ${clase}`.trim(), onclick: accion }, texto);
}

function etiqueta(ubicacion) {
  return h('span', { class: 'etiqueta', title: 'Ubicación técnica' }, ubicacion);
}

function campo(rotulo, control, ayuda) {
  if (!control.id) control.id = `campo-${(serie += 1)}`;
  const partes = [h('label', { htmlFor: control.id }, rotulo), control];
  if (ayuda) {
    const nota = h('p', { class: 'ayuda', id: `${control.id}-ayuda` }, ayuda);
    control.setAttribute('aria-describedby', nota.id);
    partes.push(nota);
  }
  return h('div', { class: 'campo' }, partes);
}

function selector(opciones, valor) {
  const select = h(
    'select',
    {},
    opciones.map(([v, texto]) => h('option', { value: String(v) }, texto)),
  );
  select.value = String(valor);
  return select;
}

function casilla(texto, { marcada = false, valor = '', nota = '', tipo = 'checkbox', nombre = '' } = {}) {
  const control = h('input', { type: tipo, name: nombre, value: String(valor), checked: marcada });
  return h('label', { class: 'opcion' }, control, h('span', {}, texto, nota && h('small', {}, nota)));
}

// ---------- Diálogos ----------

// Abre un formulario en un diálogo. guardar() recibe el botón que se presionó;
// si lanza un error, el mensaje se muestra dentro del diálogo y no se cierra.
// Si devuelve 'seguir', el diálogo queda abierto para cargar otro registro.
function abrirFormulario({ titulo, cuerpo, textoGuardar, guardar, claseGuardar = '', otroBoton = null }) {
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const principal = h('button', { type: 'submit', class: `boton ${claseGuardar}`.trim(), value: 'guardar' }, textoGuardar);
  const extra = otroBoton
    ? h('button', { type: 'submit', class: 'boton secundario', value: 'otro' }, otroBoton)
    : null;
  const formulario = h(
    'form',
    { method: 'dialog', noValidate: true },
    h('div', { class: 'dialogo-titulo' }, h('h2', {}, titulo)),
    h('div', { class: 'dialogo-cuerpo' }, cuerpo, error),
    // El botón principal va primero en el documento para que la tecla Enter lo use;
    // el orden visual lo pone la hoja de estilos.
    h('div', { class: 'dialogo-pie' }, principal, extra, boton('Cancelar', () => dialogo.close(), 'texto')),
  );
  const dialogo = h('dialog', {}, formulario);

  formulario.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    error.hidden = true;
    const botones = [principal, extra].filter(Boolean);
    botones.forEach((b) => (b.disabled = true));
    try {
      const resultado = await guardar(evento.submitter || principal);
      if (resultado !== 'seguir') dialogo.close();
    } catch (fallo) {
      if (!dialogo.open) return;
      error.textContent = fallo.message;
      error.hidden = false;
      error.scrollIntoView({ block: 'nearest' });
    } finally {
      botones.forEach((b) => (b.disabled = false));
    }
  });
  dialogo.addEventListener('close', () => dialogo.remove());
  document.body.append(dialogo);
  dialogo.showModal();
  return dialogo;
}

function confirmar({ titulo, mensaje, textoAccion, accion }) {
  abrirFormulario({
    titulo,
    cuerpo: h('p', {}, mensaje),
    textoGuardar: textoAccion,
    claseGuardar: 'peligro-lleno',
    guardar: accion,
  });
}

// ---------- Acceso ----------

function pantallaAcceso({ titulo, ayuda, nota, campos, textoBoton, enviar }) {
  document.body.className = 'acceso';
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const entrar = h('button', { type: 'submit', class: 'boton' }, textoBoton);
  const formulario = h(
    'form',
    { class: 'acceso-form', noValidate: true },
    h('h1', {}, titulo),
    ayuda && h('p', { class: 'ayuda' }, ayuda),
    nota && h('p', { class: 'nota', role: 'status' }, nota),
    campos,
    error,
    entrar,
  );
  formulario.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    error.hidden = true;
    entrar.disabled = true;
    try {
      await enviar();
    } catch (fallo) {
      error.textContent = fallo.message;
      error.hidden = false;
    } finally {
      entrar.disabled = false;
    }
  });
  $app.replaceChildren(
    h(
      'div',
      { class: 'acceso-panel' },
      h('div', { class: 'acceso-marca' }, h('span', { class: 'marca-planta' }, planta), h('span', { class: 'marca-sistema' }, 'Sistema de mantenimiento')),
      formulario,
    ),
  );
  formulario.querySelector('input').focus();
}

function pantallaEntrar(nota = '') {
  const usuario = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: false });
  const contrasena = h('input', { type: 'password', autocomplete: 'current-password' });
  pantallaAcceso({
    titulo: 'Entrar al sistema',
    nota,
    campos: [campo('Usuario', usuario), campo('Contraseña', contrasena)],
    textoBoton: 'Entrar',
    enviar: async () => {
      if (!usuario.value.trim() || !contrasena.value) throw new Error('Escriba su usuario y su contraseña.');
      const datos = await api('POST', '/api/entrar', { usuario: usuario.value, contrasena: contrasena.value });
      yo = datos.usuario;
      armarMarco();
      if (location.hash === '#/inicio') navegar();
      else location.hash = '#/inicio';
    },
  });
}

function pantallaConfigurar() {
  const nombre = h('input', { type: 'text', autocomplete: 'name', maxLength: 120 });
  const usuario = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, maxLength: 30 });
  const contrasena = h('input', { type: 'password', autocomplete: 'new-password' });
  const repetir = h('input', { type: 'password', autocomplete: 'new-password' });
  pantallaAcceso({
    titulo: 'Crear al administrador',
    ayuda:
      'Es la primera vez que se abre el sistema. Cree aquí la cuenta del administrador: ' +
      'la persona que registrará los equipos, el personal y sus usuarios.',
    campos: [
      campo('Nombre completo', nombre),
      campo('Usuario', usuario, 'Con este nombre entrará al sistema. Por ejemplo: mchavez'),
      campo('Contraseña', contrasena, `Al menos ${CONTRASENA_MINIMA} caracteres.`),
      campo('Repita la contraseña', repetir),
    ],
    textoBoton: 'Crear administrador y entrar',
    enviar: async () => {
      if (contrasena.value !== repetir.value) throw new Error('Las dos contraseñas no son iguales. Escríbalas de nuevo.');
      const datos = await api('POST', '/api/configurar', {
        nombre: nombre.value,
        usuario: usuario.value,
        contrasena: contrasena.value,
      });
      yo = datos.usuario;
      armarMarco();
      if (location.hash === '#/inicio') navegar();
      else location.hash = '#/inicio';
    },
  });
}

async function salir() {
  try {
    await api('POST', '/api/salir');
  } catch {
    /* aunque falle la conexión, se cierra la pantalla */
  }
  yo = null;
  pantallaEntrar();
}

// ---------- Marco y navegación ----------

const SECCIONES = [
  ['#/inicio', 'Inicio'],
  ['#/mantenimientos', 'Mantenimientos'],
  ['#/equipos', 'Equipos'],
  ['#/personal', 'Personal', 'admin'],
  ['#/cuenta', 'Mi cuenta'],
];

function armarMarco() {
  rutaMostrada = '';
  document.body.className = 'con-marco';
  $app.replaceChildren(
    h(
      'header',
      { class: 'barra' },
      h('a', { class: 'marca', href: '#/inicio' }, h('span', { class: 'marca-planta' }, planta), h('span', { class: 'marca-sistema' }, 'Sistema de mantenimiento')),
      h(
        'nav',
        { 'aria-label': 'Secciones' },
        SECCIONES.filter(([, , permiso]) => !permiso || yo.rol === permiso).map(([ruta, texto]) => h('a', { href: ruta }, texto)),
      ),
      h(
        'div',
        { class: 'barra-usuario' },
        h('span', { class: 'nombre' }, yo.nombre),
        h('span', { class: 'puesto' }, yo.rol === 'admin' ? `${PUESTOS[yo.puesto]}, administrador` : PUESTOS[yo.puesto]),
        boton('Salir', salir, 'texto salir'),
      ),
    ),
    h('main', { id: 'principal', tabIndex: -1 }, h('p', { class: 'cargando' }, 'Cargando…')),
  );
}

const RUTAS = [
  [/^#\/inicio$/, vistaInicio],
  [/^#\/mantenimientos$/, vistaMantenimientos],
  [/^#\/equipos$/, vistaEquipos],
  [/^#\/equipos\/(\d+)$/, vistaEquipo],
  [/^#\/personal$/, vistaPersonal],
  [/^#\/cuenta$/, vistaCuenta],
];

let turno = 0;
let rutaMostrada = '';

// Dibuja la vista que corresponde a la dirección actual. También se usa para
// volver a cargar los datos después de guardar un cambio.
async function navegar() {
  if (!yo) return;
  const principal = document.getElementById('principal');
  if (!principal) return;
  const encontrada = RUTAS.map(([expresion, vista]) => [expresion.exec(location.hash), vista]).find(([m]) => m);
  if (!encontrada) {
    location.hash = '#/inicio';
    return;
  }
  const [coincidencia, vista] = encontrada;
  const miTurno = (turno += 1);
  const cambioDeVista = rutaMostrada !== location.hash;

  const seccion = `#/${location.hash.split('/')[1]}`;
  document.querySelectorAll('.barra nav a').forEach((enlace) => {
    if (enlace.getAttribute('href') === seccion) enlace.setAttribute('aria-current', 'page');
    else enlace.removeAttribute('aria-current');
  });

  try {
    const contenido = await vista(...coincidencia.slice(1));
    if (miTurno !== turno || !yo) return;
    principal.replaceChildren(...[contenido].flat().filter(Boolean));
  } catch (fallo) {
    if (miTurno !== turno || !yo) return;
    principal.replaceChildren(
      h('h1', {}, 'No se pudo cargar esta página'),
      h('p', { class: 'error' }, fallo.message),
      fallo.estado === 404 ? h('a', { class: 'boton', href: '#/inicio' }, 'Ir al inicio') : boton('Volver a intentar', navegar),
    );
  }
  if (cambioDeVista) {
    rutaMostrada = location.hash;
    window.scrollTo(0, 0);
    principal.focus({ preventScroll: true });
  }
}

window.addEventListener('hashchange', navegar);

// ---------- Mantenimientos: piezas comunes ----------

function estaAtrasado(m) {
  return m.estado !== 'terminado' && m.fecha_programada < hoy();
}

function tarjetaTrabajo(m, { conEquipo = true, nivel = 'h3' } = {}) {
  const fecha = aFecha(m.fecha_programada);
  const abierto = m.estado !== 'terminado';
  const atrasado = estaAtrasado(m);
  const otroAnio = fecha.getFullYear() !== new Date().getFullYear();

  const principales = [];
  if (m.estado === 'pendiente') principales.push(boton('Iniciar trabajo', () => cambiarEstado(m, 'en_proceso', 'Trabajo iniciado'), 'secundario'));
  if (abierto) principales.push(boton('Terminar trabajo', () => terminarTrabajo(m)));
  const menores = [];
  if (!abierto) menores.push(boton('Reabrir', () => cambiarEstado(m, 'pendiente', 'Trabajo reabierto'), 'texto'));
  if (m.puede_editar) menores.push(boton('Editar', () => formularioTrabajo({ trabajo: m }), 'texto'));
  if (yo.rol === 'admin') menores.push(boton('Eliminar', () => eliminarTrabajo(m), 'texto peligro'));

  const dato = (rotulo, valor) => h('p', { class: 'dato' }, h('b', {}, `${rotulo}: `), valor);

  return h(
    'li',
    { class: atrasado ? 'fila trabajo atrasado' : 'fila trabajo' },
    h(
      'div',
      { class: 'trabajo-fecha' },
      h('span', { class: 'dia' }, fecha.getDate()),
      h('span', { class: 'mes' }, formatoMes.format(fecha).replace('.', '') + (otroAnio ? ` ${fecha.getFullYear()}` : '')),
      atrasado && h('span', { class: 'atraso' }, 'Atrasado'),
    ),
    h(
      'div',
      { class: 'trabajo-cuerpo' },
      h(nivel, { class: 'titulo' }, m.trabajo),
      conEquipo && h('p', { class: 'trabajo-equipo' }, h('a', { href: `#/equipos/${m.equipo_id}` }, m.equipo_nombre), etiqueta(m.ubicacion_tecnica)),
      h('p', { class: 'trabajo-datos' }, h('span', { class: `estado ${m.estado}` }, ESTADOS[m.estado]), h('span', {}, `Mantenimiento ${TIPOS[m.tipo].toLowerCase()}`)),
      m.detalles && h('p', { class: 'trabajo-texto' }, m.detalles),
      dato('Personal asignado', m.personal.length ? m.personal.map((p) => p.nombre).join(', ') : 'nadie todavía'),
      m.piezas.length > 0 && dato('Piezas', m.piezas.map((p) => (p.codigo ? `${p.nombre} (${p.codigo})` : p.nombre)).join(', ')),
      !abierto && dato('Terminado', formatoCorto.format(aFecha(m.fecha_terminado)) + (m.terminado_por_nombre ? `, por ${m.terminado_por_nombre}` : '')),
      m.observaciones && dato('Observaciones', m.observaciones),
    ),
    (principales.length > 0 || menores.length > 0) &&
      h('div', { class: 'trabajo-acciones' }, principales, menores.length > 0 && h('div', { class: 'menores' }, menores)),
  );
}

async function cambiarEstado(m, estado, mensaje) {
  try {
    await api('POST', `/api/mantenimientos/${m.id}/estado`, { estado });
    avisar(mensaje);
    navegar();
  } catch (fallo) {
    if (yo) avisar(fallo.message, true);
  }
}

function terminarTrabajo(m) {
  const observaciones = h('textarea', { maxLength: 2000, value: m.observaciones || '' });
  abrirFormulario({
    titulo: 'Terminar trabajo',
    cuerpo: [
      h('p', {}, `${m.trabajo}, en ${m.equipo_nombre}.`),
      campo('Observaciones', observaciones, 'Opcional. Anote qué se hizo, qué se cambió o qué quedó pendiente.'),
    ],
    textoGuardar: 'Terminar trabajo',
    guardar: async () => {
      await api('POST', `/api/mantenimientos/${m.id}/estado`, { estado: 'terminado', observaciones: observaciones.value });
      avisar('Trabajo terminado');
      navegar();
    },
  });
}

function eliminarTrabajo(m) {
  confirmar({
    titulo: 'Eliminar mantenimiento',
    mensaje: `Se eliminará «${m.trabajo}» de ${m.equipo_nombre}. Esto no se puede deshacer.`,
    textoAccion: 'Eliminar mantenimiento',
    accion: async () => {
      await api('DELETE', `/api/mantenimientos/${m.id}`);
      avisar('Mantenimiento eliminado');
      navegar();
    },
  });
}

// Formulario para programar o editar un mantenimiento.
async function formularioTrabajo({ trabajo = null, equipoId = null } = {}) {
  let equipos;
  let personal;
  try {
    [equipos, personal] = await Promise.all([api('GET', '/api/equipos'), api('GET', '/api/personal')]);
  } catch (fallo) {
    if (yo) avisar(fallo.message, true);
    return;
  }
  if (equipos.length === 0) {
    avisar(
      yo.rol === 'admin'
        ? 'Primero registre un equipo en la sección Equipos.'
        : 'Todavía no hay equipos registrados. Pídale al administrador que los agregue.',
      true,
    );
    return;
  }

  const asignados = new Set(trabajo ? trabajo.personal.map((p) => p.id) : []);
  const piezasMarcadas = new Set(trabajo ? trabajo.piezas.map((p) => p.id) : []);
  const equipoInicial = trabajo ? trabajo.equipo_id : equipoId || '';

  const equipo = selector(
    [['', 'Elija un equipo…'], ...equipos.map((e) => [e.id, `${e.nombre} (${e.ubicacion_tecnica})`])],
    equipoInicial,
  );
  const tipoActual = trabajo ? trabajo.tipo : 'preventivo';
  const tipos = h(
    'div',
    { class: 'en-linea' },
    casilla('Preventivo', { tipo: 'radio', nombre: 'tipo', valor: 'preventivo', marcada: tipoActual === 'preventivo' }),
    casilla('Correctivo', { tipo: 'radio', nombre: 'tipo', valor: 'correctivo', marcada: tipoActual === 'correctivo' }),
  );
  const descripcion = h('input', { type: 'text', maxLength: 160, value: trabajo ? trabajo.trabajo : '' });
  const fecha = h('input', { type: 'date', class: 'corto', value: trabajo ? trabajo.fecha_programada : hoy() });
  const detalles = h('textarea', { maxLength: 2000, value: trabajo ? trabajo.detalles : '' });

  const disponibles = personal.filter((p) => p.activo || asignados.has(p.id));
  const cajaPersonal = h(
    'div',
    { class: 'opciones' },
    disponibles.length
      ? disponibles.map((p) => casilla(p.nombre, { nombre: 'personal', valor: p.id, marcada: asignados.has(p.id), nota: PUESTOS[p.puesto] + (p.activo ? '' : ', desactivado') }))
      : h('p', { class: 'opciones-vacias' }, 'Todavía no hay personal registrado.'),
  );

  const cajaPiezas = h('div', { class: 'opciones' });
  let pedido = 0;
  async function cargarPiezas() {
    const miPedido = (pedido += 1);
    if (!equipo.value) {
      cajaPiezas.replaceChildren(h('p', { class: 'opciones-vacias' }, 'Elija primero el equipo.'));
      return;
    }
    cajaPiezas.replaceChildren(h('p', { class: 'opciones-vacias' }, 'Cargando piezas…'));
    try {
      const datos = await api('GET', `/api/equipos/${equipo.value}`);
      if (miPedido !== pedido) return;
      cajaPiezas.replaceChildren(
        ...(datos.piezas.length
          ? datos.piezas.map((p) => casilla(p.nombre, { nombre: 'pieza', valor: p.id, marcada: piezasMarcadas.has(p.id), nota: p.codigo }))
          : [h('p', { class: 'opciones-vacias' }, 'Este equipo no tiene piezas registradas.')]),
      );
    } catch (fallo) {
      if (miPedido === pedido) cajaPiezas.replaceChildren(h('p', { class: 'opciones-vacias' }, fallo.message));
    }
  }
  equipo.addEventListener('change', () => {
    piezasMarcadas.clear();
    cargarPiezas();
  });
  cargarPiezas();

  const marcados = (caja, nombre) => [...caja.querySelectorAll(`input[name="${nombre}"]:checked`)].map((c) => Number(c.value));

  abrirFormulario({
    titulo: trabajo ? 'Editar mantenimiento' : 'Programar mantenimiento',
    cuerpo: [
      campo('Equipo', equipo),
      h('fieldset', { class: 'grupo' }, h('legend', {}, 'Tipo de mantenimiento'), tipos),
      campo('Trabajo a realizar', descripcion, 'Por ejemplo: cambio de rodamientos, soldadura de aspas, lubricación.'),
      campo('Fecha programada', fecha),
      h('fieldset', { class: 'grupo' }, h('legend', {}, 'Personal asignado'), cajaPersonal),
      h('fieldset', { class: 'grupo' }, h('legend', {}, 'Piezas a trabajar'), cajaPiezas),
      campo('Detalles', detalles, 'Opcional. Instrucciones, herramientas o repuestos necesarios.'),
    ],
    textoGuardar: trabajo ? 'Guardar cambios' : 'Programar mantenimiento',
    guardar: async () => {
      if (!equipo.value) throw new Error('Elija el equipo.');
      if (!descripcion.value.trim()) throw new Error('Escriba el trabajo a realizar.');
      if (!fecha.value) throw new Error('Elija la fecha programada.');
      const datos = {
        equipo_id: Number(equipo.value),
        tipo: tipos.querySelector('input:checked').value,
        trabajo: descripcion.value,
        fecha_programada: fecha.value,
        detalles: detalles.value,
        personal_ids: marcados(cajaPersonal, 'personal'),
        pieza_ids: marcados(cajaPiezas, 'pieza'),
      };
      if (trabajo) await api('PUT', `/api/mantenimientos/${trabajo.id}`, datos);
      else await api('POST', '/api/mantenimientos', datos);
      avisar(trabajo ? 'Cambios guardados' : 'Mantenimiento programado');
      navegar();
    },
  });
}

function listaDeTrabajos(trabajos, opciones) {
  return h('ul', { class: 'lista' }, trabajos.map((m) => tarjetaTrabajo(m, opciones)));
}

// ---------- Inicio ----------

async function vistaInicio() {
  const [trabajos, equipos] = await Promise.all([api('GET', '/api/mantenimientos'), api('GET', '/api/equipos')]);
  const abiertos = trabajos.filter((m) => m.estado !== 'terminado');
  const limite = sumarDias(hoy(), 7);
  const atrasados = abiertos.filter(estaAtrasado);
  const proximos = abiertos.filter((m) => m.fecha_programada >= hoy() && m.fecha_programada <= limite);
  const enProceso = abiertos.filter((m) => m.estado === 'en_proceso');
  const mios = abiertos.filter((m) => m.personal.some((p) => p.id === yo.personal_id));
  const nombreCorto = yo.nombre.split(/\s+/)[0];
  const fechaHoy = formatoLargo.format(new Date());

  const irAMantenimientos = () => {
    filtros.estado = 'abiertos';
    filtros.texto = '';
  };

  const partes = [
    h(
      'div',
      { class: 'encabezado' },
      h('div', {}, h('h1', {}, `Hola, ${nombreCorto}`), h('p', { class: 'subtitulo' }, fechaHoy.charAt(0).toUpperCase() + fechaHoy.slice(1))),
      boton('Programar mantenimiento', () => formularioTrabajo()),
    ),
  ];

  if (equipos.length === 0) {
    partes.push(
      h(
        'div',
        { class: 'vacio' },
        h('strong', {}, 'Todavía no hay equipos registrados'),
        yo.rol === 'admin'
          ? 'Empiece por agregar los equipos de la planta con su ubicación técnica y sus piezas. Después podrá programarles mantenimientos.'
          : 'Cuando el administrador registre los equipos de la planta, aquí verá los mantenimientos programados.',
        yo.rol === 'admin' && h('div', {}, h('a', { class: 'boton', href: '#/equipos' }, 'Ir a Equipos')),
      ),
    );
    return partes;
  }

  partes.push(
    h(
      'div',
      { class: 'resumen' },
      h('a', { href: '#/mantenimientos', class: atrasados.length ? 'alerta' : '', onclick: irAMantenimientos }, h('span', { class: 'numero' }, atrasados.length), h('span', { class: 'rotulo' }, atrasados.length === 1 ? 'Trabajo atrasado' : 'Trabajos atrasados')),
      h('a', { href: '#/mantenimientos', onclick: irAMantenimientos }, h('span', { class: 'numero' }, proximos.length), h('span', { class: 'rotulo' }, 'Para los próximos 7 días')),
      h('a', { href: '#/mantenimientos', onclick: irAMantenimientos }, h('span', { class: 'numero' }, enProceso.length), h('span', { class: 'rotulo' }, 'En proceso ahora')),
    ),
  );

  const seccion = (titulo, lista, vacio) =>
    h('section', { class: 'seccion' }, h('div', { class: 'encabezado' }, h('h2', {}, titulo)), lista.length ? listaDeTrabajos(lista) : h('p', { class: 'vacio' }, vacio));

  if (mios.length > 0 || yo.rol !== 'admin') {
    partes.push(seccion('Asignados a usted', mios, 'No tiene trabajos asignados por ahora.'));
  }
  const mioIds = new Set(mios.map((m) => m.id));
  const atrasadosOtros = atrasados.filter((m) => !mioIds.has(m.id));
  if (atrasadosOtros.length > 0) partes.push(seccion(mios.length ? 'Otros trabajos atrasados' : 'Atrasados', atrasadosOtros, ''));
  partes.push(
    seccion(
      'Próximos 7 días',
      proximos.filter((m) => !mioIds.has(m.id)),
      mios.length ? 'No hay más trabajos programados para esta semana.' : 'No hay trabajos programados para esta semana.',
    ),
  );
  return partes;
}

// ---------- Mantenimientos ----------

async function vistaMantenimientos() {
  const trabajos = await api('GET', '/api/mantenimientos');
  const abiertos = trabajos.filter((m) => m.estado !== 'terminado');
  const terminados = trabajos
    .filter((m) => m.estado === 'terminado')
    .sort((a, b) => (b.fecha_terminado || '').localeCompare(a.fecha_terminado || '') || b.id - a.id);
  const grupos = {
    abiertos: { texto: `Por hacer (${abiertos.length})`, lista: abiertos },
    terminados: { texto: `Terminados (${terminados.length})`, lista: terminados },
    todos: { texto: `Todos (${trabajos.length})`, lista: trabajos },
  };

  const resultados = h('div', {});
  const pestanas = h('div', { class: 'pestanas', role: 'group', 'aria-label': 'Mostrar' });
  const buscar = h('input', { type: 'search', value: filtros.texto, placeholder: 'Trabajo, equipo, ubicación o persona' });

  function pintar() {
    pestanas.replaceChildren(
      ...Object.entries(grupos).map(([clave, grupo]) =>
        h('button', { type: 'button', 'aria-pressed': String(filtros.estado === clave), onclick: () => { filtros.estado = clave; pintar(); } }, grupo.texto),
      ),
    );
    const visibles = grupos[filtros.estado].lista.filter((m) =>
      coincide(filtros.texto, m.trabajo, m.equipo_nombre, m.ubicacion_tecnica, m.detalles, ...m.personal.map((p) => p.nombre)),
    );
    if (visibles.length > 0) {
      resultados.replaceChildren(listaDeTrabajos(visibles, { nivel: 'h2' }));
    } else if (trabajos.length === 0) {
      resultados.replaceChildren(
        h('div', { class: 'vacio' }, h('strong', {}, 'Todavía no hay mantenimientos'), 'Programe el primero: elija el equipo, la fecha y quién lo va a realizar.', h('div', {}, boton('Programar mantenimiento', () => formularioTrabajo()))),
      );
    } else if (filtros.texto.trim()) {
      resultados.replaceChildren(h('p', { class: 'vacio' }, `Ningún mantenimiento coincide con «${filtros.texto.trim()}» en esta lista.`));
    } else {
      resultados.replaceChildren(
        h('p', { class: 'vacio' }, filtros.estado === 'abiertos' ? 'No hay trabajos por hacer. Todo está al día.' : 'Todavía no se ha terminado ningún trabajo.'),
      );
    }
  }
  buscar.addEventListener('input', () => {
    filtros.texto = buscar.value;
    pintar();
  });
  pintar();

  return [
    h('div', { class: 'encabezado' }, h('h1', {}, 'Mantenimientos'), boton('Programar mantenimiento', () => formularioTrabajo())),
    h('div', { class: 'filtros' }, pestanas, campo('Buscar', buscar)),
    resultados,
  ];
}

// ---------- Equipos ----------

function formularioEquipo(equipo = null) {
  const nombre = h('input', { type: 'text', maxLength: 120, value: equipo ? equipo.nombre : '' });
  const ubicacion = h('input', { type: 'text', maxLength: 60, value: equipo ? equipo.ubicacion_tecnica : '', autocapitalize: 'characters', spellcheck: false });
  const notas = h('textarea', { maxLength: 1000, value: equipo ? equipo.notas : '' });
  abrirFormulario({
    titulo: equipo ? 'Editar equipo' : 'Agregar equipo',
    cuerpo: [
      campo('Nombre del equipo', nombre, 'Por ejemplo: Tambor granulador, Secador rotativo, Elevador de cangilones.'),
      campo('Ubicación técnica', ubicacion, 'El código que identifica dónde está instalado el equipo en la planta.'),
      campo('Notas', notas, 'Opcional. Marca, modelo, capacidad, motor u otros datos de placa.'),
    ],
    textoGuardar: equipo ? 'Guardar cambios' : 'Agregar equipo',
    guardar: async () => {
      if (!nombre.value.trim()) throw new Error('Escriba el nombre del equipo.');
      if (!ubicacion.value.trim()) throw new Error('Escriba la ubicación técnica.');
      const datos = { nombre: nombre.value, ubicacion_tecnica: ubicacion.value, notas: notas.value };
      if (equipo) {
        await api('PUT', `/api/equipos/${equipo.id}`, datos);
        avisar('Cambios guardados');
        navegar();
      } else {
        const creado = await api('POST', '/api/equipos', datos);
        avisar('Equipo agregado. Ahora puede registrar sus piezas.');
        location.hash = `#/equipos/${creado.id}`;
      }
    },
  });
}

async function vistaEquipos() {
  const equipos = await api('GET', '/api/equipos');
  const esAdmin = yo.rol === 'admin';
  const resultados = h('div', {});
  const buscar = h('input', { type: 'search', value: filtros.equipos, placeholder: 'Nombre o ubicación técnica' });

  function pintar() {
    const visibles = equipos.filter((e) => coincide(filtros.equipos, e.nombre, e.ubicacion_tecnica, e.notas));
    if (visibles.length > 0) {
      resultados.replaceChildren(
        h(
          'ul',
          { class: 'lista' },
          visibles.map((e) =>
            h(
              'li',
              {},
              h(
                'a',
                { class: 'fila equipo-fila', href: `#/equipos/${e.id}` },
                h('span', {}, h('span', { class: 'nombre' }, e.nombre), etiqueta(e.ubicacion_tecnica)),
                h(
                  'span',
                  { class: 'conteos' },
                  h('span', {}, plural(e.piezas, 'pieza', 'piezas')),
                  e.abiertos > 0 && h('span', { class: 'abiertos' }, plural(e.abiertos, 'trabajo por hacer', 'trabajos por hacer')),
                ),
              ),
            ),
          ),
        ),
      );
    } else if (equipos.length === 0) {
      resultados.replaceChildren(
        h(
          'div',
          { class: 'vacio' },
          h('strong', {}, 'Todavía no hay equipos registrados'),
          esAdmin ? 'Agregue cada equipo de la planta con su nombre y su ubicación técnica. Después podrá registrar sus piezas.' : 'El administrador todavía no ha registrado los equipos de la planta.',
          esAdmin && h('div', {}, boton('Agregar equipo', () => formularioEquipo())),
        ),
      );
    } else {
      resultados.replaceChildren(h('p', { class: 'vacio' }, `Ningún equipo coincide con «${filtros.equipos.trim()}».`));
    }
  }
  buscar.addEventListener('input', () => {
    filtros.equipos = buscar.value;
    pintar();
  });
  pintar();

  return [
    h(
      'div',
      { class: 'encabezado' },
      h('div', {}, h('h1', {}, 'Equipos'), h('p', { class: 'subtitulo' }, equipos.length ? `${plural(equipos.length, 'equipo registrado', 'equipos registrados')} en la planta` : '')),
      esAdmin && boton('Agregar equipo', () => formularioEquipo()),
    ),
    equipos.length > 0 && h('div', { class: 'filtros' }, campo('Buscar', buscar)),
    resultados,
  ];
}

function formularioPieza(equipo, pieza = null) {
  const nombre = h('input', { type: 'text', maxLength: 120, value: pieza ? pieza.nombre : '' });
  const codigo = h('input', { type: 'text', maxLength: 60, value: pieza ? pieza.codigo : '', spellcheck: false });
  const cantidad = h('input', { type: 'number', class: 'corto', min: 1, max: 100000, step: 1, inputMode: 'numeric', value: pieza ? pieza.cantidad : 1 });
  const notas = h('input', { type: 'text', maxLength: 500, value: pieza ? pieza.notas : '' });
  abrirFormulario({
    titulo: pieza ? 'Editar pieza' : `Agregar pieza a ${equipo.nombre}`,
    cuerpo: [
      campo('Nombre de la pieza', nombre, 'Por ejemplo: rodamiento, faja, sello mecánico, reductor.'),
      campo('Código o número de parte', codigo, 'Opcional.'),
      campo('Cantidad instalada en el equipo', cantidad),
      campo('Notas', notas, 'Opcional. Medidas, marca, proveedor o posición en el equipo.'),
    ],
    textoGuardar: pieza ? 'Guardar cambios' : 'Guardar pieza',
    otroBoton: pieza ? null : 'Guardar y agregar otra',
    guardar: async (presionado) => {
      if (!nombre.value.trim()) throw new Error('Escriba el nombre de la pieza.');
      const numero = Number(cantidad.value);
      if (!Number.isInteger(numero) || numero < 1) throw new Error('La cantidad debe ser un número entero, 1 o más.');
      const datos = { nombre: nombre.value, codigo: codigo.value, cantidad: numero, notas: notas.value };
      if (pieza) await api('PUT', `/api/piezas/${pieza.id}`, datos);
      else await api('POST', `/api/equipos/${equipo.id}/piezas`, datos);
      navegar();
      if (presionado.value === 'otro') {
        avisar(`Pieza guardada: ${nombre.value.trim()}`);
        nombre.value = '';
        codigo.value = '';
        cantidad.value = 1;
        notas.value = '';
        nombre.focus();
        return 'seguir';
      }
      avisar(pieza ? 'Cambios guardados' : 'Pieza guardada');
      return undefined;
    },
  });
}

async function vistaEquipo(id) {
  const equipo = await api('GET', `/api/equipos/${id}`);
  const esAdmin = yo.rol === 'admin';

  const eliminarEquipo = () =>
    confirmar({
      titulo: 'Eliminar equipo',
      mensaje:
        `Se eliminará «${equipo.nombre}» junto con ${plural(equipo.piezas.length, 'pieza', 'piezas')} y ` +
        `${plural(equipo.mantenimientos.length, 'mantenimiento registrado', 'mantenimientos registrados')}. Esto no se puede deshacer.`,
      textoAccion: 'Eliminar equipo',
      accion: async () => {
        await api('DELETE', `/api/equipos/${equipo.id}`);
        avisar('Equipo eliminado');
        location.hash = '#/equipos';
      },
    });

  const eliminarPieza = (pieza) =>
    confirmar({
      titulo: 'Eliminar pieza',
      mensaje: `Se eliminará «${pieza.nombre}» de ${equipo.nombre}. Esto no se puede deshacer.`,
      textoAccion: 'Eliminar pieza',
      accion: async () => {
        await api('DELETE', `/api/piezas/${pieza.id}`);
        avisar('Pieza eliminada');
        navegar();
      },
    });

  const piezas = equipo.piezas.length
    ? h(
        'ul',
        { class: 'lista' },
        equipo.piezas.map((p) =>
          h(
            'li',
            { class: 'fila pieza' },
            h('span', { class: 'nombre' }, p.nombre, p.notas && h('span', { class: 'notas' }, p.notas)),
            h('span', { class: p.codigo ? 'codigo' : 'codigo sin-dato' }, p.codigo || 'Sin código'),
            h('span', {}, plural(p.cantidad, 'unidad', 'unidades')),
            esAdmin && h('span', { class: 'acciones' }, boton('Editar', () => formularioPieza(equipo, p), 'texto'), boton('Eliminar', () => eliminarPieza(p), 'texto peligro')),
          ),
        ),
      )
    : h(
        'div',
        { class: 'vacio' },
        h('strong', {}, 'Este equipo no tiene piezas registradas'),
        esAdmin ? 'Agregue las piezas que lleva el equipo: rodamientos, fajas, sellos, motores y demás.' : 'El administrador todavía no ha registrado las piezas de este equipo.',
      );

  const abiertos = equipo.mantenimientos.filter((m) => m.estado !== 'terminado');
  const terminados = equipo.mantenimientos
    .filter((m) => m.estado === 'terminado')
    .sort((a, b) => (b.fecha_terminado || '').localeCompare(a.fecha_terminado || '') || b.id - a.id);
  const historial = [...abiertos, ...terminados];

  return [
    h('a', { class: 'volver', href: '#/equipos' }, 'Volver a Equipos'),
    h(
      'div',
      { class: 'placa' },
      h('h1', {}, equipo.nombre),
      h('p', { class: 'ubicacion' }, 'Ubicación técnica', etiqueta(equipo.ubicacion_tecnica)),
      equipo.notas && h('p', { class: 'notas' }, equipo.notas),
      h(
        'div',
        { class: 'acciones' },
        boton('Programar mantenimiento', () => formularioTrabajo({ equipoId: equipo.id })),
        esAdmin && boton('Editar equipo', () => formularioEquipo(equipo), 'secundario'),
        esAdmin && boton('Eliminar equipo', eliminarEquipo, 'texto peligro'),
      ),
    ),
    h(
      'section',
      { class: 'seccion' },
      h('div', { class: 'encabezado' }, h('h2', {}, equipo.piezas.length ? `Piezas (${equipo.piezas.length})` : 'Piezas'), esAdmin && boton('Agregar pieza', () => formularioPieza(equipo), 'secundario')),
      piezas,
    ),
    h(
      'section',
      { class: 'seccion' },
      h('div', { class: 'encabezado' }, h('h2', {}, 'Mantenimientos de este equipo')),
      historial.length ? listaDeTrabajos(historial, { conEquipo: false }) : h('p', { class: 'vacio' }, 'Este equipo todavía no tiene mantenimientos programados ni realizados.'),
    ),
  ];
}

// ---------- Personal y usuarios ----------

function formularioPersona(persona = null) {
  const tieneUsuario = Boolean(persona && persona.usuario);
  const esYo = Boolean(persona && persona.id === yo.personal_id);

  const nombre = h('input', { type: 'text', maxLength: 120, autocomplete: 'off', value: persona ? persona.nombre : '' });
  const puesto = selector(Object.entries(PUESTOS), persona ? persona.puesto : 'mecanico');
  const activo = casilla('Activo en la planta', { marcada: persona ? Boolean(persona.activo) : true, nota: 'Si lo desmarca, la persona ya no podrá entrar ni recibir trabajos nuevos. Su historial se conserva.' });

  const conUsuario = casilla('Tiene usuario para entrar al sistema', { marcada: persona ? tieneUsuario : true });
  const usuario = h('input', { type: 'text', maxLength: 30, autocomplete: 'off', autocapitalize: 'none', spellcheck: false, value: tieneUsuario ? persona.usuario : '' });
  const contrasena = h('input', { type: 'password', autocomplete: 'new-password' });
  const mostrar = casilla('Mostrar la contraseña');
  mostrar.querySelector('input').addEventListener('change', (evento) => {
    contrasena.type = evento.target.checked ? 'text' : 'password';
  });
  const rolActual = tieneUsuario ? persona.rol : 'tecnico';
  const roles = h(
    'div',
    { class: 'opciones' },
    casilla('Técnico', { tipo: 'radio', nombre: 'rol', valor: 'tecnico', marcada: rolActual === 'tecnico', nota: 'Consulta equipos y piezas; programa, inicia y termina mantenimientos.' }),
    casilla('Administrador', { tipo: 'radio', nombre: 'rol', valor: 'admin', marcada: rolActual === 'admin', nota: 'Además registra equipos, piezas, personal y usuarios.' }),
  );
  const avisoQuitar = h('p', { class: 'nota', hidden: true }, 'Al guardar se eliminará el usuario de esta persona y ya no podrá entrar al sistema.');
  const cuenta = h(
    'div',
    { class: 'subformulario' },
    campo('Usuario', usuario, 'Con este nombre entrará al sistema. Solo letras sin tilde, números, punto o guion.'),
    campo(
      tieneUsuario ? 'Nueva contraseña' : 'Contraseña',
      contrasena,
      tieneUsuario ? `Déjela en blanco para conservar la contraseña actual. Si la cambia: al menos ${CONTRASENA_MINIMA} caracteres.` : `Al menos ${CONTRASENA_MINIMA} caracteres. Entréguesela a la persona; después puede cambiarla en Mi cuenta.`,
    ),
    h('div', { class: 'campo en-linea' }, mostrar),
    h('fieldset', { class: 'grupo' }, h('legend', {}, 'Tipo de acceso'), roles),
  );
  const casillaUsuario = conUsuario.querySelector('input');
  const alternar = () => {
    cuenta.hidden = !casillaUsuario.checked;
    avisoQuitar.hidden = casillaUsuario.checked || !tieneUsuario;
  };
  casillaUsuario.addEventListener('change', alternar);
  alternar();

  abrirFormulario({
    titulo: persona ? `Editar a ${persona.nombre}` : 'Agregar persona',
    cuerpo: [
      campo('Nombre completo', nombre),
      campo('Puesto', puesto),
      persona && !esYo && h('div', { class: 'campo' }, activo),
      h('div', { class: 'campo' }, conUsuario),
      cuenta,
      avisoQuitar,
    ],
    textoGuardar: persona ? 'Guardar cambios' : 'Agregar persona',
    guardar: async () => {
      if (!nombre.value.trim()) throw new Error('Escriba el nombre completo.');
      const datos = { nombre: nombre.value, puesto: puesto.value };
      if (persona && !esYo) datos.activo = activo.querySelector('input').checked;
      if (casillaUsuario.checked) {
        if (!usuario.value.trim()) throw new Error('Escriba el nombre de usuario.');
        if (!tieneUsuario && !contrasena.value) throw new Error('Escriba una contraseña para el usuario.');
        datos.cuenta = { usuario: usuario.value, rol: roles.querySelector('input:checked').value };
        if (contrasena.value) datos.cuenta.contrasena = contrasena.value;
      } else if (tieneUsuario) {
        datos.cuenta = null;
      }
      if (persona) await api('PUT', `/api/personal/${persona.id}`, datos);
      else await api('POST', '/api/personal', datos);
      avisar(persona ? 'Cambios guardados' : 'Persona agregada');
      if (esYo) {
        const estado = await api('GET', '/api/estado');
        if (estado.usuario) {
          yo = estado.usuario;
          armarMarco();
        }
      }
      navegar();
    },
  });
}

async function vistaPersonal() {
  if (yo.rol !== 'admin') {
    location.hash = '#/inicio';
    return null;
  }
  const personal = await api('GET', '/api/personal');

  const eliminar = (p) =>
    confirmar({
      titulo: 'Eliminar persona',
      mensaje: `Se eliminará a ${p.nombre}${p.usuario ? ` y su usuario «${p.usuario}»` : ''}. Esto no se puede deshacer.`,
      textoAccion: 'Eliminar persona',
      accion: async () => {
        await api('DELETE', `/api/personal/${p.id}`);
        avisar('Persona eliminada');
        navegar();
      },
    });

  const activos = personal.filter((p) => p.activo).length;
  return [
    h(
      'div',
      { class: 'encabezado' },
      h('div', {}, h('h1', {}, 'Personal'), h('p', { class: 'subtitulo' }, `${plural(activos, 'persona activa', 'personas activas')}. Aquí se crean también sus usuarios y contraseñas.`)),
      boton('Agregar persona', () => formularioPersona()),
    ),
    h(
      'ul',
      { class: 'lista' },
      personal.map((p) =>
        h(
          'li',
          { class: p.activo ? 'fila persona' : 'fila persona inactiva' },
          h(
            'div',
            {},
            h('p', { class: 'nombre' }, p.nombre),
            h(
              'p',
              { class: 'detalles' },
              h('span', {}, PUESTOS[p.puesto]),
              p.usuario ? h('span', {}, 'Usuario: ', h('b', {}, p.usuario)) : h('span', {}, 'Sin usuario'),
              p.rol === 'admin' && h('span', { class: 'sello' }, 'Administrador'),
              !p.activo && h('span', { class: 'sello baja' }, 'Desactivado'),
            ),
          ),
          h('div', { class: 'acciones' }, boton('Editar', () => formularioPersona(p), 'texto'), p.id !== yo.personal_id && boton('Eliminar', () => eliminar(p), 'texto peligro')),
        ),
      ),
    ),
  ];
}

// ---------- Mi cuenta ----------

async function vistaCuenta() {
  const actual = h('input', { type: 'password', autocomplete: 'current-password' });
  const nueva = h('input', { type: 'password', autocomplete: 'new-password' });
  const repetir = h('input', { type: 'password', autocomplete: 'new-password' });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const guardar = h('button', { type: 'submit', class: 'boton' }, 'Cambiar contraseña');
  const formulario = h(
    'form',
    { class: 'fila panel con-pie', noValidate: true },
    h('h2', {}, 'Cambiar mi contraseña'),
    campo('Contraseña actual', actual),
    campo('Contraseña nueva', nueva, `Al menos ${CONTRASENA_MINIMA} caracteres.`),
    campo('Repita la contraseña nueva', repetir),
    error,
    guardar,
  );
  formulario.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    error.hidden = true;
    guardar.disabled = true;
    try {
      if (!actual.value || !nueva.value) throw new Error('Escriba su contraseña actual y la nueva.');
      if (nueva.value !== repetir.value) throw new Error('Las dos contraseñas nuevas no son iguales. Escríbalas de nuevo.');
      await api('POST', '/api/mi-contrasena', { actual: actual.value, nueva: nueva.value });
      formulario.reset();
      avisar('Contraseña cambiada');
    } catch (fallo) {
      error.textContent = fallo.message;
      error.hidden = false;
    } finally {
      guardar.disabled = false;
    }
  });

  return [
    h('div', { class: 'encabezado' }, h('h1', {}, 'Mi cuenta')),
    h(
      'div',
      { class: 'fila panel' },
      h(
        'dl',
        { class: 'ficha' },
        h('dt', {}, 'Nombre'),
        h('dd', {}, yo.nombre),
        h('dt', {}, 'Puesto'),
        h('dd', {}, PUESTOS[yo.puesto]),
        h('dt', {}, 'Usuario'),
        h('dd', {}, yo.usuario),
        h('dt', {}, 'Acceso'),
        h('dd', {}, yo.rol === 'admin' ? 'Administrador' : 'Técnico'),
      ),
    ),
    h('section', { class: 'seccion' }, formulario),
    yo.rol === 'admin' &&
      h(
        'section',
        { class: 'seccion' },
        h(
          'div',
          { class: 'fila panel con-pie' },
          h('h2', {}, 'Respaldo de la base de datos'),
          h('p', {}, 'Descargue una copia de todo lo guardado en el sistema: personal, usuarios, equipos, piezas y mantenimientos. Guárdela en una memoria USB o en otra computadora.'),
          h('a', { class: 'boton secundario', href: '/api/respaldo', download: '' }, 'Descargar respaldo'),
        ),
      ),
  ];
}

// ---------- Arranque ----------

async function iniciar() {
  try {
    const estado = await api('GET', '/api/estado');
    planta = estado.planta;
    if (!estado.configurado) {
      pantallaConfigurar();
    } else if (!estado.usuario) {
      pantallaEntrar();
    } else {
      yo = estado.usuario;
      armarMarco();
      if (!location.hash) location.hash = '#/inicio';
      else navegar();
    }
  } catch (fallo) {
    document.body.className = 'acceso';
    $app.replaceChildren(
      h('div', { class: 'acceso-panel' }, h('div', { class: 'acceso-form' }, h('h1', {}, 'No se pudo abrir el sistema'), h('p', { class: 'error' }, fallo.message), boton('Volver a intentar', iniciar))),
    );
  }
}

iniciar();
