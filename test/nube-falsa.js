// Imitación en memoria de Firebase (Authentication + Firestore) para probar
// datos.js sin internet. Varios "clientes" comparten la misma nube, cada uno
// con su propia sesión, como varios teléfonos usando el sistema a la vez.

export function crearNube() {
  const documentos = new Map();
  const cuentas = new Map(); // email -> { uid, clave }
  const escuchas = new Set();
  let contador = 0;

  const copiar = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const coleccionDe = (ruta) => ruta.split('/')[0];

  function avisar(rutasCambiadas) {
    const colecciones = new Set(rutasCambiadas.map(coleccionDe));
    for (const e of escuchas) {
      if (e.tipo === 'coleccion' && colecciones.has(e.nombre)) queueMicrotask(() => e.activa && e.cb(listar(e.nombre)));
      if (e.tipo === 'doc' && rutasCambiadas.includes(e.ruta)) queueMicrotask(() => e.activa && e.cb(copiar(documentos.get(e.ruta)) || null));
    }
  }

  function listar(nombre) {
    return [...documentos.entries()].filter(([r]) => coleccionDe(r) === nombre && r.split('/').length === 2).map(([r, d]) => ({ id: r.split('/')[1], ...copiar(d) }));
  }

  const fallo = (code) => Object.assign(new Error(code), { code });

  function cliente() {
    let actual = null;
    return {
      nuevoId: () => `id${(contador += 1).toString(36)}x${Math.random().toString(36).slice(2, 8)}`,
      auth: {
        esperarUsuario: async () => actual && { ...actual },
        async entrar(email, clave) {
          const c = cuentas.get(email);
          if (!c || c.clave !== clave) throw fallo('auth/invalid-credential');
          actual = { uid: c.uid, email };
          return { ...actual };
        },
        async registrarYEntrar(email, clave) {
          const uid = await this.crearCuenta(email, clave);
          actual = { uid, email };
          return uid;
        },
        async crearCuenta(email, clave) {
          if (cuentas.has(email)) throw fallo('auth/email-already-in-use');
          if (clave.length < 6) throw fallo('auth/weak-password');
          const uid = `uid${(contador += 1)}`;
          cuentas.set(email, { uid, clave });
          return uid;
        },
        async cambiarClave(actualClave, nueva) {
          const c = cuentas.get(actual.email);
          if (c.clave !== actualClave) throw fallo('auth/wrong-password');
          c.clave = nueva;
        },
        async salir() {
          actual = null;
        },
      },
      db: {
        leer: async (ruta) => copiar(documentos.get(ruta)) || null,
        escuchar(nombre, cb) {
          const e = { tipo: 'coleccion', nombre, cb, activa: true };
          escuchas.add(e);
          queueMicrotask(() => e.activa && cb(listar(nombre)));
          return () => {
            e.activa = false;
            escuchas.delete(e);
          };
        },
        escucharDoc(ruta, cb) {
          const e = { tipo: 'doc', ruta, cb, activa: true };
          escuchas.add(e);
          queueMicrotask(() => e.activa && cb(copiar(documentos.get(ruta)) || null));
          return () => {
            e.activa = false;
            escuchas.delete(e);
          };
        },
        async escribir(operaciones) {
          for (const op of operaciones) if (op.tipo === 'update' && !documentos.has(op.ruta)) throw fallo('not-found');
          for (const op of operaciones) {
            if (op.tipo === 'set') documentos.set(op.ruta, copiar(op.datos));
            else if (op.tipo === 'update') documentos.set(op.ruta, { ...documentos.get(op.ruta), ...copiar(op.datos) });
            else documentos.delete(op.ruta);
          }
          avisar(operaciones.map((o) => o.ruta));
        },
      },
    };
  }

  return { cliente, documentos };
}
