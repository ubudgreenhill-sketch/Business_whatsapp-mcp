// group-watcher.js — слушает выбранные группы и контакты WhatsApp и складывает документы и фото в папки Google Drive.
//
// Папка для каждой группы или контакта назначается ТОЛЬКО вручную — на странице https://<домен>/groups/<SECRET>.
// Через Claude (MCP) настройки можно только смотреть, менять нельзя.
//
// Подключено в src/index.js: createGroupWatcher(), watcher.attach(sock), watcher.handleHttp(), registerWatcherTools().

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { z } from 'zod'

const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true'
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const MAX_SEEN = 3000

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
}

// ---------- разбор сообщений ----------

/** Снимает обёртки (исчезающие, view-once, документ с подписью, редактирование). */
export function unwrapMessage(message) {
  let m = message
  for (let i = 0; i < 6 && m; i++) {
    const inner =
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.viewOnceMessageV2Extension?.message ||
      m.documentWithCaptionMessage?.message ||
      m.editedMessage?.message
    if (!inner) break
    m = inner
  }
  return m
}

/** Возвращает { kind, mimetype, fileName, caption } для документа или фото, иначе null. */
export function extractMedia(message) {
  const m = unwrapMessage(message)
  if (!m) return null
  if (m.documentMessage) {
    const d = m.documentMessage
    return { kind: 'document', mimetype: d.mimetype || 'application/octet-stream', fileName: d.fileName || d.title || null, caption: d.caption || '' }
  }
  if (m.imageMessage) {
    const im = m.imageMessage
    return { kind: 'image', mimetype: im.mimetype || 'image/jpeg', fileName: null, caption: im.caption || '' }
  }
  return null
}

export function safeName(s, max = 120) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** Имя файла в Drive: 2026-10-23_14-05_Иван_Invoice 123.pdf */
export function buildFileName({ ts, sender, media, msgId, tz = 'Asia/Makassar' }) {
  const d = new Date((Number(ts) || Date.now() / 1000) * 1000)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(d).map(p => [p.type, p.value]),
  )
  const stamp = `${parts.year}-${parts.month}-${parts.day}_${parts.hour === '24' ? '00' : parts.hour}-${parts.minute}`
  const ext = EXT_BY_MIME[media.mimetype?.split(';')[0]] || (media.mimetype?.split('/')[1]?.split(';')[0] ?? 'bin')
  let base
  if (media.fileName) base = media.fileName
  else if (media.caption) base = `${safeName(media.caption, 60)}.${ext}`
  else base = `${media.kind === 'image' ? 'photo' : 'file'}_${String(msgId).slice(-6)}.${ext}`
  return safeName(`${stamp}_${safeName(sender, 40) || 'unknown'}_${base}`, 200)
}

/** Достаёт ID папки из ссылки Google Drive или возвращает строку как есть. */
export function parseFolderId(input) {
  const s = String(input || '').trim()
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/)
  if (m) return m[1]
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s
  return null
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

async function readForm(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body // Express уже разобрал
  const chunks = []
  let size = 0
  for await (const c of req) { size += c.length; if (size > 64 * 1024) throw new Error('слишком большой запрос'); chunks.push(c) }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
}

// ---------- основной объект ----------

