'use strict';

// Base de datos SQLite: un solo archivo en disco donde queda guardado todo
// lo que se agrega en el sistema (personal, usuarios, equipos, piezas y
// mantenimientos).

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ESQUEMA_V1 = `
CREATE TABLE personal (
  id         INTEGER PRIMARY KEY,
  nombre     TEXT    NOT NULL,
  puesto     TEXT    NOT NULL
             CHECK (puesto IN ('mecanico','soldador','electricista','supervisor','otro')),
  activo     INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0,1)),
  creado_en  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE usuarios (
  id           INTEGER PRIMARY KEY,
  personal_id  INTEGER NOT NULL UNIQUE REFERENCES personal(id) ON DELETE CASCADE,
  usuario      TEXT    NOT NULL UNIQUE,
  clave_hash   TEXT    NOT NULL,
  rol          TEXT    NOT NULL CHECK (rol IN ('admin','tecnico')),
  creado_en    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sesiones (
  token_hash  TEXT    PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  vence_en    INTEGER NOT NULL
);

CREATE TABLE equipos (
  id                 INTEGER PRIMARY KEY,
  nombre             TEXT NOT NULL,
  ubicacion_tecnica  TEXT NOT NULL,
  notas              TEXT NOT NULL DEFAULT '',
  creado_en          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE piezas (
  id         INTEGER PRIMARY KEY,
  equipo_id  INTEGER NOT NULL REFERENCES equipos(id) ON DELETE CASCADE,
  nombre     TEXT    NOT NULL,
  codigo     TEXT    NOT NULL DEFAULT '',
  cantidad   INTEGER NOT NULL DEFAULT 1 CHECK (cantidad >= 1),
  notas      TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX piezas_por_equipo ON piezas(equipo_id);

CREATE TABLE mantenimientos (
  id                INTEGER PRIMARY KEY,
  equipo_id         INTEGER NOT NULL REFERENCES equipos(id) ON DELETE CASCADE,
  tipo              TEXT    NOT NULL CHECK (tipo IN ('preventivo','correctivo')),
  trabajo           TEXT    NOT NULL,
  detalles          TEXT    NOT NULL DEFAULT '',
  fecha_programada  TEXT    NOT NULL,
  estado            TEXT    NOT NULL DEFAULT 'pendiente'
                    CHECK (estado IN ('pendiente','en_proceso','terminado')),
  fecha_terminado   TEXT,
  observaciones     TEXT    NOT NULL DEFAULT '',
  creado_por        INTEGER REFERENCES personal(id) ON DELETE SET NULL,
  terminado_por     INTEGER REFERENCES personal(id) ON DELETE SET NULL,
  creado_en         TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX mantenimientos_por_equipo ON mantenimientos(equipo_id);
CREATE INDEX mantenimientos_por_fecha  ON mantenimientos(fecha_programada);

CREATE TABLE mantenimiento_personal (
  mantenimiento_id  INTEGER NOT NULL REFERENCES mantenimientos(id) ON DELETE CASCADE,
  personal_id       INTEGER NOT NULL REFERENCES personal(id) ON DELETE RESTRICT,
  PRIMARY KEY (mantenimiento_id, personal_id)
);

CREATE TABLE mantenimiento_piezas (
  mantenimiento_id  INTEGER NOT NULL REFERENCES mantenimientos(id) ON DELETE CASCADE,
  pieza_id          INTEGER NOT NULL REFERENCES piezas(id) ON DELETE CASCADE,
  PRIMARY KEY (mantenimiento_id, pieza_id)
);
`;

// Cada entrada lleva la base de una versión a la siguiente. Para cambiar el
// esquema más adelante se agrega una entrada nueva; nunca se edita una vieja.
const MIGRACIONES = [ESQUEMA_V1];

function abrirBase(ruta) {
  if (ruta !== ':memory:') fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const db = new DatabaseSync(ruta);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  let version = db.prepare('PRAGMA user_version').get().user_version;
  while (version < MIGRACIONES.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRACIONES[version]);
      version += 1;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return db;
}

// Ejecuta fn dentro de una transacción: o se guarda todo, o no se guarda nada.
function transaccion(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const resultado = fn();
    db.exec('COMMIT');
    return resultado;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { abrirBase, transaccion };
