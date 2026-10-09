'use strict';

// Sistema de mantenimiento — PLANTA GRANULADORA EL PILAR
// Servidor web sin dependencias externas: solo necesita Node.js 22.13 o más nuevo.

const [mayor, menor] = process.versions.node.split('.').map(Number);
if (mayor < 22 || (mayor === 22 && menor < 13)) {
  console.error(
    `Este sistema necesita Node.js 22.13 o más nuevo (esta computadora tiene ${process.versions.node}).\n` +
      'Descargue la versión LTS más reciente en https://nodejs.org e instálela.',
  );
  process.exit(1);
}

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abrirBase } = require('./src/db');
const { crearApi, PLANTA } = require('./src/api');

const CARPETA_PUBLICA = path.join(__dirname, 'public');
const TIPOS_DE_ARCHIVO = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const CABECERAS_DE_SEGURIDAD = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

function servirArchivo(req, res, ruta) {
  const relativa = ruta === '/' ? 'index.html' : ruta.replace(/^\/+/, '');
  const archivo = path.resolve(CARPETA_PUBLICA, relativa);
  const dentro = archivo.startsWith(CARPETA_PUBLICA + path.sep);
  const tipo = TIPOS_DE_ARCHIVO[path.extname(archivo)];
  if (!dentro || !tipo || !fs.existsSync(archivo) || !fs.statSync(archivo).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No se encontró la página.');
    return;
  }
  res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(archivo).pipe(res);
}

function crearServidor({ rutaBase }) {
  const db = abrirBase(rutaBase);
  const api = crearApi(db);

  const servidor = http.createServer((req, res) => {
    for (const [nombre, valor] of Object.entries(CABECERAS_DE_SEGURIDAD)) res.setHeader(nombre, valor);

    let url;
    try {
      url = new URL(req.url, 'http://local');
    } catch {
      res.writeHead(400).end();
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      api.atender(req, res, url);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      let ruta;
      try {
        ruta = decodeURIComponent(url.pathname);
      } catch {
        res.writeHead(400).end();
        return;
      }
      servirArchivo(req, res, ruta);
    } else {
      res.writeHead(405).end();
    }
  });

  servidor.on('close', () => db.close());
  return servidor;
}

function direccionesDeRed() {
  const direcciones = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const i of interfaces || []) {
      if (i.family === 'IPv4' && !i.internal) direcciones.push(i.address);
    }
  }
  return direcciones;
}

if (require.main === module) {
  const puerto = Number(process.env.PUERTO || process.env.PORT || 3000);
  const anfitrion = process.env.ANFITRION || '0.0.0.0';
  const rutaBase = process.env.BASE_DE_DATOS || path.join(__dirname, 'datos', 'planta.db');

  const servidor = crearServidor({ rutaBase });
  servidor.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `El puerto ${puerto} ya está en uso. Puede que el sistema ya esté abierto en otra ventana;\n` +
          'si no, elija otro puerto con la variable PUERTO (por ejemplo PUERTO=3001).',
      );
    } else {
      console.error('No se pudo iniciar el servidor:', error.message);
    }
    process.exit(1);
  });
  servidor.listen(puerto, anfitrion, () => {
    console.log(`\n  ${PLANTA}`);
    console.log('  Sistema de mantenimiento en marcha.\n');
    console.log(`  En esta computadora:      http://localhost:${puerto}`);
    if (anfitrion === '0.0.0.0') {
      for (const ip of direccionesDeRed()) {
        console.log(`  Desde la red de la planta: http://${ip}:${puerto}`);
      }
    }
    console.log(`\n  Base de datos: ${rutaBase}`);
    console.log('  Para detener el sistema cierre esta ventana o presione Ctrl + C.\n');
  });

  const cerrar = () => {
    servidor.close(() => process.exit(0));
    servidor.closeAllConnections();
  };
  process.on('SIGINT', cerrar);
  process.on('SIGTERM', cerrar);
}

module.exports = { crearServidor };