export function createGroupWatcher({ dataDir, secret, publicUrl, logger = console, timeZone = 'Asia/Makassar', downloadMedia, oldestKnown }) {
  if (!dataDir) throw new Error('group-watcher: dataDir обязателен')
  if (!secret) throw new Error('group-watcher: secret обязателен')
  const statePath = path.join(dataDir, 'group-watch.json')
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const scope = 'https://www.googleapis.com/auth/drive' // нужен, чтобы писать в ваши существующие папки
  const baseUrl = (publicUrl || process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/$/, '')
  const redirectUri = `${baseUrl}/gdrive/callback`

  let state = { google: null, groups: {}, seen: [] }
  try { state = { ...state, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) } } catch {}
  const seen = new Set(state.seen)
  let sock = null
  let accessToken = null
  let accessTokenExp = 0
  const pendingOAuth = new Map() // nonce -> expiry
  const queue = []
  let working = false

  function save() {
    state.seen = [...seen].slice(-MAX_SEEN)
    const tmp = statePath + '.tmp'
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
    fs.renameSync(tmp, statePath)
  }

  // ---------- Google OAuth / Drive ----------

  async function getAccessToken() {
    if (!state.google?.refresh_token) throw new Error('Google Drive не подключён. Откройте ' + `${baseUrl}/gdrive/connect/<SECRET>`)
    if (accessToken && Date.now() < accessTokenExp - 60_000) return accessToken
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: state.google.refresh_token, grant_type: 'refresh_token' }),
    })
    const j = await r.json()
    if (!r.ok) {
      if (j.error === 'invalid_grant') { state.google = null; save() }
      throw new Error(`Google token error: ${j.error || r.status} ${j.error_description || ''}`.trim())
    }
    accessToken = j.access_token
    accessTokenExp = Date.now() + (j.expires_in || 3600) * 1000
    return accessToken
  }

  async function driveJson(url, init = {}) {
    const token = await getAccessToken()
    const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` } })
    const text = await r.text()
    const j = text ? JSON.parse(text) : {}
    if (!r.ok) throw new Error(`Drive ${r.status}: ${j.error?.message || text.slice(0, 200)}`)
    return j
  }

  async function getFolder(id) {
    const f = await driveJson(`${DRIVE_FILES}/${encodeURIComponent(id)}?fields=id,name,mimeType,webViewLink&supportsAllDrives=true`)
    if (f.mimeType !== 'application/vnd.google-apps.folder') throw new Error(`${id} — это не папка`)
    return f
  }

  async function uploadFile({ folderId, name, mimetype, buffer, description }) {
    const boundary = 'wa' + crypto.randomBytes(12).toString('hex')
    const meta = JSON.stringify({ name, parents: [folderId], ...(description ? { description } : {}) })
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimetype}\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--`),
    ])
    return driveJson(DRIVE_UPLOAD, { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body })
  }

  // ---------- HTTP: подключение Google ----------

  function page(res, status, html) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;max-width:560px;margin:40px auto;padding:0 16px">${html}</body>`)
  }

  async function settingsPage(res, msg) {
    let groups = []
    let waError = ''
    try {
      if (!sock) throw new Error('WhatsApp ещё не подключён')
      groups = Object.values(await sock.groupFetchAllParticipating()).map(g => ({ id: g.id, name: g.subject || g.id }))
    } catch (e) { waError = String(e.message || e) }
    for (const [id, g] of Object.entries(state.groups)) if (g.kind !== 'contact' && !groups.some(x => x.id === id)) groups.push({ id, name: `${g.name} (нет в списке групп)` })
    groups.sort((a, b) => (state.groups[b.id] ? 1 : 0) - (state.groups[a.id] ? 1 : 0) || a.name.localeCompare(b.name))
    const contacts = Object.entries(state.groups).filter(([, g]) => g.kind === 'contact').map(([id, g]) => ({ id, name: `${g.name}${g.phone ? ` (+${g.phone})` : ''}` }))
    const drive = state.google?.refresh_token
      ? '✅ Google Drive подключён'
      : `⚠️ Google Drive не подключён — <a href="/gdrive/connect/${esc(secret)}">подключить</a>`
    const row = g => {
      const w = state.groups[g.id]
      const cur = w ? `<div class="cur">→ <a href="${esc(w.folderLink)}" target="_blank" rel="noreferrer">${esc(w.folderName)}</a> · сохранено: ${w.saved || 0}${w.paused ? ' · <b>пауза</b>' : ''}${w.lastError ? `<br><span class="err">Ошибка: ${esc(w.lastError.message)}</span>` : ''}</div>` : ''
      return `<form method="post" class="row"><input type="hidden" name="group_id" value="${esc(g.id)}">
<div class="name">${esc(g.name)}</div>${cur}
<div class="ctl"><input name="folder" placeholder="Ссылка на папку Google Drive" value="${w ? esc(w.folderLink || w.folderId) : ''}">
<button name="action" value="save">Сохранить</button>${w ? `<button name="action" value="${w.paused ? 'resume' : 'pause'}">${w.paused ? 'Возобновить' : 'Пауза'}</button><button name="action" value="remove" class="danger">Отключить</button>` : ''}</div></form>`
    }
    const addContact = `<form method="post" class="row"><input type="hidden" name="action" value="add_contact">
<div class="name">Добавить контакт</div>
<div class="ctl"><input name="phone" inputmode="tel" placeholder="Номер, напр. +62 812 3456 7890" style="min-width:180px"><input name="label" placeholder="Имя (необязательно)" style="min-width:140px"></div>
<div class="ctl"><input name="folder" placeholder="Ссылка на папку Google Drive"><button>Добавить</button></div></form>`
    const rows = `<h2>Контакты</h2>${contacts.map(row).join('')}${addContact}<h2>Группы</h2>${groups.map(row).join('') || '<p>Групп пока нет.</p>'}`
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Группы → папки</title>
<style>body{font:15px system-ui;max-width:760px;margin:24px auto;padding:0 16px;color:#222}h1{font-size:20px}h2{font-size:17px;margin:22px 0 6px}.row{border:1px solid #ddd;border-radius:8px;padding:10px 12px;margin:8px 0}
.name{font-weight:600}.cur{margin:4px 0;color:#555}.ctl{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.ctl input{flex:1;min-width:200px;padding:6px}button{padding:6px 10px;cursor:pointer}
.danger{color:#b00}.msg{padding:8px 12px;border-radius:6px;background:#eef6ee}.msg.bad{background:#fbeaea}.err{color:#b00}</style>
<h1>WhatsApp → папки Google Drive</h1><p>${drive}</p>
<p>Откройте нужную папку в Google Drive, скопируйте адрес из браузера, вставьте напротив группы или контакта и нажмите «Сохранить». Из этого чата будут сохраняться новые документы и фото (и входящие, и ваши).</p>
${msg ? `<p class="msg ${msg.bad ? 'bad' : ''}">${esc(msg.text)}</p>` : ''}${waError ? `<p class="msg bad">${esc(waError)}</p>` : ''}${rows}`)
  }

  async function handleSettingsPost(req) {
    const f = await readForm(req)
    if (f.action === 'add_contact') return addContact(f)
    const id = String(f.group_id || '')
    if (!/@(g\.us|s\.whatsapp\.net|lid)$/.test(id)) return { bad: true, text: 'Неверный чат' }
    const g = state.groups[id]
    if (f.action === 'remove') {
      if (!g) return { text: 'Чат и так не отслеживается' }
      delete state.groups[id]; save()
      return { text: `«${g.name}» больше не отслеживается` }
    }
    if (f.action === 'pause' || f.action === 'resume') {
      if (!g) return { bad: true, text: 'Сначала назначьте папку' }
      g.paused = f.action === 'pause'; save()
      return { text: `«${g.name}»: ${g.paused ? 'пауза' : 'возобновлено'}` }
    }
    const folderId = parseFolderId(f.folder)
    if (!folderId) return { bad: true, text: 'Не похоже на ссылку на папку Google Drive' }
    let folder
    try { folder = await getFolder(folderId) } catch (e) { return { bad: true, text: `Папка недоступна: ${e.message}` } }
    let name = g?.name
    if (id.endsWith('@g.us')) try { name = (await sock?.groupMetadata(id))?.subject || name } catch {}
    state.groups[id] = { ...(g || {}), kind: g?.kind || (id.endsWith('@g.us') ? 'group' : 'contact'), name: name || id, folderId: folder.id, folderName: folder.name, folderLink: folder.webViewLink, since: g?.since || new Date().toISOString(), paused: g?.paused || false }
    save()
    return { text: `«${state.groups[id].name}» → папка «${folder.name}»` }
  }

  async function addContact(f) {
    const phone = String(f.phone || '').replace(/[^\d]/g, '')
    if (phone.length < 7) return { bad: true, text: 'Укажите номер телефона в международном формате' }
    const folderId = parseFolderId(f.folder)
    if (!folderId) return { bad: true, text: 'Не похоже на ссылку на папку Google Drive' }
    if (!sock) return { bad: true, text: 'WhatsApp ещё не подключён' }
    let jid = `${phone}@s.whatsapp.net`
    try {
      const [r] = (await sock.onWhatsApp(phone)) || []
      if (r && !r.exists) return { bad: true, text: `Номер +${phone} не зарегистрирован в WhatsApp` }
      if (r?.jid) jid = r.jid
    } catch {}
    let lid = null
    try { lid = (await sock.signalRepository?.lidMapping?.getLIDForPN?.(jid)) || null } catch {}
    let folder
    try { folder = await getFolder(folderId) } catch (e) { return { bad: true, text: `Папка недоступна: ${e.message}` } }
    const g = state.groups[jid]
    const name = String(f.label || '').trim() || g?.name || `+${phone}`
    state.groups[jid] = { ...(g || {}), kind: 'contact', phone, lid: lid || g?.lid || null, name, folderId: folder.id, folderName: folder.name, folderLink: folder.webViewLink, since: g?.since || new Date().toISOString(), paused: g?.paused || false }
    save()
    return { text: `«${name}» → папка «${folder.name}»` }
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === `/groups/${secret}`) {
      let msg
      if (req.method === 'POST') {
        try { msg = await handleSettingsPost(req) } catch (e) { msg = { bad: true, text: String(e.message || e) } }
      }
      await settingsPage(res, msg)
      return true
    }
    if (url.pathname === `/gdrive/connect/${secret}`) {
      if (!clientId || !clientSecret) { page(res, 500, '❌ Не заданы GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET в Railway → Variables.'); return true }
      if (!baseUrl) { page(res, 500, '❌ Не удалось определить адрес сервиса. Задайте PUBLIC_URL в Railway → Variables.'); return true }
      const nonce = crypto.randomBytes(16).toString('hex')
      pendingOAuth.set(nonce, Date.now() + 10 * 60_000)
      const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope, access_type: 'offline', prompt: 'consent', state: nonce })
      res.writeHead(302, { location: `${AUTH_URL}?${q}` }); res.end()
      return true
    }
    if (url.pathname === '/gdrive/callback') {
      const nonce = url.searchParams.get('state')
      const exp = pendingOAuth.get(nonce)
      pendingOAuth.delete(nonce)
      if (!exp || exp < Date.now()) { page(res, 400, '❌ Ссылка устарела. Откройте /gdrive/connect/&lt;SECRET&gt; ещё раз.'); return true }
      if (url.searchParams.get('error')) { page(res, 400, `❌ Google: ${url.searchParams.get('error')}`); return true }
      const r = await fetch(TOKEN_URL, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
      })
      const j = await r.json()
      if (!r.ok || !j.refresh_token) { page(res, 400, `❌ Не получилось: ${j.error_description || j.error || 'нет refresh_token'}`); return true }
      state.google = { refresh_token: j.refresh_token, scope: j.scope, connected_at: new Date().toISOString() }
      accessToken = j.access_token; accessTokenExp = Date.now() + (j.expires_in || 3600) * 1000
      save()
      page(res, 200, `✅ Google Drive подключён. Теперь назначьте папки группам: <a href="/groups/${esc(secret)}">открыть настройки</a>`)
      return true
    }
    return false
  }

  // ---------- обработка входящих ----------

  function senderName(msg) {
    if (msg.key.fromMe) return 'я'
    return msg.pushName || (msg.key.participant || msg.key.remoteJid || '').split('@')[0]
  }

  const bare = j => (j ? String(j).replace(/:\d+@/, '@') : j)

  /** Ключ отслеживаемого чата для сообщения: группа, контакт по номеру или по LID. */
  async function watchedKey(key) {
    const cands = [key.remoteJid, key.remoteJidAlt].filter(Boolean).map(bare)
    for (const c of cands) if (state.groups[c]) return c
    for (const c of cands) {
      const hit = Object.entries(state.groups).find(([, g]) => g.kind === 'contact' && g.lid && bare(g.lid) === c)
      if (hit) return hit[0]
    }
    const lid = cands.find(c => c.endsWith('@lid'))
    if (lid && Object.values(state.groups).some(g => g.kind === 'contact')) {
      try {
        const pn = bare(await sock?.signalRepository?.lidMapping?.getPNForLID?.(lid))
        if (pn && state.groups[pn]) { state.groups[pn].lid = lid; return pn }
      } catch {}
    }
    return null
  }

  async function onUpsert({ messages, type }) {
    if (type !== 'notify' && type !== 'append') return
    for (const msg of messages || []) {
      if (!msg.key?.remoteJid || msg.key.remoteJid === 'status@broadcast') continue
      const media = extractMedia(msg.message)
      if (!media) continue
      const jid = await watchedKey(msg.key)
      const g = jid && state.groups[jid]
      if (!g || g.paused) continue
      const id = `${jid}|${msg.key.id}`
      if (seen.has(id)) continue
      seen.add(id)
      queue.push({ msg, media, jid, tries: 0 })
    }
    pump()
  }

  async function downloadBuffer(msg) {
    if (downloadMedia) return downloadMedia(msg, sock)
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys')
    const quiet = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return quiet } }
    const ctx = { logger: quiet, reuploadRequest: m => sock.updateMediaMessage(m) }
    try {
      return await downloadMediaMessage(msg, 'buffer', {}, ctx)
    } catch (e) {
      // старые файлы: ссылка на сервере WhatsApp истекла — просим телефон загрузить файл заново
      if (!sock?.updateMediaMessage) throw e
      const fresh = await sock.updateMediaMessage(msg)
      return downloadMediaMessage(fresh, 'buffer', {}, ctx)
    }
  }

  async function pump() {
    if (working) return
    working = true
    try {
      while (queue.length) {
        const job = queue.shift()
        const g = state.groups[job.jid]
        if (!g) continue
        try {
          const buffer = await downloadBuffer(job.msg)
          const name = buildFileName({ ts: job.msg.messageTimestamp, sender: senderName(job.msg), media: job.media, msgId: job.msg.key.id, tz: timeZone })
          const f = await uploadFile({ folderId: g.folderId, name, mimetype: job.media.mimetype, buffer, description: job.media.caption ? `Подпись: ${job.media.caption}` : undefined })
          g.saved = (g.saved || 0) + 1
          g.lastFile = { name: f.name, link: f.webViewLink, at: new Date().toISOString() }
          g.lastError = null
          logger.info?.(`[group-watcher] ${g.name}: сохранён ${f.name}`)
        } catch (e) {
          job.tries++
          g.lastError = { message: String(e.message || e), at: new Date().toISOString() }
          logger.error?.(`[group-watcher] ${g.name}: ошибка (${job.tries}) ${e.message}`)
          if (job.tries < 4) setTimeout(() => { queue.push(job); pump() }, 15_000 * job.tries)
          else g.failed = (g.failed || 0) + 1
        }
        save()
      }
    } finally { working = false }
  }

  // ---------- индекс файлов (для разовой выгрузки прошлых документов) ----------
  // Храним сами сообщения с документами и фото (без превью), чтобы потом их можно было скачать.
  const mediaPath = path.join(dataDir, 'media-index.json')
  const MAX_MEDIA_PER_CHAT = 800
  const reviver = (_, v) => (v && typeof v === 'object' && v.type === 'Buffer' && typeof v.data === 'string' ? Buffer.from(v.data, 'base64') : v)
  const replacer = (_, v) => (v && (Buffer.isBuffer(v) || v instanceof Uint8Array || v.type === 'Buffer') ? { type: 'Buffer', data: Buffer.from(v.data || v).toString('base64') } : v)
  let mediaIdx = { chats: {}, oldest: {} }
  try { mediaIdx = { chats: {}, oldest: {}, ...JSON.parse(fs.readFileSync(mediaPath, 'utf8'), reviver) } } catch {}
  let mediaTimer = null
  const historyWaiters = new Set()
  function saveMediaSoon() {
    if (mediaTimer) return
    mediaTimer = setTimeout(() => {
      mediaTimer = null
      try {
        fs.mkdirSync(dataDir, { recursive: true })
        fs.writeFileSync(mediaPath + '.tmp', JSON.stringify(mediaIdx, replacer))
        fs.renameSync(mediaPath + '.tmp', mediaPath)
      } catch (e) { logger.error?.(`[group-watcher] media index: ${e.message}`) }
    }, 3000)
  }
  function stripThumbs(o) {
    if (!o || typeof o !== 'object') return o
    for (const k of Object.keys(o)) {
      if (k === 'jpegThumbnail' || k === 'thumbnailSha256' || k === 'thumbnailEncSha256' || k === 'contextInfo') delete o[k]
      else if (o[k] && typeof o[k] === 'object' && !Buffer.isBuffer(o[k]) && !(o[k] instanceof Uint8Array)) stripThumbs(o[k])
    }
    return o
  }
  function indexMessages(messages) {
    let changed = false
    for (const msg of messages || []) {
      const chat = bare(msg?.key?.remoteJid)
      if (!chat || chat === 'status@broadcast' || !msg.key.id) continue
      const ts = Number(msg.messageTimestamp || 0)
      if (ts) {
        const o = mediaIdx.oldest[chat]
        if (!o || ts < o.ts) { mediaIdx.oldest[chat] = { ts, key: { remoteJid: msg.key.remoteJid, id: msg.key.id, fromMe: !!msg.key.fromMe } }; changed = true }
      }
      const media = extractMedia(msg.message)
      if (!media) continue
      const list = mediaIdx.chats[chat] || (mediaIdx.chats[chat] = {})
      if (list[msg.key.id]) continue
      let raw
      try { raw = stripThumbs(JSON.parse(JSON.stringify(msg, replacer), reviver)) } catch { continue }
      list[msg.key.id] = { ts, kind: media.kind, fileName: media.fileName, mimetype: media.mimetype, caption: media.caption, sender: senderName(msg), raw }
      const ids = Object.keys(list)
      if (ids.length > MAX_MEDIA_PER_CHAT) ids.sort((a, b) => list[a].ts - list[b].ts).slice(0, ids.length - MAX_MEDIA_PER_CHAT).forEach(id => delete list[id])
      changed = true
    }
    if (changed) saveMediaSoon()
  }

  async function resolveChat(chat) {
    const q = String(chat || '').trim()
    if (!q) throw new Error('Укажите чат')
    if (q.includes('@')) return bare(q)
    const digits = q.replace(/[^\d]/g, '')
    if (digits.length >= 7 && digits.length === q.replace(/[\s+()-]/g, '').length) return `${digits}@s.whatsapp.net`
    if (!sock) throw new Error('WhatsApp ещё не подключён')
    const all = Object.values(await sock.groupFetchAllParticipating())
    const low = q.toLowerCase()
    const exact = all.filter(g => (g.subject || '').toLowerCase() === low)
    const found = exact.length ? exact : all.filter(g => (g.subject || '').toLowerCase().includes(low))
    if (found.length === 1) return found[0].id
    throw new Error(found.length ? `Под «${q}» подходит несколько групп: ${found.slice(0, 8).map(g => `«${g.subject}» (${g.id})`).join(', ')}` : `Группа «${q}» не найдена. Передайте jid чата.`)
  }

  const toTs = (d, end) => {
    if (!d) return null
    const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T${end ? '23:59:59' : '00:00:00'}+08:00` : d)
    if (Number.isNaN(t)) throw new Error(`Не понимаю дату «${d}», нужен формат ГГГГ-ММ-ДД`)
    return Math.floor(t / 1000)
  }
  const fmt = ts => new Date(ts * 1000).toLocaleString('sv-SE', { timeZone }).slice(0, 16)

  function listFiles({ chatJid, since, until }) {
    const list = Object.entries(mediaIdx.chats[chatJid] || {})
      .filter(([, m]) => (!since || m.ts >= since) && (!until || m.ts <= until))
      .sort((a, b) => a[1].ts - b[1].ts)
    return list.map(([id, m]) => ({ message_id: id, date: fmt(m.ts), kind: m.kind === 'image' ? 'photo' : 'document', file_name: m.fileName, caption: m.caption || undefined, sender: m.sender, mimetype: m.mimetype }))
  }

  /** Подтягивает с телефона историю чата (порциями по 50 сообщений), пока не дойдёт до нужной даты. */
  async function fetchHistory(chatJid, sinceTs, maxRounds = 5) {
    if (!sock?.fetchMessageHistory) throw new Error('WhatsApp ещё не подключён')
    let rounds = 0
    for (; rounds < maxRounds; rounds++) {
      let o = mediaIdx.oldest[chatJid]
      const ext = oldestKnown?.(chatJid)
      if (ext?.ts && (!o || ext.ts < o.ts)) o = ext
      if (!o) throw new Error('Не найдено ни одного сообщения этого чата, от которого можно начать загрузку истории')
      if (o.ts <= sinceTs) break
      const before = o.ts
      const got = new Promise(resolve => {
        const w = msgs => { if ((msgs || []).some(m => bare(m?.key?.remoteJid) === chatJid)) { historyWaiters.delete(w); resolve(true) } }
        historyWaiters.add(w)
        setTimeout(() => { historyWaiters.delete(w); resolve(false) }, 20_000)
      })
      await sock.fetchMessageHistory(50, o.key, o.ts * 1000)
      const ok = await got
      await new Promise(r => setTimeout(r, 1500))
      const now = mediaIdx.oldest[chatJid]?.ts
      if (!ok || !now || now >= before) break
    }
    const o = mediaIdx.oldest[chatJid]
    return { rounds, oldest_message_date: o ? fmt(o.ts) : null, reached_requested_date: !!(o && o.ts <= sinceTs) }
  }

  async function exportFiles({ chatJid, ids, folder }) {
    const folderId = parseFolderId(folder)
    if (!folderId) throw new Error('Не похоже на ссылку на папку Google Drive')
    const f = await getFolder(folderId)
    const results = []
    for (const id of ids) {
      const m = mediaIdx.chats[chatJid]?.[id]
      if (!m) { results.push({ message_id: id, ok: false, error: 'нет в индексе — сначала list_chat_files' }); continue }
      try {
        const buffer = await downloadBuffer(m.raw)
        const name = buildFileName({ ts: m.ts, sender: m.sender, media: { kind: m.kind, mimetype: m.mimetype, fileName: m.fileName, caption: m.caption }, msgId: id, tz: timeZone })
        const up = await uploadFile({ folderId: f.id, name, mimetype: m.mimetype, buffer, description: m.caption ? `Подпись: ${m.caption}` : undefined })
        results.push({ message_id: id, ok: true, name: up.name, link: up.webViewLink })
      } catch (e) {
        results.push({ message_id: id, ok: false, file_name: m.fileName, error: String(e.message || e) })
      }
    }
    return { folder: f.name, folder_link: f.webViewLink, uploaded: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results }
  }

  function attach(newSock) {
    sock = newSock
    sock.ev.on('messages.upsert', e => { indexMessages(e?.messages); return onUpsert(e) })
    sock.ev.on('messaging-history.set', e => {
      indexMessages(e?.messages)
      for (const w of [...historyWaiters]) w(e?.messages)
    })
  }

  // ---------- действия для MCP ----------

  return {
    attach,
    handleHttp,
    driveStatus() {
      return {
        google_drive_connected: !!state.google?.refresh_token,
        connect_url: state.google?.refresh_token ? undefined : `${baseUrl}/gdrive/connect/<SECRET>`,
        settings: 'Папки для групп и контактов назначаются только вручную на странице /groups/<SECRET>',
        scope,
        watched_groups: Object.keys(state.groups).length,
        queue: queue.length,
      }
    },
    async listChatFiles({ chat, since, until, fetch_older }) {
      const chatJid = await resolveChat(chat)
      const s = toTs(since), u = toTs(until, true)
      let history
      if (fetch_older !== false && s) {
        try { history = await fetchHistory(chatJid, s) } catch (e) { history = { error: String(e.message || e) } }
      }
      const files = listFiles({ chatJid, since: s, until: u })
      const o = mediaIdx.oldest[chatJid]
      return { chat: chatJid, oldest_known_message: o ? fmt(o.ts) : null, history, count: files.length, files }
    },
    async exportChatFiles({ chat, message_ids, folder }) {
      const chatJid = await resolveChat(chat)
      return exportFiles({ chatJid, ids: message_ids, folder })
    },
    list() {
      return Object.entries(state.groups).map(([jid, g]) => ({
        chat: g.name, type: g.kind === 'contact' ? 'contact' : 'group', chat_id: jid, folder: g.folderName, folder_link: g.folderLink, paused: !!g.paused,
        files_saved: g.saved || 0, failed: g.failed || 0, last_file: g.lastFile || null, last_error: g.lastError || null,
      }))
    },
    // для тестов
    _onUpsert: onUpsert,
    _media: () => mediaIdx,
    _state: () => state,
  }
}

// ---------- регистрация инструментов MCP ----------

export function registerWatcherTools(server, watcher) {
  const reply = fn => async args => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await fn(args || {}), null, 2) }] } }
    catch (e) { return { isError: true, content: [{ type: 'text', text: String(e.message || e) }] } }
  }
  const reg = (name, description, shape, fn) =>
    typeof server.registerTool === 'function'
      ? server.registerTool(name, { description, inputSchema: shape }, reply(fn))
      : server.tool(name, description, shape, reply(fn))

  reg('drive_status', 'Подключён ли Google Drive и сколько групп отслеживается.', {}, () => watcher.driveStatus())

  reg('list_watched_groups',
    'Какие группы и контакты WhatsApp отслеживаются, в какие папки Google Drive идут из них документы и фото, сколько сохранено и были ли ошибки. ' +
    'Только просмотр: назначать и менять папки может лишь сам пользователь на странице настроек /groups/<SECRET>.',
    {}, () => watcher.list())

  reg('list_chat_files',
    'Список документов и фото в чате WhatsApp (группе или контакте) за период: дата, отправитель, имя файла, подпись, message_id. ' +
    'Если указан since, сначала подтягивает с телефона более старую историю чата (до 5 порций по 50 сообщений за вызов). Если history.reached_requested_date=false, вызовите ещё раз — загрузка продолжится. ' +
    'Используйте перед export_chat_files, чтобы выбрать нужные файлы (например, только инвойсы).',
    {
      chat: z.string().describe('jid чата (…@g.us, …@s.whatsapp.net), номер телефона или название группы'),
      since: z.string().optional().describe('С какой даты, ГГГГ-ММ-ДД (по времени Бали)'),
      until: z.string().optional().describe('По какую дату включительно, ГГГГ-ММ-ДД'),
      fetch_older: z.boolean().optional().describe('Подтягивать старую историю с телефона (по умолчанию да)'),
    },
    a => watcher.listChatFiles(a))

  reg('export_chat_files',
    'Разово скачать выбранные файлы из чата WhatsApp и загрузить их в указанную папку Google Drive. ' +
    'Вызывайте только по прямой просьбе пользователя в чате и только в папку, которую он сам назвал. ' +
    'Автоматические настройки сбора (страница /groups/<SECRET>) этот инструмент не меняет.',
    {
      chat: z.string().describe('Тот же чат, что в list_chat_files'),
      message_ids: z.array(z.string()).min(1).max(100).describe('message_id из list_chat_files'),
      folder: z.string().describe('Ссылка на папку Google Drive или её ID, которую назвал пользователь'),
    },
    a => watcher.exportChatFiles(a))
}
