// ============================================================
// CONFIGURACIÓN INICIAL Y DEPENDENCIAS
// ============================================================
require("dotenv").config();
const baileys = require("@whiskeysockets/baileys");
const makeWASocket = baileys.default;
const useMultiFileAuthState = baileys.useMultiFileAuthState;
const fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const pino = require("pino");
const http = require("http");

// ============================================================
// UTILIDAD: TIMESTAMP EN LOGS
// ============================================================
function ts() {
    return new Date().toLocaleString('es-MX', {
        timeZone: process.env.TZ || 'America/Mexico_City',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    });
}

const _log   = console.log.bind(console);
const _error = console.error.bind(console);
console.log   = (...a) => _log(`[${ts()}]`, ...a);
console.error = (...args) => {
    const msg = args.join(' ');
    if (msg.includes('Bad MAC') || msg.includes('decrypt') ||
        msg.includes('Session error') || msg.includes('Closing session') ||
        msg.includes('Failed to decrypt') || msg.includes('SessionEntry') ||
        msg.includes('chainKey') || msg.includes('registrationid') ||
        msg.includes('preKey')) return;
    _error(`[${ts()}]`, ...args);
};

// ============================================================
// SERVIDOR QR + AUTO-PING
// ============================================================
let latestQr = null;
const PORT = process.env.PORT || 3000;

http.createServer(async (req, res) => {
    if (req.url === "/qr" && latestQr) {
        const img = await QRCode.toDataURL(latestQr);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
            <h2>Escanea el QR</h2><img src="${img}"/>
            <script>setTimeout(() => location.reload(), 20000);</script>
        </body></html>`);
    } else {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Bot Online");
    }
}).listen(PORT, () => {
    console.log(`Servidor HTTP en puerto ${PORT}`);

    const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(async () => {
        try {
            await axios.get(RENDER_URL, { timeout: 8000 });
            console.log(`Auto-ping OK`);
        } catch (e) {
            console.log(`Auto-ping fallo: ${e.message}`);
        }
    }, 10 * 60 * 1000);
});

// ============================================================
// CONFIGURACIÓN DEL BOT
// ============================================================
const processedMessages = new Set();
const firstTimeUsers    = new Set();

const MAX_CACHE_SIZE = 500;
const NEWS_GROUP_ID  = "120363371012169967@g.us";
const NEWS_SCHEDULE  = [
    { hour: 12, minute: 25 },
    { hour: 21, minute: 55 }
];

let lastNewsSentKey  = null;
let newsInProgress   = false;
let newsScheduled    = false;
let keepAliveStarted = false;
let globalSock       = null;
let isConnected      = false;

setInterval(() => {
    if (firstTimeUsers.size > MAX_CACHE_SIZE)  { firstTimeUsers.clear();    console.log("Cache usuarios limpiado"); }
    if (processedMessages.size > 1000)         { processedMessages.clear(); console.log("Cache mensajes limpiado"); }
}, 3600000);

// ============================================================
// SCRAPER — CONFIGURACIÓN
// ============================================================

// ✅ NUEVO: 3 sitios. Zona Franca con config especial para bypassear bloqueos.
const SITIOS = [
    {
        nombre:   'UM Noticias',
        url:      'https://umnoticias.com.mx/seccion/local/',
        dominio:  'umnoticias.com.mx',
        tipo:     'wordpress'
    },
    {
        nombre:   'Zona Franca',
        // ✅ Usar RSS feed para evitar el bloqueo HTTP 403 de Cloudflare
        // El RSS es XML público y generalmente no está protegido por Cloudflare
        url:      'https://zonafranca.mx/feed/',
        urlFallback: 'https://zonafranca.mx/category/local/feed/',
        dominio:  'zonafranca.mx',
        tipo:     'rss'
    },
    {
        nombre:   'Entérate León',
        // ✅ Probar primero la sección de comunicados (más activa y con fechas limpias)
        url:          'https://enterate.leon.gob.mx/?cat=comunicados',
        urlFallback:  'https://enterate.leon.gob.mx/',
        dominio:      'enterate.leon.gob.mx',
        tipo:         'gobierno',
        selectoresLista: [
            'h1 a[href]',
            'h2 a[href]',
            'h3 a[href]',
            'h4 a[href]',
            'article a[href]',
            '.entry-title a[href]',
            '.post-title a[href]',
            '.titulo a[href]',
            'a[href*="enterate.leon.gob.mx"]'
        ]
    }
];

const MAX_NOTICIAS_POR_SITIO = 2;
const META_NOTICIAS_TOTAL    = 2;  // ✅ Mínimo que queremos enviar en total
const MAX_CHARS_RESUMEN      = 900;

// ✅ Pool de User-Agents para rotar y evitar bloqueos
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
];

function getRandomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getBaseHeaders(extra = {}) {
    return {
        'User-Agent':      getRandomUA(),
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-MX,es;q=0.9,en-US;q=0.7,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection':      'keep-alive',
        'Cache-Control':   'no-cache',
        'Pragma':          'no-cache',
        ...extra
    };
}

// ============================================================
// SCRAPER — FECHAS (con soporte para fechas relativas y UTC)
// ============================================================
function getFechasValidas() {
    // ✅ Usar hora local México, no UTC
    const ahora = new Date();
    const tz    = process.env.TZ || 'America/Mexico_City';

    // Fecha de hoy en México
    const hoyStr = ahora.toLocaleDateString('es-MX', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }); // "DD/MM/YYYY"
    const [hd, hm, hy] = hoyStr.split('/');
    const hoy = new Date(+hy, +hm - 1, +hd);

    const ayer = new Date(hoy);
    ayer.setDate(hoy.getDate() - 1);

    const antier = new Date(hoy);
    antier.setDate(hoy.getDate() - 2);

    const fmt = (d) => ({
        iso:   `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,
        label: d.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' })
    });

    return { hoy: fmt(hoy), ayer: fmt(ayer), antier: fmt(antier), ahora };
}

