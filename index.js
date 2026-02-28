// ============================================================
// CONFIGURACIÓN INICIAL Y DEPENDENCIAS
// ============================================================
require("dotenv").config();
const baileys = require("@whiskeysockets/baileys");
const makeWASocket = baileys.default;
const useMultiFileAuthState = baileys.useMultiFileAuthState;
const fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
const fs = require('fs');
const { firefox } = require('playwright');
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const pino = require("pino");
const http = require("http");

// ⭐ SILENCIAR BASURA DE CONSOLA
const originalConsoleError = console.error;
console.error = (...args) => {
    const msg = args.join(' ');
    if (msg.includes('Bad MAC') ||
        msg.includes('decrypt') ||
        msg.includes('Session error') ||
        msg.includes('Closing session') ||
        msg.includes('Failed to decrypt') ||
        msg.includes('SessionEntry') ||
        msg.includes('chainKey') ||
        msg.includes('registrationid') ||
        msg.includes('preKey')) {
        return;
    }
    originalConsoleError(...args);
};

// ============================================================
// SERVIDOR QR
// ============================================================
let latestQr = null;
http.createServer(async (req, res) => {
    if (req.url === "/qr" && latestQr) {
        const img = await QRCode.toDataURL(latestQr);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;"><h2>Escanea el QR</h2><img src="${img}"/><script>setTimeout(() => location.reload(), 20000);</script></body></html>`);
    } else {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Bot Online. QR en /qr");
    }
}).listen(process.env.PORT || 3000, () => {
    console.log(`🌐 Servidor HTTP en puerto ${process.env.PORT || 3000}`);
});

// ============================================================
// CONFIGURACIÓN DEL BOT
// ============================================================
const processedMessages = new Set();
const firstTimeUsers = new Set();

const MAX_CACHE_SIZE = 500;
const NEWS_GROUP_ID = "120363371012169967@g.us";
const NEWS_SCHEDULE = [
    { hour: 9, minute: 10 },
    { hour: 19, minute: 50 }
];

let lastNewsSentKey = null;
let newsInProgress = false; // Evitar ejecuciones simultáneas

// Limpieza de memoria cada hora
setInterval(() => {
    if (firstTimeUsers.size > MAX_CACHE_SIZE) {
        firstTimeUsers.clear();
        console.log("🧹 Cache de usuarios nuevos limpiado");
    }
    if (processedMessages.size > 1000) {
        processedMessages.clear();
        console.log("🧹 Cache de mensajes procesados limpiado");
    }
}, 3600000);

// ============================================================
// SCRAPER — CONFIGURACIÓN
// ============================================================
const SITIOS = [
    {
        nombre: 'UM Noticias',
        url: 'https://umnoticias.com.mx/seccion/local/',
        dominio: 'umnoticias.com.mx'
    },
    {
        nombre: 'Zona Franca',
        url: 'https://zonafranca.mx/local/',
        dominio: 'zonafranca.mx'
    }
];

const MAX_NOTICIAS_POR_SITIO = 2;
const MAX_CHARS_RESUMEN = 900;

// ============================================================
// SCRAPER — UTILIDADES DE FECHA
// ============================================================
function getFechasValidas() {
    const hoy  = new Date();
    const ayer = new Date();
    ayer.setDate(hoy.getDate() - 1);

    const formatear = (d) => ({
        iso:   d.toISOString().split('T')[0],
        label: d.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' })
    });

    return { hoy: formatear(hoy), ayer: formatear(ayer) };
}

