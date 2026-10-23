// WhatsApp MCP connector for Claude.
// Links to your WhatsApp by QR code (like WhatsApp Web) and exposes tools to Claude:
// whatsapp_status, search_contacts, send_message, get_recent_messages, list_recent_chats,
// drive_status, list_watched_groups. Also saves documents/photos from chosen groups to Google Drive
// folders that the user assigns manually at /groups/<SECRET> (see src/group-watcher.js).

import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import pino from 'pino'
import QRCode from 'qrcode'
import { z } from 'zod'
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
  jidNormalizedUser,
  isJidGroup,
} from '@whiskeysockets/baileys'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createGroupWatcher, registerWatcherTools } from './group-watcher.js'

// ---------- config ----------
const PORT = Number(process.env.PORT || 3000)
const SECRET = process.env.SECRET || ''
const DATA_DIR = process.env.DATA_DIR || './data'
const AUTH_DIR = path.join(DATA_DIR, 'auth')
const STORE_FILE = path.join(DATA_DIR, 'store.json')
const MAX_MSGS_PER_CHAT = 40

if (!SECRET || SECRET.length < 16) {
  console.error('ERROR: set the SECRET environment variable to a random string of at least 16 characters.')
  process.exit(1)
}
fs.mkdirSync(AUTH_DIR, { recursive: true })

const log = pino({ level: process.env.LOG_LEVEL || 'info' })
const waLogger = pino({ level: 'warn' })

// ---------- group files -> Google Drive (folders are assigned manually at /groups/<SECRET>) ----------
const watcher = createGroupWatcher({
  dataDir: DATA_DIR,
  secret: SECRET,
  logger: log,
  // oldest message we know in a chat — starting point for loading older history from the phone
  oldestKnown: (jid) => {
    const m = (store.messages[jid] || [])[0]
    return m ? { ts: m.ts, key: { remoteJid: jid, id: m.id, fromMe: !!m.fromMe } } : null
  },
})

// ---------- local store (contacts, chats, recent messages) ----------
// keyed by canonical JID: phone JID (xxx@s.whatsapp.net) when known, otherwise lid/group JID
const store = { contacts: {}, chats: {}, messages: {}, lidToPn: {} }
try {
  Object.assign(store, JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')))
} catch {}

let saveTimer = null
function saveSoon() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    fs.writeFile(STORE_FILE + '.tmp', JSON.stringify(store), (err) => {
      if (!err) fs.rename(STORE_FILE + '.tmp', STORE_FILE, () => {})
    })
  }, 3000)
}

function canonical(jid) {
  if (!jid) return jid
  jid = jidNormalizedUser(jid)
  if (jid.endsWith('@lid') && store.lidToPn[jid]) return store.lidToPn[jid]
  return jid
}

function addLidMapping(lid, pn) {
  if (!lid || !pn) return
  lid = jidNormalizedUser(lid)
  pn = jidNormalizedUser(pn)
  if (store.lidToPn[lid] === pn) return
  store.lidToPn[lid] = pn
  // merge anything stored under the lid into the phone JID
  if (store.contacts[lid]) {
    store.contacts[pn] = { ...store.contacts[lid], ...(store.contacts[pn] || {}) }
    delete store.contacts[lid]
  }
  if (store.chats[lid]) {
    store.chats[pn] = { ...store.chats[lid], ...(store.chats[pn] || {}) }
    delete store.chats[lid]
  }
  if (store.messages[lid]) {
    store.messages[pn] = [...(store.messages[pn] || []), ...store.messages[lid]]
      .sort((a, b) => a.ts - b.ts)
      .slice(-MAX_MSGS_PER_CHAT)
    delete store.messages[lid]
  }
  saveSoon()
}

function upsertContact(c) {
  if (!c?.id) return
  if (c.lid && c.phoneNumber) addLidMapping(c.lid, c.phoneNumber)
  if (c.id.endsWith('@lid') && c.phoneNumber) addLidMapping(c.id, c.phoneNumber)
  const key = canonical(c.phoneNumber || c.id)
  const prev = store.contacts[key] || {}
  const next = { ...prev }
  for (const f of ['name', 'notify', 'verifiedName', 'username']) if (c[f]) next[f] = c[f]
  store.contacts[key] = next
  saveSoon()
}

