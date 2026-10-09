'use strict';

// Contraseñas y sesiones. Las contraseñas nunca se guardan tal cual: se guarda
// un hash scrypt con sal propia. De las sesiones solo se guarda el hash del
// token, así una copia de la base de datos no sirve para entrar al sistema.

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const COSTO = 16384;
const LARGO_CLAVE = 64;

async function crearHash(contrasena) {
  const sal = crypto.randomBytes(16);
  const clave = await scrypt(contrasena, sal, LARGO_CLAVE, { N: COSTO, r: 8, p: 1 });
  return `scrypt$${COSTO}$${sal.toString('base64')}$${clave.toString('base64')}`;
}

async function verificarHash(contrasena, guardado) {
  const partes = String(guardado).split('$');
  if (partes.length !== 4 || partes[0] !== 'scrypt') return false;
  const costo = Number(partes[1]);
  const sal = Buffer.from(partes[2], 'base64');
  const esperado = Buffer.from(partes[3], 'base64');
  if (!Number.isInteger(costo) || esperado.length === 0) return false;
  const clave = await scrypt(contrasena, sal, esperado.length, { N: costo, r: 8, p: 1 });
  return crypto.timingSafeEqual(clave, esperado);
}

function nuevoToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { crearHash, verificarHash, nuevoToken, hashToken };