function parsearFechaTexto(textoFecha) {
    if (!textoFecha || textoFecha === 'Fecha no encontrada') return null;
    const texto = textoFecha.toLowerCase().trim();
    const meses = {
        enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6,
        julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12,
        jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12
    };
    let m;

    // ✅ FIX: Fechas relativas "Hace X minutos/horas/días" (Entérate León y similares)
    m = texto.match(/hace\s+(\d+)\s+(minuto|minutos|hora|horas|día|dias|dia)/);
    if (m) {
        const n = parseInt(m[1]);
        const unidad = m[2];
        const ahora = new Date();
        if (unidad.startsWith('minuto'))  ahora.setMinutes(ahora.getMinutes() - n);
        else if (unidad.startsWith('hora')) ahora.setHours(ahora.getHours() - n);
        else if (unidad.startsWith('d'))   ahora.setDate(ahora.getDate() - n);
        return ahora;
    }

    // "Hace X semanas" = probablemente viejo
    if (texto.match(/hace\s+\d+\s+(semana|semanas|mes|meses|año|años)/)) {
        return new Date(2000, 0, 1); // fecha muy antigua para que se descarte
    }

    // ISO: 2026-03-01 o 2026-03-01T10:45:00+00:00
    m = texto.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (m) {
        // ✅ FIX UTC→México: si el ISO tiene hora, ajustar a zona local
        if (textoFecha.includes('T') || textoFecha.includes('+') || textoFecha.endsWith('Z')) {
            const d = new Date(textoFecha);
            if (!isNaN(d.getTime())) return d; // JS convierte UTC→local automáticamente
        }
        return new Date(+m[1], +m[2]-1, +m[3]);
    }

    m = texto.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
    if (m) return new Date(+m[3], +m[2]-1, +m[1]);

    m = texto.match(/(\d{1,2})\s+(?:de\s+)?([a-záéíóúü]+)\s+(?:de\s+)?(\d{4})/);
    if (m && meses[m[2]]) return new Date(+m[3], meses[m[2]]-1, +m[1]);

    m = texto.match(/([a-záéíóúü]+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (m && meses[m[1]]) return new Date(+m[3], meses[m[1]]-1, +m[2]);

    const intento = new Date(textoFecha);
    if (!isNaN(intento.getTime())) return intento;
    return null;
}

function esFechaValida(textoFecha, fechasValidas) {
    const fecha = parsearFechaTexto(textoFecha);
    if (!fecha) return { valida: false, cual: null };

    // ✅ Comparar en hora local, no en UTC
    const iso = `${fecha.getFullYear()}-${String(fecha.getMonth()+1).padStart(2,'0')}-${String(fecha.getDate()).padStart(2,'0')}`;

    if (iso === fechasValidas.hoy.iso)    return { valida: true, cual: 'hoy' };
    if (iso === fechasValidas.ayer.iso)   return { valida: true, cual: 'ayer' };
    if (iso === fechasValidas.antier.iso) return { valida: true, cual: 'ayer' }; // antier = también "ayer" para efectos del bot
    return { valida: false, cual: null };
}

function formatearFechaLegible(textoFecha) {
    const fecha = parsearFechaTexto(textoFecha);
    if (!fecha) return textoFecha;
    return fecha.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ============================================================
// SCRAPER — LIMPIEZA
// ============================================================
function cortarEnOracionCompleta(texto, maxChars) {
    if (!texto || texto.length <= maxChars) return texto;
    const frag = texto.slice(0, maxChars);
    const punto = Math.max(frag.lastIndexOf('.'), frag.lastIndexOf('!'), frag.lastIndexOf('?'));
    if (punto > maxChars * 0.5) return texto.slice(0, punto + 1).trim();
    const corte = Math.max(frag.lastIndexOf(','), frag.lastIndexOf(' '));
    return texto.slice(0, corte).trim() + '...';
}

function limpiarTexto(texto) {
    if (!texto) return '';
    return texto
        .replace(/\{[^}]*\}/g, '')
        .replace(/@media[^{]*\{[^}]*\}/g, '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[a-z-]+:[a-z0-9%!.\s]+;/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// SCRAPER — FETCH CON REINTENTOS Y ROTACIÓN DE UA
// ============================================================
async function fetchHTML(url, headersExtra = {}, intentos = 3) {
    let ultimoError;
    for (let i = 1; i <= intentos; i++) {
        try {
            const resp = await axios.get(url, {
                headers: getBaseHeaders(headersExtra),
                timeout: 25000,
                maxRedirects: 8,
                // ✅ Importante: aceptar respuestas aunque el status sea 4xx para ver qué devuelve
                validateStatus: (s) => s < 500
            });

            // Si es 403/429 (bloqueado), loguear y reintentar con espera
            if (resp.status === 403 || resp.status === 429) {
                console.log(`   fetchHTML ${url} -> HTTP ${resp.status}, reintento ${i}/${intentos}`);
                await sleep(3000 * i);
                ultimoError = new Error(`HTTP ${resp.status}`);
                continue;
            }

            return resp.data;
        } catch (err) {
            ultimoError = err;
            console.log(`   fetchHTML error (intento ${i}/${intentos}): ${err.message}`);
            if (i < intentos) await sleep(2000 * i);
        }
    }
    throw ultimoError;
}

// ============================================================
// SCRAPER — EXTRAER FECHA DE UN ARTÍCULO
// ============================================================
function extraerFecha($a) {
    // PRIORIDAD 1: Metas ISO (más confiables)
    const metaCandidatos = [
        $a('meta[property="article:published_time"]').attr('content'),
        $a('meta[name="date"]').attr('content'),
        $a('meta[name="publish-date"]').attr('content'),
        $a('meta[property="og:article:published_time"]').attr('content'),
        $a('meta[itemprop="datePublished"]').attr('content'),
    ];
    for (const c of metaCandidatos) {
        if (c && c.trim().length > 3) return c.trim();
    }

    // PRIORIDAD 2: <time datetime="..."> el atributo (no el texto visible)
    const timeDt = $a('time[datetime]').attr('datetime');
    if (timeDt && timeDt.trim().length > 3) return timeDt.trim();

    // PRIORIDAD 3: Buscar "Hace X minutos/horas" en spans/divs pequeños
    // Entérate León usa este patrón
    let haceTexto = null;
    $a('span, small, p').each((_, el) => {
        if (haceTexto) return;
        const t = $a(el).text().trim();
        if (/^hace\s+\d+\s+(minuto|minutos|hora|horas|d.a|dias|dia)/i.test(t) && t.length < 50) {
            haceTexto = t;
        }
    });
    if (haceTexto) return haceTexto;

    // PRIORIDAD 4: Texto de <time> si parece una fecha real
    const timeText = $a('time').first().text().trim();
    if (timeText && timeText.length > 3 && timeText.length < 80 &&
        /\d/.test(timeText)) return timeText;

    // PRIORIDAD 5: Clases de fecha — solo si parece una fecha, no una categoría mezclada
    const clasesFecha = [
        '.fecha', '.post-date', '.published', '.entry-date',
        '.date', '.article-date', '.timestamp'
    ];
    for (const sel of clasesFecha) {
        try {
            const t = $a(sel).first().text().trim();
            if (t && t.length > 3 && t.length < 80 &&
                /(\d{4}|\d{1,2}[-\/]\d{1,2}|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|hace\s+\d)/i.test(t)) {
                return t;
            }
        } catch(_) {}
    }

    return 'Fecha no encontrada';
}

// ============================================================
// SCRAPER — EXTRAER RESUMEN DE UN ARTÍCULO
// ============================================================
function extraerResumen($a) {
    const selectores = [
        'article .entry-content p',
        'article .post-content p',
        '.entry-content p',
        '.post-content p',
        '.contenido p',
        '.content p',
        '.article-body p',
        'article p',
        '.nota p',
        'main p'
    ];
    const parrafos = [];
    for (const sel of selectores) {
        if (parrafos.length >= 2) break;
        $a(sel).each((_, el) => {
            if (parrafos.length >= 2) return;
            const t = $a(el).text().trim();
            const esCss = t.includes('{') || t.includes('font-') || t.includes('margin') ||
                          t.includes('color:#') || t.includes('display:') || t.includes('!important');
            if (t.length > 60 && !esCss &&
                !t.includes('©') && !t.includes('todos los derechos') &&
                !t.includes('Publicidad') && !t.includes('Suscribete') &&
                !t.includes('Newsletter') && !t.includes('compartir'))
                parrafos.push(t);
        });
    }
    return parrafos.slice(0, 2).join('\n\n');
}

// ============================================================
// SCRAPER — EXTRAER ENLACES DE LA PÁGINA PRINCIPAL
// ============================================================
function extraerEnlaces($, sitio) {
    const enlaces = [];
    const selectores = sitio.selectoresLista || ['a[href]'];

    for (const sel of selectores) {
        $(sel).each((_, el) => {
            const href = $(el).attr('href') || '';
            const text = $(el).text().trim();
            let url = href.startsWith('/') ? `https://${sitio.dominio}${href}` :
                      href.startsWith('http') ? href : null;
            if (!url) return;
            if (
                url.includes(sitio.dominio) &&
                url.length > 50 &&
                text.length > 10 &&
                !url.includes('#') &&
                !url.match(/\/(seccion|categoria|category|tag|autor|author|page|pagina)\//)
            ) enlaces.push(url);
        });
    }

    // Fallback para sitios sin selectores específicos: buscar todos los <a>
    if (enlaces.length === 0) {
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href') || '';
            const text = $(el).text().trim();
            let url = href.startsWith('/') ? `https://${sitio.dominio}${href}` :
                      href.startsWith('http') ? href : null;
            if (!url) return;
            if (url.includes(sitio.dominio) && url.length > 50 && text.length > 15)
                enlaces.push(url);
        });
    }

    return [...new Set(enlaces)].slice(0, 12);
}

// ============================================================
// SCRAPER — SCRAPING POR SITIO (ROBUSTO)
// ============================================================
// ============================================================
// SCRAPER — RSS FEED (para sitios con Cloudflare como Zona Franca)
// ============================================================
async function scrapearRSS(sitio, fechasValidas) {
    console.log(`Scrapeando RSS: ${sitio.nombre} → ${sitio.url}`);
    const resultado = { sitio: sitio.nombre, noticias: [], sinNoticias: false, error: null };

    const urlsIntentar = [sitio.url];
    if (sitio.urlFallback) urlsIntentar.push(sitio.urlFallback);

    let xmlData = null;
    for (const rssUrl of urlsIntentar) {
        try {
            const resp = await axios.get(rssUrl, {
                headers: {
                    'User-Agent': getRandomUA(),
                    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
                },
                timeout: 20000,
                maxRedirects: 5,
                validateStatus: s => s < 500
            });
            if (resp.status === 200 && resp.data && resp.data.length > 100) {
                xmlData = resp.data;
                console.log(`   RSS OK: ${rssUrl}`);
                break;
            } else {
                console.log(`   RSS HTTP ${resp.status} en ${rssUrl}`);
            }
        } catch(e) {
            console.log(`   RSS error en ${rssUrl}: ${e.message}`);
        }
    }

    if (!xmlData) {
        resultado.error = 'No se pudo acceder al RSS';
        console.error(`ERROR RSS ${sitio.nombre}: sin datos`);
        return resultado;
    }

    try {
        const $ = cheerio.load(xmlData, { xmlMode: true });
        const items = $('item');
        console.log(`   ${items.length} items en RSS de ${sitio.nombre}`);

        items.each((_, el) => {
            if (resultado.noticias.length >= MAX_NOTICIAS_POR_SITIO) return;

            const titular = $(el).find('title').first().text().trim();
            const pubDate = $(el).find('pubDate').first().text().trim() ||
                            $(el).find('dc\\:date, date').first().text().trim();
            const desc    = $(el).find('description').first().text().trim();
            const link    = $(el).find('link').first().text().trim();

            if (!titular || titular.length < 5) return;

            const fechaLimpia = pubDate || 'Fecha no encontrada';
            const validacion  = esFechaValida(fechaLimpia, fechasValidas);

            if (!validacion.valida) {
                console.log(`   ⏭ RSS DESCARTADA (${fechaLimpia}): "${titular.slice(0,50)}"`);
                return;
            }

            // Limpiar el description (viene con HTML en muchos RSS)
            const descTexto = cheerio.load(desc).text().trim();
            const resumenL  = cortarEnOracionCompleta(limpiarTexto(descTexto), MAX_CHARS_RESUMEN);

            if (!resumenL || resumenL.length < 30) {
                console.log(`   ⏭ RSS DESCARTADA (sin resumen): "${titular.slice(0,50)}"`);
                return;
            }

            resultado.noticias.push({
                fechaDetectada: validacion.cual,
                fechaLegible:   formatearFechaLegible(fechaLimpia),
                titular:        limpiarTexto(titular),
                resumen:        resumenL
            });
            console.log(`   ✅ RSS ACEPTADA (${validacion.cual}): "${titular.slice(0, 55)}"`);
        });

        resultado.sinNoticias = resultado.noticias.length === 0;

    } catch (err) {
        resultado.error = err.message;
        console.error(`ERROR parseando RSS ${sitio.nombre}: ${err.message}`);
    }

    return resultado;
}

async function scrapearSitio(sitio, fechasValidas) {
    // ✅ Si el sitio usa RSS, delegar a scrapearRSS
    if (sitio.tipo === 'rss') return scrapearRSS(sitio, fechasValidas);

    console.log(`Scrapeando: ${sitio.nombre} → ${sitio.url}`);
    const resultado = { sitio: sitio.nombre, noticias: [], sinNoticias: false, error: null };

    try {
        // ✅ Intentar URL principal, con fallback si no hay enlaces
        let htmlPrincipal = await fetchHTML(sitio.url, sitio.headersExtra || {});
        let $ = cheerio.load(htmlPrincipal);
        let enlaces = extraerEnlaces($, sitio);

        // Si no encontró enlaces y hay URL de fallback, intentar con esa
        if (enlaces.length === 0 && sitio.urlFallback) {
            console.log(`   Sin enlaces en URL principal, intentando fallback: ${sitio.urlFallback}`);
            htmlPrincipal = await fetchHTML(sitio.urlFallback, sitio.headersExtra || {});
            $ = cheerio.load(htmlPrincipal);
            enlaces = extraerEnlaces($, sitio);
        }

        console.log(`   ${enlaces.length} enlaces encontrados en ${sitio.nombre}`);

        if (enlaces.length === 0) {
            resultado.sinNoticias = true;
            console.log(`   Sin enlaces en ${sitio.nombre}`);
            return resultado;
        }

        for (let i = 0; i < enlaces.length && resultado.noticias.length < MAX_NOTICIAS_POR_SITIO; i++) {
            try {
                const $a = cheerio.load(await fetchHTML(enlaces[i], sitio.headersExtra || {}));

                const titular = (
                    $a('h1').first().text().trim() ||
                    $a('.entry-title, .post-title, .titulo-noticia, .titulo, [class*="title"]').first().text().trim() ||
                    'Sin titular'
                );

                const fecha     = extraerFecha($a);
                const resumen   = extraerResumen($a);
                const titularL  = limpiarTexto(titular);
                const resumenL  = cortarEnOracionCompleta(limpiarTexto(resumen), MAX_CHARS_RESUMEN);
                const validacion = esFechaValida(fecha, fechasValidas);

                if (validacion.valida) {
                    // ✅ Solo aceptar si hay resumen con contenido real
                    if (!resumenL || resumenL.length < 50) {
                        console.log(`   DESCARTADA (sin resumen): "${titularL.slice(0, 55)}"`);
                    } else {
                        resultado.noticias.push({
                            fechaDetectada: validacion.cual,
                            fechaLegible:   formatearFechaLegible(fecha),
                            titular:        titularL,
                            resumen:        resumenL
                        });
                        console.log(`   ✅ ACEPTADA (${validacion.cual}): "${titularL.slice(0, 55)}"`);
                    }
                } else {
                    console.log(`   ⏭ DESCARTADA - Fecha: "${fecha}"`);
                    const fp = parsearFechaTexto(fecha);
                    // Si la noticia tiene más de 5 días, dejar de buscar en este sitio
                    if (fp && (new Date() - fp) / 86400000 > 5) {
                        console.log(`   Noticias demasiado antiguas en ${sitio.nombre}, deteniendo.`);
                        break;
                    }
                }

                if (resultado.noticias.length < MAX_NOTICIAS_POR_SITIO)
                    await sleep(1000 + Math.floor(Math.random() * 800));

            } catch (err) {
                console.log(`   Error procesando enlace ${i + 1}: ${err.message}`);
            }
        }

        resultado.sinNoticias = resultado.noticias.length === 0;
        if (resultado.sinNoticias) {
            console.log(`   Sin noticias válidas hoy/ayer en ${sitio.nombre}`);
        } else {
            console.log(`   ${resultado.noticias.length} noticia(s) obtenida(s) de ${sitio.nombre}`);
        }

    } catch (err) {
        // ✅ El error se registra SOLO en logs, NUNCA se expone en el grupo
        resultado.error = err.message;
        console.error(`ERROR scraping ${sitio.nombre}: ${err.message}`);
    }

    return resultado;
}

// ============================================================
// SCRAPER — EJECUTAR TODOS LOS SITIOS CON FALLBACK
// ============================================================
async function ejecutarScraper() {
    const fechasValidas = getFechasValidas();
    console.log(`Scraper iniciado — HOY: ${fechasValidas.hoy.label} | AYER: ${fechasValidas.ayer.label}`);

    const resultados = [];
    for (const sitio of SITIOS) {
        resultados.push(await scrapearSitio(sitio, fechasValidas));
        // Pequeña pausa entre sitios para no generar patrones sospechosos
        await sleep(1500);
    }

    // ✅ Conteo global de noticias obtenidas
    const totalNoticias = resultados.reduce((acc, r) => acc + (r.noticias?.length || 0), 0);
    console.log(`Scraper terminado — Total noticias válidas: ${totalNoticias}`);

    return { resultados, fechasValidas, totalNoticias };
}

// ============================================================
// FORMATEAR PARA WHATSAPP — SIN REVELAR FUENTES CON ERRORES
// ============================================================
function formatearParaWhatsApp(resultados, fechasValidas) {
    const SEP = '━'.repeat(30);
    const mensajes = [];
    let noticiaGlobal = 1;
    let hayNoticias   = false;

    // Header principal
    mensajes.push(
        `📡 *NOTICIAS LOCALES*\n` +
        `📍 León, Guanajuato\n` +
        `📅 ${fechasValidas.hoy.label}\n` +
        `${SEP}`
    );

    for (const r of resultados) {
        // ✅ CAMBIO CLAVE: Si hay error o no hay noticias, NO se menciona al grupo
        // Solo se registra internamente en consola (ya ocurrió arriba en scrapearSitio)
        if (r.error || r.sinNoticias || !r.noticias?.length) continue;

        for (const n of r.noticias) {
            hayNoticias = true;
            const etq = n.fechaDetectada === 'hoy' ? '✅ HOY' : '📆 AYER';
            mensajes.push(
                `📰 *NOTICIA ${noticiaGlobal++}*\n` +
                `${SEP}\n` +
                `*${n.titular.toUpperCase()}*\n` +
                `📅 ${n.fechaLegible}  ${etq}\n` +
                `${SEP}\n\n` +
                `📝 *RESUMEN:*\n\n${n.resumen}`
            );
        }
    }

    // ✅ Si no hay NINGUNA noticia de ningún sitio, mensaje genérico y discreto
    if (!hayNoticias) {
        mensajes.push(
            `📋 *Sin novedades destacadas por el momento.*\n` +
            `_Consulta de nuevo en el siguiente horario._`
        );
        return mensajes;
    }

    // Footer con canal solo si hay noticias
    mensajes.push(
        `${SEP}\n` +
        `📲 Más información:\n` +
        `https://whatsapp.com/channel/0029Vb6Ml1x0gcfBHsUjPs06`
    );

    return mensajes;
}

// ============================================================
// ENVIAR NOTICIAS — CON REINTENTOS Y VALIDACIÓN DE CONEXIÓN
// ============================================================
async function sendDailyNews(sock, isManual = false) {
    if (!isConnected) {
        console.log("Bot no conectado, omitiendo envío.");
        return false;
    }
    if (newsInProgress) {
        console.log("Scraper ya en ejecución, omitiendo.");
        return false;
    }

    newsInProgress = true;
    const label = isManual ? ' (Manual)' : '';
    console.log(`Iniciando envío de noticias${label}...`);

    const MAX_REINTENTOS = 3;

    for (let intento = 1; intento <= MAX_REINTENTOS; intento++) {
        try {
            if (!isConnected) {
                console.log(`Intento ${intento}: desconectado, esperando 10s...`);
                await sleep(10000);
                if (!isConnected) { console.log(`Sigue desconectado, saltando intento ${intento}.`); continue; }
            }

            await sock.sendPresenceUpdate('composing', NEWS_GROUP_ID);
            const { resultados, fechasValidas, totalNoticias } = await ejecutarScraper();
            const mensajes = formatearParaWhatsApp(resultados, fechasValidas);

            for (const msg of mensajes) {
                await sock.sendMessage(NEWS_GROUP_ID, { text: msg });
                await sleep(1500);
            }

            console.log(`✅ NOTICIAS ENVIADAS${label} — ${totalNoticias} noticia(s) (intento ${intento})`);
            newsInProgress = false;
            return true;

        } catch (err) {
            console.error(`ERROR AL ENVIAR (intento ${intento}/${MAX_REINTENTOS}): ${err.message}`);
            if (intento < MAX_REINTENTOS) {
                const espera = intento * 15000;
                console.log(`Reintentando en ${espera / 1000}s...`);
                await sleep(espera);
            } else {
                console.error(`Todos los reintentos fallaron. No se envió nada al grupo.`);
                // ✅ NO enviamos mensaje de error al grupo para no revelar el sistema
            }
        }
    }

    newsInProgress = false;
    return false;
}

// ============================================================
// PROGRAMAR NOTICIAS — SCHEDULER CON VENTANA DE 2 MIN
// ============================================================
function scheduleNews(sock) {
    if (newsScheduled) return;
    newsScheduled = true;

    console.log("Horarios programados:");
    NEWS_SCHEDULE.forEach(s =>
        console.log(`   ${String(s.hour).padStart(2,'0')}:${String(s.minute).padStart(2,'0')}`)
    );

    setInterval(() => {
        if (!isConnected) return;

        const now = new Date();
        const h   = now.getHours();
        const min = now.getMinutes();

        const slot = NEWS_SCHEDULE.find(s =>
            s.hour === h && (s.minute === min || s.minute === min - 1)
        );

        if (!slot) return;

        const timeKey = `${now.toDateString()}-${h}:${slot.minute}`;
        if (lastNewsSentKey !== timeKey) {
            lastNewsSentKey = timeKey;
            console.log(`⏰ Disparando noticias — ${h}:${String(min).padStart(2,'0')}`);
            sendDailyNews(sock);
        }
    }, 15000);
}

// ============================================================
// CONEXIÓN PRINCIPAL
// ============================================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version, auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        browser: ['Ghost Bot', 'Chrome', '121.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
        getMessage: async () => undefined,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs:   25000,
        connectTimeoutMs:      60000,
        emitOwnEvents:         false,
        fireInitQueries:       true,
        shouldIgnoreJid:       () => false,
        retryRequestDelayMs:   250
    });

    globalSock = sock;

    if (!keepAliveStarted) {
        keepAliveStarted = true;
        setInterval(() => {
            if (sock?.user && isConnected) {
                sock.sendPresenceUpdate('available').catch(() => {});
            }
        }, 30000);
    }

    sock.ev.on("connection.update", (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            latestQr    = qr;
            isConnected = false;
            qrcodeTerminal.generate(qr, { small: true });
            console.log("QR listo — visita /qr");
        }

        if (connection === "open") {
            isConnected = true;
            latestQr    = null;
            console.log("✅ BOT CONECTADO Y OPERATIVO");
            scheduleNews(sock);
        }

        if (connection === "close") {
            isConnected = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== 401 && code !== 440 && code !== 428;

            console.log(`Conexión cerrada (código: ${code ?? 'desconocido'}) — ${shouldReconnect ? 'reconectando en 5s' : 'STOP definitivo'}`);

            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log("Bot detenido. Sube auth_info a GitHub y redespliega si fue accidental.");
            }
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const msgId = m.key.id;
        if (processedMessages.has(msgId)) return;
        processedMessages.add(msgId);
        setTimeout(() => processedMessages.delete(msgId), 300000);

        const remoteJid = m.key.remoteJid;
        const text = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();

        if (remoteJid === NEWS_GROUP_ID) {
            if (text.toLowerCase() === "@sendinstructionsnotice") {
                console.log("Comando manual recibido: enviando noticias...");
                await sendDailyNews(sock, true);
            }
            return;
        }

        if (remoteJid.endsWith("@g.us")) return;

        if (!firstTimeUsers.has(remoteJid)) {
            firstTimeUsers.add(remoteJid);
            const imagePath   = './Imagenes2/Ghostcmd.png';
            const audioPath   = './Vozcomandante.ogg';
            const welcomeText = "Saludos hermano¡ en estos momentos quizá me encuentro ocupado pero este es mi asistente digital, dime en que te puedo ayudar?";

            try {
                if (fs.existsSync(imagePath)) {
                    await sock.sendMessage(remoteJid, { image: fs.readFileSync(imagePath), caption: welcomeText });
                } else {
                    await sock.sendMessage(remoteJid, { text: welcomeText });
                }
                await sleep(1000);
                if (fs.existsSync(audioPath)) {
                    await sock.sendMessage(remoteJid, { audio: fs.readFileSync(audioPath), mimetype: 'audio/ogg; codecs=opus', ptt: true });
                }
                console.log(`Nuevo usuario saludado: ${remoteJid.split('@')[0]}`);
            } catch (e) {
                console.log(`Error bienvenida: ${e.message}`);
            }
        }
    });
}

// ============================================================
// ARRANQUE
// ============================================================
console.log("Iniciando Ghost Bot...");
console.log(`Zona horaria: ${process.env.TZ || 'America/Mexico_City'}`);
connectToWhatsApp();