function upsertChat(ch) {
  if (!ch?.id) return
  const key = canonical(ch.id)
  const prev = store.chats[key] || {}
  const ts = Number(ch.conversationTimestamp || ch.lastMessageRecvTimestamp || 0)
  store.chats[key] = {
    ...prev,
    ...(ch.name ? { name: ch.name } : {}),
    ...(ts > (prev.ts || 0) ? { ts } : {}),
  }
  saveSoon()
}

function messageText(m) {
  const msg = m.message
  if (!msg) return null
  const inner = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message || msg
  return (
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption && `[фото] ${inner.imageMessage.caption}` ||
    (inner.imageMessage && '[фото]') ||
    inner.videoMessage?.caption && `[видео] ${inner.videoMessage.caption}` ||
    (inner.videoMessage && '[видео]') ||
    (inner.audioMessage && '[голосовое/аудио]') ||
    (inner.documentMessage && `[документ] ${inner.documentMessage.fileName || ''}`.trim()) ||
    (inner.stickerMessage && '[стикер]') ||
    (inner.locationMessage && '[геолокация]') ||
    (inner.contactMessage && `[контакт] ${inner.contactMessage.displayName || ''}`.trim()) ||
    null
  )
}

function storeMessage(m) {
  const k = m.key
  if (!k?.remoteJid || k.remoteJid === 'status@broadcast') return
  if (k.remoteJidAlt) {
    if (k.remoteJid.endsWith('@lid')) addLidMapping(k.remoteJid, k.remoteJidAlt)
    else if (k.remoteJidAlt.endsWith('@lid')) addLidMapping(k.remoteJidAlt, k.remoteJid)
  }
  const text = messageText(m)
  if (!text) return
  const chat = canonical(k.remoteJid)
  const ts = Number(m.messageTimestamp || Date.now() / 1000)
  const list = store.messages[chat] || (store.messages[chat] = [])
  if (list.some((x) => x.id === k.id)) return
  list.push({
    id: k.id,
    fromMe: !!k.fromMe,
    sender: isJidGroup(chat) && !k.fromMe ? m.pushName || canonical(k.participant) : undefined,
    text: text.slice(0, 2000),
    ts,
  })
  list.sort((a, b) => a.ts - b.ts)
  if (list.length > MAX_MSGS_PER_CHAT) list.splice(0, list.length - MAX_MSGS_PER_CHAT)
  if (!k.fromMe && m.pushName && !isJidGroup(chat)) upsertContact({ id: chat, notify: m.pushName })
  upsertChat({ id: chat, conversationTimestamp: ts })
  saveSoon()
}

function displayName(jid) {
  const c = store.contacts[jid] || {}
  const ch = store.chats[jid] || {}
  return c.name || ch.name || c.verifiedName || c.notify || c.username || null
}

function phoneOf(jid) {
  return jid?.endsWith('@s.whatsapp.net') ? '+' + jid.split('@')[0] : null
}

function norm(s) {
  return (s || '').toString().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ё/g, 'е')
}

// ---------- voice-friendly name matching (Cyrillic <-> Latin, typos) ----------
const CYR2LAT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
}

// Reduce a name word to a script-independent "sound key", so that
// "Жилберт" ~ "Gilbert", "Красуля" ~ "Krasulia", "Хиралов" ~ "Хералов".
function soundKey(word) {
  let s = norm(word).replace(/[а-яёіїєґ]/g, (ch) => CYR2LAT[ch] ?? ch)
  s = s
    .replace(/[^a-z0-9]/g, '')
    .replace(/shch/g, 'sh')
    .replace(/sch/g, 'sh')
    .replace(/tch/g, 'ch')
    .replace(/ph/g, 'f')
    .replace(/th/g, 't')
    .replace(/kh/g, 'h')
    .replace(/ck/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/q/g, 'k')
    .replace(/w/g, 'v')
    .replace(/c(?!h)/g, 'k')
    .replace(/(yu|iu|ju)/g, 'u') // Юлия / Julia / Iuliia
    .replace(/(ya|ia|ja)/g, 'a') // Яна / Jana
    .replace(/(ye|ie)/g, 'e')
    .replace(/(dzh|dj|zh|j|g)/g, 'g') // Жильбер / Gilbert / Джон / John
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1') // double letters
  return s
}

