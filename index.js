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

    // Auto-ping cada 10 min para que Render no duerma el servicio
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
    { hour: 0,  minute: 25 },
    { hour: 19, minute: 50 }
];

let lastNewsSentKey  = null;
let newsInProgress   = false;
let newsScheduled    = false;
let keepAliveStarted = false;

setInterval(() => {
    if (firstTimeUsers.size > MAX_CACHE_SIZE)  { firstTimeUsers.clear();    console.log("Cache usuarios limpiado"); }
    if (processedMessages.size > 1000)         { processedMessages.clear(); console.log("Cache mensajes limpiado"); }
}, 3600000);

// ============================================================
// SCRAPER — CONFIGURACION
// ============================================================
const SITIOS = [
    { nombre: 'UM Noticias', url: 'https://umnoticias.com.mx/seccion/local/', dominio: 'umnoticias.com.mx' },
    { nombre: 'Zona Franca', url: 'https://zonafranca.mx/local/',             dominio: 'zonafranca.mx'     }
];

const MAX_NOTICIAS_POR_SITIO = 2;
const MAX_CHARS_RESUMEN      = 900;

const AXIOS_HEADERS = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection':      'keep-alive',
    'Cache-Control':   'max-age=0'
};

// ============================================================
// SCRAPER — FECHAS
// ============================================================
function getFechasValidas() {
    const hoy  = new Date();
    const ayer = new Date();
    ayer.setDate(hoy.getDate() - 1);
    const fmt = (d) => ({
        iso:   d.toISOString().split('T')[0],
        label: d.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' })
    });
    return { hoy: fmt(hoy), ayer: fmt(ayer) };
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
    m = texto.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (m) return new Date(+m[1], +m[2]-1, +m[3]);
    m = texto.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
    if (m) return new Date(+m[3], +m[2]-1, +m[1]);
    m = texto.match(/(\d{1,2})\s+(?:de\s+)?([a-z\u00e1\u00e9\u00ed\u00f3\u00fa]+)\s+(?:de\s+)?(\d{4})/);
    if (m && meses[m[2]]) return new Date(+m[3], meses[m[2]]-1, +m[1]);
    m = texto.match(/([a-z\u00e1\u00e9\u00ed\u00f3\u00fa]+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (m && meses[m[1]]) return new Date(+m[3], meses[m[1]]-1, +m[2]);
    const intento = new Date(textoFecha);
    if (!isNaN(intento.getTime())) return intento;
    return null;
}

function esFechaValida(textoFecha, fechasValidas) {
    const fecha = parsearFechaTexto(textoFecha);
    if (!fecha) return { valida: false, cual: null };
    const iso = fecha.toISOString().split('T')[0];
    if (iso === fechasValidas.hoy.iso)  return { valida: true, cual: 'hoy' };
    if (iso === fechasValidas.ayer.iso) return { valida: true, cual: 'ayer' };
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

async function fetchHTML(url) {
    const r = await axios.get(url, { headers: AXIOS_HEADERS, timeout: 20000, maxRedirects: 5 });
    return r.data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// SCRAPER — SCRAPING POR SITIO
// ============================================================
async function scrapearSitio(sitio, fechasValidas) {
    console.log(`Scrapeando: ${sitio.nombre}`);
    const resultado = { sitio: sitio.nombre, noticias: [], sinNoticias: false, error: null };

    try {
        const $ = cheerio.load(await fetchHTML(sitio.url));
        const enlaces = [];

        $('a[href]').each((_, el) => {
            const href = $(el).attr('href') || '';
            const text = $(el).text().trim();
            let url = href.startsWith('/') ? `https://${sitio.dominio}${href}` : href;
            if (
                url.includes(sitio.dominio) && url.length > 60 && text.length > 15 &&
                !url.includes('#') && !url.includes('/seccion/') && !url.includes('/categoria/') &&
                !url.includes('/author/') && !url.includes('/tag/') && !url.includes('/local/page/') &&
                !text.toUpperCase().includes('LEER MAS') && !text.toUpperCase().includes('CONTINUAR') &&
                !text.toUpperCase().includes('VER TODAS')
            ) enlaces.push(url);
        });

        const enlacesUnicos = [...new Set(enlaces)].slice(0, 10);
        console.log(`   ${enlacesUnicos.length} enlaces en ${sitio.nombre}`);

        for (let i = 0; i < enlacesUnicos.length && resultado.noticias.length < MAX_NOTICIAS_POR_SITIO; i++) {
            try {
                const $a = cheerio.load(await fetchHTML(enlacesUnicos[i]));

                const titular = $a('h1').first().text().trim() ||
                    $a('.entry-title, .post-title, .titulo-noticia').first().text().trim() || 'Sin titular';

                const parrafos = [];
                for (const sel of ['article .entry-content p','article .post-content p','.entry-content p','.post-content p','.contenido p','article p']) {
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

                const posiblesFechas = [
                    $a('meta[property="article:published_time"]').attr('content'),
                    $a('meta[name="date"]').attr('content'),
                    $a('time').attr('datetime'),
                    $a('time').first().text().trim(),
                    $a('.fecha, .post-date, .published, .entry-date').first().text().trim()
                ];
                const fecha = posiblesFechas.find(f => f && f.trim().length > 3 && !f.includes('{')) || 'Fecha no encontrada';

                const titularLimpio = limpiarTexto(titular);
                const resumenLimpio = cortarEnOracionCompleta(limpiarTexto(parrafos.slice(0, 2).join('\n\n')), MAX_CHARS_RESUMEN);
                const validacion    = esFechaValida(fecha, fechasValidas);

                if (validacion.valida) {
                    resultado.noticias.push({
                        fechaDetectada: validacion.cual,
                        fechaLegible:   formatearFechaLegible(fecha),
                        titular:  titularLimpio,
                        resumen:  resumenLimpio
                    });
                    console.log(`   ACEPTADA (${validacion.cual}): "${titularLimpio.slice(0, 55)}"`);
                } else {
                    console.log(`   DESCARTADA - Fecha: "${fecha}"`);
                    const fp = parsearFechaTexto(fecha);
                    if (fp && (new Date() - fp) / 86400000 > 3) break;
                }

                if (resultado.noticias.length < MAX_NOTICIAS_POR_SITIO)
                    await sleep(1200 + Math.floor(Math.random() * 600));

            } catch (err) { console.log(`   Error enlace: ${err.message}`); }
        }

        resultado.sinNoticias = resultado.noticias.length === 0;
        console.log(resultado.sinNoticias
            ? `Sin noticias validas en ${sitio.nombre}`
            : `${resultado.noticias.length} noticia(s) de ${sitio.nombre}`);

    } catch (err) {
        resultado.error = err.message;
        console.error(`ERROR en ${sitio.nombre}: ${err.message}`);
    }

    return resultado;
}

async function ejecutarScraper() {
    const fechasValidas = getFechasValidas();
    console.log(`Scraper iniciado - HOY: ${fechasValidas.hoy.label} | AYER: ${fechasValidas.ayer.label}`);
    const resultados = [];
    for (const sitio of SITIOS) resultados.push(await scrapearSitio(sitio, fechasValidas));
    return { resultados, fechasValidas };
}

// ============================================================
// FORMATEAR PARA WHATSAPP
// ============================================================
function formatearParaWhatsApp(resultados, fechasValidas) {
    const SEP = '\u2501'.repeat(30);
    const mensajes = [];
    let noticiaGlobal = 1;
    let hayNoticias   = false;

    mensajes.push(`\uD83D\uDCE1 *NOTICIAS LOCALES*\n\uD83D\uDCCD Le\u00f3n, Guanajuato\n\uD83D\uDCC5 ${fechasValidas.hoy.label}\n${SEP}`);

    for (const r of resultados) {
        if (r.error) { mensajes.push(`\u26A0\uFE0F *${r.sitio}*: No se pudo acceder.`); continue; }
        if (r.sinNoticias || !r.noticias.length) { mensajes.push(`\uD83D\uDCED *${r.sitio}*\nSin noticias recientes.`); continue; }

        for (const n of r.noticias) {
            hayNoticias = true;
            const etq = n.fechaDetectada === 'hoy' ? '\u2705 HOY' : '\uD83D\uDCC6 AYER';
            mensajes.push(
                `\uD83D\uDCF0 *NOTICIA ${noticiaGlobal++}*\n${SEP}\n` +
                `*${n.titular.toUpperCase()}*\n` +
                `\uD83D\uDCC5 ${n.fechaLegible}  ${etq}\n` +
                `\uD83D\uDD39 *${r.sitio}*\n${SEP}\n` +
                `\uD83D\uDCDD *RESUMEN:*\n\n${n.resumen}`
            );
        }
    }

    if (hayNoticias)
        mensajes.push(`${SEP}\n\uD83D\uDCF2 M\u00e1s info:\nhttps://whatsapp.com/channel/0029Vb6Ml1x0gcfBHsUjPs06`);

    return mensajes;
}

// ============================================================
// ENVIAR NOTICIAS
// ============================================================
async function sendDailyNews(sock, isManual = false) {
    if (newsInProgress) { console.log("Scraper ya en ejecucion, ignorando."); return false; }
    newsInProgress = true;
    const label = isManual ? ' (Manual)' : '';
    console.log(`Enviando noticias${label}...`);

    try {
        await sock.sendPresenceUpdate('composing', NEWS_GROUP_ID);
        const { resultados, fechasValidas } = await ejecutarScraper();
        const mensajes = formatearParaWhatsApp(resultados, fechasValidas);
        for (const msg of mensajes) { await sock.sendMessage(NEWS_GROUP_ID, { text: msg }); await sleep(1500); }
        const total = resultados.reduce((a, r) => a + (r.noticias?.length || 0), 0);
        console.log(`NOTICIAS ENVIADAS${label} - ${total} noticias`);
        return true;
    } catch (err) {
        console.error(`ERROR AL ENVIAR: ${err.message}`);
        try { await sock.sendMessage(NEWS_GROUP_ID, { text: "\u26A0\uFE0F Error al obtener noticias. Se reintentara en el siguiente horario." }); } catch {}
        return false;
    } finally {
        newsInProgress = false;
    }
}

// ============================================================
// PROGRAMAR NOTICIAS
// ============================================================
function scheduleNews(sock) {
    if (newsScheduled) return;
    newsScheduled = true;
    console.log("Horarios programados:");
    NEWS_SCHEDULE.forEach(s => console.log(`   ${String(s.hour).padStart(2,'0')}:${String(s.minute).padStart(2,'0')}`));

    setInterval(() => {
        const now     = new Date();
        const timeKey = `${now.toDateString()}-${now.getHours()}:${now.getMinutes()}`;
        if (NEWS_SCHEDULE.some(s => s.hour === now.getHours() && s.minute === now.getMinutes()) && lastNewsSentKey !== timeKey) {
            lastNewsSentKey = timeKey;
            sendDailyNews(sock);
        }
    }, 30000);
}

// ============================================================
// CONEXION PRINCIPAL
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
        keepAliveIntervalMs:   30000,
        connectTimeoutMs:      60000,
        emitOwnEvents:         false,
        fireInitQueries:       true,
        shouldIgnoreJid:       () => false,
        retryRequestDelayMs:   250
    });

    if (!keepAliveStarted) {
        keepAliveStarted = true;
        setInterval(() => { if (sock?.user) sock.sendPresenceUpdate('available').catch(() => {}); }, 50000);
    }

    sock.ev.on("connection.update", (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            latestQr = qr;
            qrcodeTerminal.generate(qr, { small: true });
            console.log("QR listo - escanea en /qr");
        }

        if (connection === "open") {
            console.log("BOT CONECTADO Y OPERATIVO");
            scheduleNews(sock);
        }

        if (connection === "close") {
            const code = lastDisconnect?.error?.output?.statusCode;

            // ⭐ CLAVE: 401=sesion invalida, 440=reemplazada, 428=forzada — NO reconectar
            const shouldReconnect = code !== 401 && code !== 440 && code !== 428;

            console.log(`Conexion cerrada (codigo: ${code ?? 'desconocido'}) - ${shouldReconnect ? 'reconectando en 5s' : 'STOP definitivo'}`);

            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log("Bot detenido. Si fue intencional, sube el auth_info a GitHub y redespliega.");
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
                console.log("Comando manual: enviando noticias...");
                await sendDailyNews(sock, true);
            }
            return;
        }

        if (remoteJid.endsWith("@g.us")) return;

        if (!firstTimeUsers.has(remoteJid)) {
            firstTimeUsers.add(remoteJid);
            const imagePath   = './Imagenes2/Ghostcmd.png';
            const audioPath   = './Vozcomandante.ogg';
            const welcomeText = "Saludos hermano\u00a1 en estos momentos quiza me encuentro ocupado pero este es mi asistente digital, dime en que te puedo ayudar?";

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