function parsearFechaTexto(textoFecha) {
    if (!textoFecha || textoFecha === 'Fecha no encontrada') return null;

    const texto = textoFecha.toLowerCase().trim();
    const meses = {
        enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6,
        julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12,
        jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
        jul:7, aug:8, sep:9, oct:10, nov:11, dec:12
    };

    let m = texto.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (m) return new Date(+m[1], +m[2]-1, +m[3]);

    m = texto.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
    if (m) return new Date(+m[3], +m[2]-1, +m[1]);

    m = texto.match(/(\d{1,2})\s+(?:de\s+)?([a-záéíóú]+)\s+(?:de\s+)?(\d{4})/);
    if (m && meses[m[2]]) return new Date(+m[3], meses[m[2]]-1, +m[1]);

    m = texto.match(/([a-záéíóú]+)\s+(\d{1,2}),?\s+(\d{4})/);
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
// SCRAPER — LIMPIEZA DE TEXTO
// ============================================================
function cortarEnOracionCompleta(texto, maxChars) {
    if (!texto || texto.length <= maxChars) return texto;

    const fragmento = texto.slice(0, maxChars);
    const ultimoPunto = Math.max(
        fragmento.lastIndexOf('.'),
        fragmento.lastIndexOf('!'),
        fragmento.lastIndexOf('?')
    );

    if (ultimoPunto > maxChars * 0.5) {
        return texto.slice(0, ultimoPunto + 1).trim();
    }

    const corte = Math.max(fragmento.lastIndexOf(','), fragmento.lastIndexOf(' '));
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

// ============================================================
// SCRAPER — SCRAPING POR SITIO
// ============================================================
async function scrapearSitio(page, sitio, fechasValidas) {
    console.log(`🌐 Scrapeando: ${sitio.nombre}`);

    const resultado = {
        sitio: sitio.nombre,
        url: sitio.url,
        noticias: [],
        sinNoticias: false,
        error: null
    };

    try {
        await page.goto(sitio.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        try {
            await page.click('.accept-cookies, .close-popup, .modal-close, .gdrpr-modal-close', { timeout: 2000 });
        } catch { /* Sin pop-ups */ }

        await page.waitForTimeout(3000);
        for (let i = 0; i < 3; i++) {
            await page.evaluate(() => window.scrollBy(0, 500));
            await page.waitForTimeout(500);
        }

        const enlaces = await page.evaluate((dominio) => {
            const links = Array.from(document.querySelectorAll('a[href]'))
                .map(a => ({ href: a.href.trim(), text: a.textContent.trim() }))
                .filter(link =>
                    link.href.includes(dominio) &&
                    link.href.length > 60 &&
                    link.text.length > 15 &&
                    !link.href.includes('#') &&
                    !link.href.includes('/seccion/') &&
                    !link.href.includes('/categoria/') &&
                    !link.href.includes('/author/') &&
                    !link.href.includes('/tag/') &&
                    !link.href.includes('/local/page/') &&
                    !link.text.toUpperCase().includes('LEER MÁS') &&
                    !link.text.toUpperCase().includes('CONTINUAR') &&
                    !link.text.toUpperCase().includes('VER TODAS')
                );
            return [...new Map(links.map(l => [l.href, l])).values()].slice(0, 10).map(l => l.href);
        }, sitio.dominio);

        console.log(`   📌 ${enlaces.length} enlaces encontrados`);

        for (let i = 0; i < enlaces.length && resultado.noticias.length < MAX_NOTICIAS_POR_SITIO; i++) {
            const url = enlaces[i];

            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(1500);

                const datosNoticia = await page.evaluate(() => {
                    const titular = document.querySelector('h1')?.textContent.trim() ||
                        document.querySelector('.entry-title, .post-title, .titulo-noticia')?.textContent.trim() ||
                        'Sin titular';

                    let parrafosTexto = [];
                    const selectoresArticulo = [
                        'article .entry-content p', 'article .post-content p',
                        '.entry-content p', '.post-content p', '.contenido p', 'article p'
                    ];

                    for (const selector of selectoresArticulo) {
                        if (parrafosTexto.length >= 2) break;
                        document.querySelectorAll(selector).forEach(p => {
                            if (parrafosTexto.length >= 2) return;
                            const texto = p.textContent.trim();
                            const esCss = texto.includes('{') || texto.includes('font-') ||
                                          texto.includes('margin') || texto.includes('color:#') ||
                                          texto.includes('display:') || texto.includes('!important');
                            if (
                                texto.length > 60 && !esCss &&
                                !texto.includes('©') && !texto.includes('todos los derechos') &&
                                !texto.includes('Publicidad') && !texto.includes('Suscríbete') &&
                                !texto.includes('Newsletter') && !texto.includes('compartir')
                            ) {
                                parrafosTexto.push(texto);
                            }
                        });
                    }

                    const resumen = parrafosTexto.slice(0, 2).join('\n\n');

                    const posiblesFechas = [
                        document.querySelector('time')?.getAttribute('datetime'),
                        document.querySelector('meta[property="article:published_time"]')?.getAttribute('content'),
                        document.querySelector('meta[name="date"]')?.getAttribute('content'),
                        document.querySelector('time')?.textContent.trim(),
                        document.querySelector('.fecha, .post-date, .published, .entry-date')?.textContent.trim()
                    ];
                    const fecha = posiblesFechas.find(f => f && f.trim().length > 3 && !f.includes('{')) || 'Fecha no encontrada';

                    return { titular, resumen, fecha };
                });

                datosNoticia.titular = limpiarTexto(datosNoticia.titular);
                datosNoticia.resumen = cortarEnOracionCompleta(limpiarTexto(datosNoticia.resumen), MAX_CHARS_RESUMEN);

                const validacion = esFechaValida(datosNoticia.fecha, fechasValidas);

                if (validacion.valida) {
                    resultado.noticias.push({
                        numero: resultado.noticias.length + 1,
                        fechaDetectada: validacion.cual,
                        fechaLegible: formatearFechaLegible(datosNoticia.fecha),
                        titular: datosNoticia.titular,
                        resumen: datosNoticia.resumen
                    });
                    console.log(`   ✅ ACEPTADA (${validacion.cual}) → "${datosNoticia.titular.slice(0, 55)}"`);
                } else {
                    console.log(`   ⏭️  DESCARTADA → Fecha: "${datosNoticia.fecha}"`);
                    const fechaParsed = parsearFechaTexto(datosNoticia.fecha);
                    if (fechaParsed) {
                        const diffDias = (new Date() - fechaParsed) / (1000 * 60 * 60 * 24);
                        if (diffDias > 3) break;
                    }
                }

                if (i < enlaces.length - 1 && resultado.noticias.length < MAX_NOTICIAS_POR_SITIO) {
                    await page.waitForTimeout(1500 + Math.floor(Math.random() * 800));
                }

            } catch (err) {
                console.log(`   ❌ Error en enlace: ${err.message}`);
            }
        }

        if (resultado.noticias.length === 0) {
            resultado.sinNoticias = true;
            console.log(`⚠️  Sin noticias válidas en ${sitio.nombre}`);
        } else {
            console.log(`🎯 ${resultado.noticias.length} noticia(s) de ${sitio.nombre}`);
        }

    } catch (err) {
        resultado.error = err.message;
        console.error(`❌ ERROR en ${sitio.nombre}: ${err.message}`);
    }

    return resultado;
}

// ============================================================
// SCRAPER — EJECUTAR TODOS LOS SITIOS
// ============================================================
async function ejecutarScraper() {
    const fechasValidas = getFechasValidas();
    console.log(`\n📰 Iniciando scraper...`);
    console.log(`📅 HOY: ${fechasValidas.hoy.label} | AYER: ${fechasValidas.ayer.label}`);

    const browser = await firefox.launch({ headless: true });
    const page    = await browser.newPage();
    const resultados = [];

    try {
        for (const sitio of SITIOS) {
            const resultado = await scrapearSitio(page, sitio, fechasValidas);
            resultados.push(resultado);
        }
    } finally {
        await browser.close();
    }

    return { resultados, fechasValidas };
}

// ============================================================
// SCRAPER — FORMATEAR PARA WHATSAPP
// ============================================================
function formatearParaWhatsApp(resultados, fechasValidas) {
    const SEP = '━'.repeat(30);
    let mensajes = [];
    let noticiaGlobal = 1;
    let hayNoticias = false;

    // Encabezado
    let encabezado = `📡 *NOTICIAS LOCALES*\n`;
    encabezado    += `📍 León, Guanajuato\n`;
    encabezado    += `📅 ${fechasValidas.hoy.label}\n`;
    encabezado    += SEP;
    mensajes.push(encabezado);

    resultados.forEach((resultado) => {

        if (resultado.error) {
            mensajes.push(`⚠️ *${resultado.sitio}*: No se pudo acceder al sitio.`);
            return;
        }

        if (resultado.sinNoticias || resultado.noticias.length === 0) {
            mensajes.push(`📭 *${resultado.sitio}*\nSin noticias recientes para hoy.`);
            return;
        }

        resultado.noticias.forEach((n) => {
            hayNoticias = true;
            const etiqueta = n.fechaDetectada === 'hoy' ? '✅ HOY' : '📆 AYER';

            let msg = '';
            msg += `📰 *NOTICIA ${noticiaGlobal}*\n`;
            msg += `${SEP}\n`;
            msg += `*${n.titular.toUpperCase()}*\n`;
            msg += `📅 ${n.fechaLegible}  ${etiqueta}\n`;
            msg += `🔹 *${resultado.sitio}*\n`;
            msg += `${SEP}\n`;
            msg += `📝 *RESUMEN:*\n\n`;
            msg += n.resumen;

            mensajes.push(msg);
            noticiaGlobal++;
        });
    });

    // Pie con canal
    if (hayNoticias) {
        mensajes.push(
            `${SEP}\n📲 Más info en nuestro canal:\nhttps://whatsapp.com/channel/0029Vb6Ml1x0gcfBHsUjPs06`
        );
    }

    return mensajes;
}

// ============================================================
// ENVIAR NOTICIAS AL GRUPO (USA SCRAPER)
// ============================================================
async function sendDailyNews(sock, isManual = false) {
    if (newsInProgress) {
        console.log("⚠️ Scraper ya en ejecución, ignorando solicitud duplicada.");
        return false;
    }

    newsInProgress = true;
    const label = isManual ? ' (Manual)' : '';
    console.log(`\n🗞️ Iniciando envío de noticias${label}...`);

    try {
        await sock.sendPresenceUpdate('composing', NEWS_GROUP_ID);

        const { resultados, fechasValidas } = await ejecutarScraper();

        const mensajes = formatearParaWhatsApp(resultados, fechasValidas);

        for (const msg of mensajes) {
            await sock.sendMessage(NEWS_GROUP_ID, { text: msg });
            await new Promise(resolve => setTimeout(resolve, 1500));
        }

        const timestamp = new Date().toLocaleTimeString('es-MX');
        const totalNoticias = resultados.reduce((acc, r) => acc + (r.noticias?.length || 0), 0);
        console.log(`✅ NOTICIAS ENVIADAS - ${timestamp}${label} (${totalNoticias} noticias)`);
        return true;

    } catch (err) {
        console.error(`❌ ERROR AL ENVIAR NOTICIAS: ${err.message}`);
        try {
            await sock.sendMessage(NEWS_GROUP_ID, {
                text: "⚠️ Hubo un problema al obtener las noticias. Se intentará en el siguiente horario."
            });
        } catch (e) { /* ignorar */ }
        return false;
    } finally {
        newsInProgress = false;
    }
}

// ============================================================
// PROGRAMAR NOTICIAS
// ============================================================
function scheduleNews(sock) {
    console.log("\n📅 HORARIOS DE NOTICIAS PROGRAMADOS:");
    NEWS_SCHEDULE.forEach(schedule => {
        console.log(`   ⏰ ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`);
    });
    console.log("");

    setInterval(() => {
        const now = new Date();
        const timeKey = `${now.toDateString()}-${now.getHours()}:${now.getMinutes()}`;
        const shouldSend = NEWS_SCHEDULE.some(s =>
            s.hour === now.getHours() && s.minute === now.getMinutes()
        );

        if (shouldSend && lastNewsSentKey !== timeKey) {
            lastNewsSentKey = timeKey;
            sendDailyNews(sock);
        }
    }, 30000);
}

// ============================================================
// CONEXIÓN PRINCIPAL
// ============================================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        browser: ['Ghost Bot', 'Chrome', '121.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
        getMessage: async () => undefined,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 60000,
        emitOwnEvents: false,
        fireInitQueries: true,
        shouldIgnoreJid: () => false,
        retryRequestDelayMs: 250
    });

    // Mantener conexión activa
    setInterval(() => {
        if (sock?.user) {
            sock.sendPresenceUpdate('available').catch(() => {});
        }
    }, 50000);

    sock.ev.on("connection.update", (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            latestQr = qr;
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === "open") {
            console.log("✅ BOT CONECTADO Y OPERATIVO");
            console.log("📰 Noticias via scraping (sin IA)");
            scheduleNews(sock);
        }

        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
            if (shouldReconnect) {
                console.log(`⚠️ Reconectando en 5s...`);
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log("❌ Sesión inválida. Elimina carpeta 'auth_info' y escanea QR de nuevo");
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

        // ── Grupo de noticias: solo escuchar comando manual ─────
        if (remoteJid === NEWS_GROUP_ID) {
            if (text.toLowerCase() === "@sendinstructionsnotice") {
                console.log("🔧 Comando manual recibido: Enviando noticias...");
                await sendDailyNews(sock, true);
            }
            return;
        }

        // ── Ignorar otros grupos ────────────────────────────────
        if (remoteJid.endsWith("@g.us")) return;

        // ── Mensajes privados: solo saludo inicial ──────────────
        const userPhone = remoteJid.split('@')[0];

        if (!firstTimeUsers.has(remoteJid)) {
            firstTimeUsers.add(remoteJid);
            const imagePath = './Imagenes2/Ghostcmd.png';
            const audioPath = './Vozcomandante.ogg';
            const welcomeText = "Saludos hermano¡ en estos momentos quiza me encuentro ocupado pero este es mi asistente digital, dime en que te puedo ayudar?";

            try {
                if (fs.existsSync(imagePath)) {
                    await sock.sendMessage(remoteJid, {
                        image: fs.readFileSync(imagePath),
                        caption: welcomeText
                    });
                } else {
                    await sock.sendMessage(remoteJid, { text: welcomeText });
                }

                await new Promise(resolve => setTimeout(resolve, 1000));

                if (fs.existsSync(audioPath)) {
                    await sock.sendMessage(remoteJid, {
                        audio: fs.readFileSync(audioPath),
                        mimetype: 'audio/ogg; codecs=opus',
                        ptt: true
                    });
                }

                console.log(`👤 Nuevo usuario saludado: ${userPhone}`);
            } catch (e) {
                console.log(`❌ Error enviando bienvenida a ${userPhone}: ${e.message}`);
            }
        }
        // Los mensajes siguientes de usuarios privados se ignoran
    });
}

// ============================================================
// INICIAR BOT
// ============================================================
console.log("🚀 Iniciando Ghost Bot...");
console.log("📰 Noticias: scraping directo (sin IA)");
console.log("👋 Privados: solo saludo inicial");
connectToWhatsApp();