function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      rowMin = Math.min(rowMin, cur[j])
    }
    if (rowMin > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

const allowedTypos = (len) => (len <= 3 ? 0 : len <= 6 ? 1 : 2)

// How well one spoken word matches one name word: 4 exact, 3 sounds alike, 2 prefix, 1 typo, 0 none
function wordScore(qWord, qKey, nWord, nKey) {
  if (qWord === nWord) return 4
  if (qKey && qKey === nKey) return 3
  if (qWord.length >= 2 && nWord.startsWith(qWord)) return 2
  if (qKey.length >= 3 && nKey.startsWith(qKey)) return 2
  const max = allowedTypos(qKey.length)
  if (max && editDistance(qKey, nKey, max) <= max) return 1
  return 0
}

const splitWords = (s) => norm(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean)

// ---------- WhatsApp connection ----------
let sock = null
let state = { connection: 'starting', qr: null, me: null, lastError: null }

async function connect() {
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  let version
  try {
    ;({ version } = await fetchLatestBaileysVersion())
  } catch {}

  sock = makeWASocket({
    version,
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, waLogger) },
    logger: waLogger,
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  })

  sock.ev.on('creds.update', saveCreds)
  watcher.attach(sock)

  sock.ev.on('connection.update', (u) => {
    if (u.qr) {
      state.qr = u.qr
      state.connection = 'waiting_for_qr'
      log.info(`QR ready — open /qr/${SECRET.slice(0, 3)}… in your browser and scan it`)
    }
    if (u.connection === 'open') {
      state.connection = 'open'
      state.qr = null
      state.me = sock.user
      state.lastError = null
      log.info({ me: sock.user?.id }, 'WhatsApp connected')
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode
      state.lastError = u.lastDisconnect?.error?.message || String(code)
      if (code === DisconnectReason.loggedOut) {
        log.warn('Logged out from phone — clearing session; a new QR will appear')
        fs.rmSync(AUTH_DIR, { recursive: true, force: true })
        fs.mkdirSync(AUTH_DIR, { recursive: true })
        state.connection = 'logged_out'
        state.me = null
        setTimeout(connect, 2000)
      } else {
        state.connection = 'reconnecting'
        log.warn({ code }, 'connection closed, reconnecting')
        setTimeout(connect, 3000)
      }
    }
  })

  sock.ev.on('lid-mapping.update', (m) => {
    for (const x of [].concat(m || [])) addLidMapping(x.lid, x.pn)
  })

  sock.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings }) => {
    for (const x of lidPnMappings || []) addLidMapping(x.lid, x.pn)
    for (const c of contacts || []) upsertContact(c)
    for (const ch of chats || []) upsertChat(ch)
    for (const m of messages || []) storeMessage(m)
  })
  sock.ev.on('contacts.upsert', (cs) => cs.forEach(upsertContact))
  sock.ev.on('contacts.update', (cs) => cs.forEach(upsertContact))
  sock.ev.on('chats.upsert', (cs) => cs.forEach(upsertChat))
  sock.ev.on('chats.update', (cs) => cs.forEach(upsertChat))
  sock.ev.on('messages.upsert', ({ messages }) => messages.forEach(storeMessage))
  sock.ev.on('groups.upsert', (gs) => gs.forEach((g) => upsertChat({ id: g.id, name: g.subject })))
  sock.ev.on('groups.update', (gs) => gs.forEach((g) => g.subject && upsertChat({ id: g.id, name: g.subject })))
}

