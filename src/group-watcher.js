// group-watcher.js — слушает выбранные группы WhatsApp и складывает документы и фото в папки Google Drive.
//
// Папка для каждой группы назначается ТОЛЬКО вручную — на странице https://<домен>/groups/<SECRET>.
// Через Claude (MCP) настройки можно только смотреть, менять нельзя.
//
// Подключено в src/index.js: createGroupWatcher(), watcher.attach(sock), watcher.handleHttp(), registerWatcherTools().

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

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

export function createGroupWatcher({ dataDir, secret, publicUrl, logger = console, timeZone = 'Asia/Makassar', downloadMedia }) {
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
    for (const [id, g] of Object.entries(state.groups)) if (!groups.some(x => x.id === id)) groups.push({ id, name: `${g.name} (нет в списке групп)` })
    groups.sort((a, b) => (state.groups[b.id] ? 1 : 0) - (state.groups[a.id] ? 1 : 0) || a.name.localeCompare(b.name))
    const drive = state.google?.refresh_token
      ? '✅ Google Drive подключён'
      : `⚠️ Google Drive не подключён — <a href="/gdrive/connect/${esc(secret)}">подключить</a>`
    const rows = groups.map(g => {
      const w = state.groups[g.id]
      const cur = w ? `<div class="cur">→ <a href="${esc(w.folderLink)}" target="_blank" rel="noreferrer">${esc(w.folderName)}</a> · сохранено: ${w.saved || 0}${w.paused ? ' · <b>пауза</b>' : ''}${w.lastError ? `<br><span class="err">Ошибка: ${esc(w.lastError.message)}</span>` : ''}</div>` : ''
      return `<form method="post" class="row"><input type="hidden" name="group_id" value="${esc(g.id)}">
<div class="name">${esc(g.name)}</div>${cur}
<div class="ctl"><input name="folder" placeholder="Ссылка на папку Google Drive" value="${w ? esc(w.folderLink || w.folderId) : ''}">
<button name="action" value="save">Сохранить</button>${w ? `<button name="action" value="${w.paused ? 'resume' : 'pause'}">${w.paused ? 'Возобновить' : 'Пауза'}</button><button name="action" value="remove" class="danger">Отключить</button>` : ''}</div></form>`
    }).join('')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Группы → папки</title>
<style>body{font:15px system-ui;max-width:760px;margin:24px auto;padding:0 16px;color:#222}h1{font-size:20px}.row{border:1px solid #ddd;border-radius:8px;padding:10px 12px;margin:8px 0}
.name{font-weight:600}.cur{margin:4px 0;color:#555}.ctl{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.ctl input{flex:1;min-width:200px;padding:6px}button{padding:6px 10px;cursor:pointer}
.danger{color:#b00}.msg{padding:8px 12px;border-radius:6px;background:#eef6ee}.msg.bad{background:#fbeaea}.err{color:#b00}</style>
<h1>Группы WhatsApp → папки Google Drive</h1><p>${drive}</p>
<p>Откройте нужную папку в Google Drive, скопируйте адрес из браузера, вставьте напротив группы и нажмите «Сохранить». Из группы будут сохраняться новые документы и фото.</p>
${msg ? `<p class="msg ${msg.bad ? 'bad' : ''}">${esc(msg.text)}</p>` : ''}${waError ? `<p class="msg bad">${esc(waError)}</p>` : ''}${rows}`)
  }

  async function handleSettingsPost(req) {
    const f = await readForm(req)
    const id = String(f.group_id || '')
    if (!id.endsWith('@g.us')) return { bad: true, text: 'Неверная группа' }
    const g = state.groups[id]
    if (f.action === 'remove') {
      if (!g) return { text: 'Группа и так не отслеживается' }
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
    try { name = (await sock?.groupMetadata(id))?.subject || name } catch {}
    state.groups[id] = { ...(g || {}), name: name || id, folderId: folder.id, folderName: folder.name, folderLink: folder.webViewLink, since: g?.since || new Date().toISOString(), paused: g?.paused || false }
    save()
    return { text: `«${state.groups[id].name}» → папка «${folder.name}»` }
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
    return msg.pushName || (msg.key.fromMe ? 'я' : (msg.key.participant || '').split('@')[0])
  }

  function onUpsert({ messages, type }) {
    if (type !== 'notify' && type !== 'append') return
    for (const msg of messages || []) {
      const jid = msg.key?.remoteJid
      const g = jid && state.groups[jid]
      if (!g || g.paused) continue
      const id = `${jid}|${msg.key.id}`
      if (seen.has(id)) continue
      const media = extractMedia(msg.message)
      if (!media) continue
      seen.add(id)
      queue.push({ msg, media, jid, tries: 0 })
    }
    pump()
  }

  async function downloadBuffer(msg) {
    if (downloadMedia) return downloadMedia(msg, sock)
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys')
    const quiet = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return quiet } }
    return downloadMediaMessage(msg, 'buffer', {}, { logger: quiet, reuploadRequest: m => sock.updateMediaMessage(m) })
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

  function attach(newSock) {
    sock = newSock
    sock.ev.on('messages.upsert', onUpsert)
  }

  // ---------- действия для MCP ----------

  return {
    attach,
    handleHttp,
    driveStatus() {
      return {
        google_drive_connected: !!state.google?.refresh_token,
        connect_url: state.google?.refresh_token ? undefined : `${baseUrl}/gdrive/connect/<SECRET>`,
        settings: 'Папки назначаются только вручную на странице /groups/<SECRET>',
        scope,
        watched_groups: Object.keys(state.groups).length,
        queue: queue.length,
      }
    },
    list() {
      return Object.entries(state.groups).map(([jid, g]) => ({
        group: g.name, group_id: jid, folder: g.folderName, folder_link: g.folderLink, paused: !!g.paused,
        files_saved: g.saved || 0, failed: g.failed || 0, last_file: g.lastFile || null, last_error: g.lastError || null,
      }))
    },
    // для тестов
    _onUpsert: onUpsert,
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
    'Какие группы WhatsApp отслеживаются, в какие папки Google Drive идут из них файлы, сколько сохранено и были ли ошибки. ' +
    'Только просмотр: назначать и менять папки может лишь сам пользователь на странице настроек /groups/<SECRET>.',
    {}, () => watcher.list())
}
