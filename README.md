# WhatsApp Business MCP connector

Коннектор связывает Claude с **бизнес-аккаунтом WhatsApp** (приложение WhatsApp Business). Аккаунт привязывается по QR-коду, как WhatsApp Web.

Инструменты для Claude:

| Инструмент | Что делает |
|---|---|
| `whatsapp_status` | подключён ли WhatsApp |
| `search_contacts` | найти контакт, чат или группу по имени или части номера |
| `send_message` | отправить текст (Claude сначала показывает получателя и текст и ждёт вашего «да») |
| `get_recent_messages` | последние сообщения в чате |
| `list_recent_chats` | последние активные чаты |
| `drive_status` | подключён ли Google Drive |
| `list_watched_groups` | какие группы сохраняют файлы и в какие папки (только просмотр) |

Ещё коннектор сам сохраняет **документы и фото из выбранных групп** в назначенные папки Google Drive. Какая группа идёт в какую папку, назначаете только вы, вручную на странице `/groups/<SECRET>`. Claude эти настройки менять не может.

Подключение неофициальное: оно работает через протокол WhatsApp Web (библиотека Baileys). Не используйте его для массовых рассылок, иначе номер могут заблокировать.

## 1. Развёртывание на Railway

1. На railway.com откройте проект: **+ Create → GitHub Repo →** этот репозиторий.
2. На вкладке **Variables** добавьте:
   - `SECRET`: длинная случайная строка, минимум 16 символов. Она должна **отличаться** от SECRET личного коннектора.
   - `DATA_DIR` = `/data`
3. **Attach Volume**, Mount path `/data`. Это должен быть **отдельный** volume, не тот, что у личного коннектора.
4. **Settings → Networking → Generate Domain.** Регион можно выбрать Southeast Asia (Singapore).

## 2. Привязка WhatsApp Business

1. Откройте `https://<домен>/qr/<SECRET>`.
2. На телефоне откройте **WhatsApp Business → Настройки → Связанные устройства → Привязка устройства** и отсканируйте код.

## 3. Подключение к Claude

Claude → Settings → Connectors → Add custom connector:

- Name: `Business WA connector`
- URL: `https://<домен>/mcp/<SECRET>`

## 4. Файлы из групп → Google Drive

### 4.1. Google Cloud (один раз)

1. Откройте console.cloud.google.com и создайте проект, например «WA Business».
2. **APIs & Services → Library → Google Drive API → Enable.**
3. **Google Auth Platform (OAuth consent screen):** тип External, название приложения, ваш email.
   - **Data access → Add scopes** → `https://www.googleapis.com/auth/drive`.
   - **Audience → Publish app** (статус *In production*). В режиме Testing Google отзывает доступ каждые 7 дней.
4. **Clients → Create client → Web application.** В *Authorized redirect URIs* укажите `https://<домен>/gdrive/callback`.
5. В Railway → Variables добавьте `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET`.

### 4.2. Подключение Drive

Откройте `https://<домен>/gdrive/connect/<SECRET>` и войдите в Google.
Google покажет экран «Google hasn't verified this app»: нажмите **Advanced → Go to … → Continue**. Это ваше собственное приложение.

### 4.3. Назначение папок

1. Откройте `https://<домен>/groups/<SECRET>`. Там список всех групп аккаунта.
2. Откройте нужную папку в Google Drive и скопируйте адрес из браузера.
3. Вставьте его напротив группы и нажмите **Сохранить**.

На той же странице можно поставить группу на паузу или отключить её.

Как сохраняются файлы:

- Сохраняются **новые** документы и фото, пришедшие после назначения папки.
- Имя файла: `2026-10-23_14-05_Иван_Invoice 12.pdf` (дата и время по Бали, отправитель, исходное имя).
- Подпись к фото сохраняется в описании файла.
- Видео, голосовые и стикеры не сохраняются.

## Безопасность

- Кто знает SECRET, получает доступ к WhatsApp Business и к странице настроек. Держите репозиторий приватным и не публикуйте адреса.
- Отключить доступ можно в любой момент: в WhatsApp Business → Связанные устройства выйдите с этого устройства или поменяйте SECRET в Railway.
- Доступ к Google Drive отзывается на myaccount.google.com → Безопасность → Сторонние приложения.