function requireConnected() {
  if (state.connection !== 'open' || !sock) {
    throw new Error(
      `WhatsApp не подключён (статус: ${state.connection}). Откройте страницу /qr/<SECRET> на сервере и отсканируйте QR-код в WhatsApp → Связанные устройства.`
    )
  }
}

async function resolveRecipient(to) {
  to = String(to).trim()
  if (to.includes('@')) return canonical(to)
  const digits = to.replace(/[^\d]/g, '')
  if (digits.length < 7) {
    // treat as a name: must match exactly one contact, and not just by a fuzzy guess
    const hits = searchContacts(to, 5).filter((h) => h.match !== 'fuzzy')
    if (hits.length === 1) return hits[0].jid
    throw new Error(
      hits.length
        ? `Имя "${to}" подходит нескольким контактам: ${hits.map((h) => `${h.name} (${h.phone || h.jid})`).join('; ')}. Укажите номер или jid.`
        : `Контакт "${to}" не найден. Укажите номер телефона в международном формате.`
    )
  }
  const [res] = await sock.onWhatsApp(digits)
  if (!res?.exists) throw new Error(`Номер +${digits} не зарегистрирован в WhatsApp.`)
  return canonical(res.jid)
}

const MATCH_LABEL = { 4: 'exact', 3: 'sounds_like', 2: 'prefix', 1: 'fuzzy' }

function searchContacts(query, limit = 10) {
  const q = norm(query)
  const qDigits = query.replace(/[^\d]/g, '')
  const qWords = splitWords(query).filter((w) => !/^\d+$/.test(w))
  const qKeys = qWords.map(soundKey)
  const ids = new Set([...Object.keys(store.contacts), ...Object.keys(store.chats)])
  const out = []
  for (const jid of ids) {
    if (jid === 'status@broadcast') continue
    const c = store.contacts[jid] || {}
    const ch = store.chats[jid] || {}
    const names = [c.name, ch.name, c.notify, c.verifiedName, c.username].filter(Boolean)
    const phone = phoneOf(jid)
    let score = 0
    let match = null
    if (qWords.length) {
      const nWords = [...new Set(names.flatMap(splitWords))]
      const nKeys = nWords.map(soundKey)
      // every spoken word must match some word of the contact's names
      let total = 0
      let worst = 4
      for (let i = 0; i < qWords.length; i++) {
        let best = 0
        for (let j = 0; j < nWords.length && best < 4; j++) best = Math.max(best, wordScore(qWords[i], qKeys[i], nWords[j], nKeys[j]))
        if (!best) {
          total = 0
          break
        }
        total += best
        worst = Math.min(worst, best)
      }
      if (total) {
        const fullExact = names.some((n) => norm(n) === q)
        score = (fullExact ? 100 : 0) + total * 10 + worst
        match = fullExact ? 'exact' : MATCH_LABEL[worst]
      }
    }
    if (qDigits.length >= 4 && phone && phone.includes(qDigits) && score < 50) {
      score = 50
      match = 'phone'
    }
    if (!score) continue
    out.push({
      jid,
      name: displayName(jid),
      saved_name: c.name || null,
      whatsapp_name: c.notify || c.verifiedName || null,
      phone,
      is_group: isJidGroup(jid) || false,
      last_activity: ch.ts ? new Date(ch.ts * 1000).toISOString() : null,
      match,
      _score: score,
      _ts: ch.ts || 0,
    })
  }
  out.sort((a, b) => b._score - a._score || b._ts - a._ts)
  return out.slice(0, limit).map(({ _score, _ts, ...r }) => r)
}

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] })
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: String(e?.message || e) }] })

