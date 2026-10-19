// Adaptador entre el sistema y Firebase (Authentication + Firestore).
// Expone solo las pocas funciones que usa datos.js.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  initializeAuth,
  browserLocalPersistence,
  inMemoryPersistence,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore,
  doc,
  getDoc,
  collection,
  onSnapshot,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function conectarFirebase(config) {
  const app = initializeApp(config);
  const auth = initializeAuth(app, { persistence: browserLocalPersistence });
  const db = initializeFirestore(app, {});

  // Una segunda conexión, sin sesión guardada, para que el administrador pueda
  // crear cuentas de otras personas sin que se cierre la suya.
  const appSecundaria = initializeApp(config, 'cuentas-nuevas');
  const authSecundaria = initializeAuth(appSecundaria, { persistence: inMemoryPersistence });

  const ref = (ruta) => doc(db, ...ruta.split('/'));
  const lote = (documento) => ({ id: documento.id, ...documento.data() });

  return {
    nuevoId() {
      const bytes = crypto.getRandomValues(new Uint8Array(20));
      return Array.from(bytes, (b) => LETRAS[b % LETRAS.length]).join('');
    },

    auth: {
      esperarUsuario() {
        return new Promise((listo) => {
          const cancelar = onAuthStateChanged(auth, (usuario) => {
            cancelar();
            listo(usuario ? { uid: usuario.uid, email: usuario.email } : null);
          });
        });
      },
      async entrar(email, contrasena) {
        const r = await signInWithEmailAndPassword(auth, email, contrasena);
        return { uid: r.user.uid, email: r.user.email };
      },
      async registrarYEntrar(email, contrasena) {
        const r = await createUserWithEmailAndPassword(auth, email, contrasena);
        return r.user.uid;
      },
      async crearCuenta(email, contrasena) {
        const r = await createUserWithEmailAndPassword(authSecundaria, email, contrasena);
        const uid = r.user.uid;
        await signOut(authSecundaria);
        return uid;
      },
      async cambiarClave(actual, nueva) {
        const usuario = auth.currentUser;
        if (!usuario) throw Object.assign(new Error('sin sesión'), { code: 'auth/user-not-found' });
        await reauthenticateWithCredential(usuario, EmailAuthProvider.credential(usuario.email, actual));
        await updatePassword(usuario, nueva);
      },
      salir() {
        return signOut(auth);
      },
    },

    db: {
      async leer(ruta) {
        const d = await getDoc(ref(ruta));
        return d.exists() ? d.data() : null;
      },
      escuchar(nombre, alCambiar, alFallar) {
        return onSnapshot(collection(db, nombre), (r) => alCambiar(r.docs.map(lote)), alFallar);
      },
      escucharDoc(ruta, alCambiar) {
        return onSnapshot(ref(ruta), (d) => alCambiar(d.exists() ? d.data() : null), () => alCambiar(null));
      },
      async escribir(operaciones) {
        // Firestore acepta hasta 500 cambios juntos; se envían en grupos.
        for (let i = 0; i < operaciones.length; i += 450) {
          const batch = writeBatch(db);
          for (const op of operaciones.slice(i, i + 450)) {
            if (op.tipo === 'set') batch.set(ref(op.ruta), op.datos);
            else if (op.tipo === 'update') batch.update(ref(op.ruta), op.datos);
            else batch.delete(ref(op.ruta));
          }
          await batch.commit();
        }
      },
    },
  };
}
