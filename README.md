# Spark — production v2

Эта версия добавляет запрошенный production слой.

## Что добавлено

### RBAC
`User.role = USER | MODERATOR | ADMIN`.
- `/api/admin/reports` — MODERATOR/ADMIN
- `/api/admin/photos*` — MODERATOR/ADMIN
- `/api/admin/users*` — только ADMIN
- изменение ролей — только ADMIN
- админ не может сам себя понизить через API.

Создание первого админа:
```bash
cd server
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='replace-me' npm run seed:admin
```

### Redis + очереди
BullMQ использует Redis для:
- email verification;
- password reset email;
- image moderation;
- push notification;
- push on match/message;
- account deletion.

Worker запускается отдельно и может горизонтально масштабироваться. BullMQ — Redis-backed queue system with retry/backoff and multiple workers. citeturn522780search2turn522780search6

### Socket.IO + Redis
API использует `@socket.io/redis-adapter`, поэтому несколько экземпляров API могут обмениваться событиями через общий Redis.

### Email verification
Регистрация:
1. создаёт пользователя без активной сессии;
2. создаёт одноразовый hashed verification token;
3. ставит email job в Redis;
4. worker отправляет письмо.

Login до подтверждения email запрещён.

### Password reset
- токен хранится только в hashed виде;
- TTL по env;
- после reset все refresh sessions отзываются;
- endpoint не раскрывает, существует ли email.

### Account deletion
`DELETE /api/me` только ставит удаление в очередь.
Worker:
- удаляет S3 objects пользователя;
- удаляет пользователя из PostgreSQL;
- Prisma relations с `onDelete: Cascade` удаляют связанные токены, лайки, сообщения, блокировки, жалобы, push subscriptions и preferences.

### PostGIS
PostgreSQL заменён на `postgis/postgis`.
В migration:
```sql
CREATE EXTENSION IF NOT EXISTS postgis;
ALTER TABLE "User" ADD COLUMN location geography(Point,4326);
CREATE INDEX ... USING GIST (location);
```

API:
`PUT /api/me/location` принимает latitude/longitude и сохраняет geography point.

Discovery использует:
`ST_DWithin(user.location, my.location, radiusMeters)`

Для `geography` PostGIS задаёт расстояния в метрах, а `ST_DWithin` может использовать пространственный индекс. citeturn864737search0turn864737search3

Prisma поддерживает PostgreSQL extensions через migration/extension mechanisms, а unsupported DB types можно хранить как `Unsupported(...)`. citeturn522780search0turn522780search4

## Запуск

```bash
docker compose up -d
npm install
npm run install:all

cp server/.env.example server/.env

cd server
npx prisma migrate dev --name production_v2
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='change-me-now' npm run seed:admin
cd ..

npm run dev
```

Frontend: `http://localhost:5173`
API: `http://localhost:4000`
PostgreSQL/PostGIS: `localhost:5432`
Redis: `localhost:6379`
MinIO: `localhost:9000`
MinIO Console: `http://localhost:9001`

## SMTP
Заполните:
```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM="Spark <no-reply@example.com>"
APP_BASE_URL=https://app.example.com
```

## Push
Сгенерируйте:
```bash
cd server
npx web-push generate-vapid-keys
```
Запишите private/public keys в server `.env`.

## Moderation
`moderate-photo` job вызывает `IMAGE_MODERATION_URL`. Если provider не настроен, фото остаётся `PENDING` и попадает в admin moderation queue.

Для настоящего production рекомендуется специализированный image safety provider + async workflow, а не блокирующая проверка внутри API.

## Production hardening
Перед публичным запуском:
- HTTPS + `COOKIE_SECURE=true`;
- отдельный Redis/Postgres/S3 secrets management;
- managed Postgres with PostGIS;
- Redis persistence/HA;
- S3 private bucket + signed URLs/CDN;
- real admin UI + audit logs;
- email domain authentication (SPF/DKIM/DMARC);
- antivirus/EXIF stripping/image resizing;
- monitoring/alerts;
- backups + tested restore;
- abuse/rate policy and moderation SLA;
- account deletion legal/data-retention policy;
- PostGIS coordinates should be coarse-grained if exact location privacy is a concern.


### Production migration
Для CI/CD используйте `npx prisma migrate deploy` — baseline migration уже входит в архив и создаёт PostGIS, таблицы, enum и GiST-индекс. Для первого локального запуска можно также использовать `npx prisma migrate deploy`.


## Recommended free deployment stack

Render Free for static frontend/API/worker; Supabase Free for PostgreSQL+PostGIS; Upstash Free for Redis; Cloudflare R2 for photos; Resend Free over HTTPS for transactional email. Render Free web services can sleep after 15 minutes and Render Free Postgres expires after 30 days, so the database should stay on Supabase.

Admin UI is available from the `Администрирование` menu for MODERATOR/ADMIN users.