// ---------- MCP server ----------
function buildMcpServer() {
  const server = new McpServer({ name: 'whatsapp-business', version: '1.0.0' })

  server.registerTool(
    'whatsapp_status',
    {
      title: 'WhatsApp status',
      description: 'Check whether the WhatsApp account is linked and connected, and how many contacts/chats are known.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      ok({
        connection: state.connection,
        account: state.me ? { id: state.me.id, name: state.me.name } : null,
        known_contacts: Object.keys(store.contacts).length,
        known_chats: Object.keys(store.chats).length,
        last_error: state.lastError,
      })
  )

  server.registerTool(
    'search_contacts',
    {
      title: 'Search WhatsApp contacts',
      description:
        'Find WhatsApp contacts, chats and groups by name (saved name or WhatsApp profile name, any language) or by part of a phone number. Returns jid, name and phone. Use this before send_message to find the right recipient.',
      inputSchema: {
        query: z.string().min(1).describe('Name or part of a phone number, e.g. "Ivan", "Иван Петров", "8123"'),
        limit: z.number().int().min(1).max(30).optional().describe('Max results, default 10'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      try {
        const results = searchContacts(query, limit || 10)
        return ok({ query, count: results.length, results })
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'send_message',
    {
      title: 'Send WhatsApp message',
      description:
        "Send a text message from the user's own WhatsApp. `to` can be a jid from search_contacts, a phone number in international format (e.g. +6281234567890), or an exact contact name. IMPORTANT: before calling, show the user the recipient (name + number) and the exact text, and send only after they explicitly confirm.",
      inputSchema: {
        to: z.string().min(1).describe('jid, international phone number, or exact contact name'),
        text: z.string().min(1).max(4000).describe('Message text'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ to, text }) => {
      try {
        requireConnected()
        const jid = await resolveRecipient(to)
        const sent = await sock.sendMessage(jid, { text })
        if (sent) storeMessage(sent)
        return ok({ sent: true, to: jid, name: displayName(jid), phone: phoneOf(jid), message_id: sent?.key?.id })
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'get_recent_messages',
    {
      title: 'Read recent messages in a chat',
      description:
        'Read the most recent messages in one chat (messages received or sent since the server was linked, plus the recent history WhatsApp synced at linking). `chat` is a jid, phone number or exact contact name.',
      inputSchema: {
        chat: z.string().min(1).describe('jid, phone number or exact contact name'),
        limit: z.number().int().min(1).max(MAX_MSGS_PER_CHAT).optional().describe('Default 15'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ chat, limit }) => {
      try {
        let jid
        if (chat.includes('@')) jid = canonical(chat)
        else if (chat.replace(/[^\d]/g, '').length >= 7) jid = canonical(chat.replace(/[^\d]/g, '') + '@s.whatsapp.net')
        else {
          requireConnected()
          jid = await resolveRecipient(chat)
        }
        const msgs = (store.messages[jid] || []).slice(-(limit || 15)).map((m) => ({
          from: m.fromMe ? 'me' : m.sender || displayName(jid) || phoneOf(jid) || jid,
          text: m.text,
          time: new Date(m.ts * 1000).toISOString(),
        }))
        return ok({ chat: jid, name: displayName(jid), phone: phoneOf(jid), messages: msgs })
      } catch (e) {
        return fail(e)
      }
    }
  )

  server.registerTool(
    'list_recent_chats',
    {
      title: 'List recent chats',
      description: 'List the most recently active WhatsApp chats with the last message preview.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe('Default 15') },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const chats = Object.entries(store.chats)
        .filter(([jid, c]) => c.ts && jid !== 'status@broadcast')
        .sort((a, b) => b[1].ts - a[1].ts)
        .slice(0, limit || 15)
        .map(([jid, c]) => {
          const last = (store.messages[jid] || []).at(-1)
          return {
            jid,
            name: displayName(jid),
            phone: phoneOf(jid),
            is_group: isJidGroup(jid) || false,
            last_activity: new Date(c.ts * 1000).toISOString(),
            last_message: last ? `${last.fromMe ? 'me' : 'them'}: ${last.text.slice(0, 120)}` : null,
          }
        })
      return ok({ chats })
    }
  )

  registerWatcherTools(server, watcher)

  return server
}

// ---------- HTTP ----------
const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false, limit: '64kb' }))
app.use(async (req, res, next) => {
  try {
    if (await watcher.handleHttp(req, res)) return
  } catch (e) {
    return next(e)
  }
  next()
})

app.get('/', (_req, res) => res.type('text').send('WhatsApp Business MCP connector is running.'))
app.get('/health', (_req, res) => res.json({ ok: true, connection: state.connection }))

app.get(`/qr/${SECRET}`, async (_req, res) => {
  let body
  if (state.connection === 'open') {
    body = `<h2>✅ WhatsApp подключён</h2><p>${state.me?.name || ''} ${state.me?.id?.split(':')[0] || ''}</p>`
  } else if (state.qr) {
    const img = await QRCode.toDataURL(state.qr, { width: 320, margin: 2 })
    body = `<h2>Отсканируйте QR-код</h2>
      <p>WhatsApp на телефоне → Настройки → Связанные устройства → Привязка устройства</p>
      <img src="${img}" alt="QR" /><p style="color:#888">Код обновляется автоматически.</p>
      <p>Не получается отсканировать? <a href="/pair/${SECRET}">Привязать по номеру телефона</a></p>`
  } else {
    body = `<h2>Подождите…</h2><p>Статус: ${state.connection}</p>`
  }
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="refresh" content="${state.connection === 'open' ? 30 : 8}">
    <title>WhatsApp link</title>
    <style>body{font-family:system-ui,sans-serif;text-align:center;padding:24px;background:#fff;color:#111}</style>
    </head><body>${body}</body></html>`)
})

// Link by phone number (pairing code) — alternative to the QR code
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
app.get(`/pair/${SECRET}`, async (req, res) => {
  const phone = String(req.query.phone || '').replace(/[^\d]/g, '')
  let body
  if (state.connection === 'open') {
    body = `<h2>✅ WhatsApp подключён</h2><p>${escHtml(state.me?.name || '')} ${escHtml(state.me?.id?.split(':')[0] || '')}</p>`
  } else if (!phone) {
    body = `<h2>Привязка по номеру телефона</h2>
      <form method="get"><p>Номер WhatsApp Business в международном формате, только цифры:</p>
      <input name="phone" inputmode="numeric" placeholder="6281234567890" style="font-size:20px;padding:8px;width:260px">
      <p><button style="font-size:18px;padding:8px 16px">Получить код</button></p></form>`
  } else if (!sock || !state.qr) {
    body = `<h2>Подождите…</h2><p>Статус: ${escHtml(state.connection)}. Обновите страницу через несколько секунд.</p>`
  } else {
    try {
      const code = await sock.requestPairingCode(phone)
      const pretty = String(code).replace(/^(.{4})(.{4})$/, '$1-$2')
      body = `<h2>Код привязки</h2><p style="font-size:44px;letter-spacing:6px;font-weight:700">${escHtml(pretty)}</p>
        <p>На телефоне: WhatsApp Business → Настройки → Связанные устройства → Привязка устройства →
        <b>«Привязать по номеру телефона»</b> (внизу экрана сканера) и введите этот код.</p>
        <p style="color:#888">Код действует около минуты. Если не успели — обновите страницу.</p>
        <p><a href="/qr/${encodeURIComponent(SECRET)}">Проверить статус</a></p>`
    } catch (e) {
      body = `<h2>Ошибка</h2><p>${escHtml(e?.message || e)}</p><p>Обновите страницу и попробуйте ещё раз.</p>`
    }
  }
  res.set('cache-control', 'no-store').type('html').send(`<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp pairing</title>
    <style>body{font-family:system-ui,sans-serif;text-align:center;padding:24px;background:#fff;color:#111}</style>
    </head><body>${body}</body></html>`)
})

app.post(`/mcp/${SECRET}`, async (req, res) => {
  try {
    const server = buildMcpServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      transport.close()
      server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (e) {
    log.error(e)
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
  }
})
app.all(`/mcp/${SECRET}`, (_req, res) =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
)

app.listen(PORT, () => log.info(`HTTP listening on :${PORT}`))
connect().catch((e) => {
  log.error(e, 'failed to start WhatsApp')
  state.lastError = String(e)
})
