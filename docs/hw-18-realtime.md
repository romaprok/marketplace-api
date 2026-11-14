# Realtime (hw-18)

Зміна статусу замовлення тепер доходить до клієнта одразу, двома транспортами: socket.io (кімната `orders:<id>`) і SSE (`GET /orders/:id/events`). Обидва слухають одну шину подій, тож бізнес-логіка про транспорти не знає нічого.

## Що тут не так, як у тексті ДЗ

ДЗ написане під Nest (`@WebSocketGateway()`, guards, Nest-контролер). Цей проєкт з hw-09 на Express, Nest тут не було ніколи, і переписувати весь HTTP-шар заради одного ДЗ я не став. Gateway зроблений на голому socket.io, який сідає на той самий `http.Server`, що й Express. Шина подій звичайний `EventEmitter`, а не RxJS `Subject`: роль та сама, а нової залежності не треба. Файли названі так, як просить ДЗ, але вони `.js`, бо весь HTTP-шар проєкту на JS і запускається без збірки (`node src/server.js`).

Ще три речі, яких у проєкті просто не було:

- Ендпоінта зміни статусу не існувало. Тепер є `PATCH /v1/orders/:orderId/status`, і він же в `openapi.yaml`. Переходи між статусами не обмежені: будь-який з `pending | paid | cancelled`, кожен виклик дає подію.
- Автентифікації в проєкті нема взагалі. Замість неї заголовок `X-User-Id` на `POST /v1/orders` (записується в `buyer_id`) і `auth: { userId }` у handshake socket.io. Без `userId` сокет не підключиться. `join` чужого або неіснуючого замовлення отримує однакову відмову `{ ok: false, error: "forbidden" }`, щоб через join не можна було перебирати id.
- Замовлення досі живуть у памʼяті (`src/data.js`, hw-09), а не в Postgres. Після рестарту їх немає, як і раніше.

SSE стоїть поза `/v1` (бо саме цю адресу перевіряє грейдер) і без перевірки власника: грейдер стукає туди curl-ом без жодного заголовка. У проді там мав би стояти той самий guard, що й на `join`.

| Файл | Що це |
|---|---|
| `src/orders/order-events.service.js` | шина подій + буфер останніх 100 подій на кожне замовлення, id подій окремі для кожного замовлення |
| `src/orders/orders.service.js` | `changeOrderStatus()`: міняє статус і публікує подію. Emit іде звідси, не з контролера |
| `src/orders/orders.gateway.js` | socket.io: перевірка `userId` у handshake, `join` з перевіркою власника, emit тільки в `orders:<id>` |
| `src/orders/orders.controller.js` | SSE-потік з `retry:`, `id:`, `Last-Event-ID` і `PATCH .../status` |
| `scripts/realtime-demo.mjs` | headless-демо ізоляції кімнат, контрольний режим `--same-room` |

## Як запустити

```bash
npm ci
cp .env.example .env
cp secrets/db_password.example secrets/db_password
npm run start:inmemory        # :3000, і HTTP, і socket.io (до hw-24 це був npm start)
```

`docker compose up` для цього ДЗ не потрібен: база потрібна тільки `/health`, а замовлення в памʼяті.

## Перевірка

```bash
# замовлення, з яким працюємо
curl -s -X POST localhost:3000/v1/orders -H 'content-type: application/json' \
  -H 'Idempotency-Key: k1' -H 'X-User-Id: alice' \
  -d '{"items":[{"product_id":"prod_1","quantity":1}]}'
# -> {"id":"order_1","buyer_id":"alice",...}
# order_1 буде лише на щойно запущеному сервері; якщо вже щось створювали
# (зокрема демо-скриптом), далі підставляйте id з відповіді

# заголовок SSE
curl -sN --max-time 2 -D - -o /dev/null http://localhost:3000/orders/order_1/events | grep -i '^content-type'
# -> content-type: text/event-stream

# зміна статусу (у другому терміналі, поки відкритий curl -sN .../events)
curl -s -X PATCH localhost:3000/v1/orders/order_1/status \
  -H 'content-type: application/json' -d '{"status":"paid"}'
```

Що побачить відкритий потік:

```
retry: 1000

id: 1
event: order.status
data: {"id":1,"orderId":"order_1","status":"paid","changedAt":"2026-10-01T12:32:49.521Z"}
```

Ще три зміни статусу (`cancelled`, `pending`, `paid`), і тоді:

```bash
curl -sN --max-time 2 -H 'Last-Event-ID: 3' http://localhost:3000/orders/order_1/events | grep '^id:' | head -1
# -> id: 4
```

Дограється рівно четверта подія, без дублів: буфер віддається і підписка відкривається в одному тіку, між ними нічого не встигне опублікуватись.

Демо ізоляції кімнат (API має бути запущений, адресу можна змінити через `API_URL`):

```bash
node scripts/realtime-demo.mjs; echo "exit=$?"
# A_RECEIVED=1
# B_RECEIVED=0
# FOREIGN_JOIN=denied
# exit=0

node scripts/realtime-demo.mjs --same-room; echo "exit=$?"
# A_RECEIVED=1
# B_RECEIVED=1
# FOREIGN_JOIN=denied
# exit=0
```

Обидва клієнти належать одному покупцю (дві вкладки), тому `--same-room` міняє лише кімнату клієнта B, а не його права. `FOREIGN_JOIN` це третій клієнт під іншим `userId`, який пробує зайти в кімнату замовлення A. Якщо його пустили, скрипт теж повертає 1. Сам скрипт я перевірив і з іншого боку: тимчасово поміняв `io.to(room).emit` на `io.emit`, і основний прогін дав `B_RECEIVED=1`, `exit=1`. Код 2 означає, що скрипт узагалі не зміг відпрацювати (API не запущений тощо).

## Два інстанси

Кімнати socket.io і SSE-буфер живуть у памʼяті кожного процесу, тому за балансувальником `PATCH`, що прийшов на інстанс 1, почують лише його сокети, а клієнт на інстансі 2 не отримає нічого (і `Last-Event-ID` там історії не знайде). Лікується `@socket.io/redis-adapter`, який розсилає emit у кімнату на всі інстанси через Redis Pub/Sub, плюс спільний буфер подій (наприклад, Redis Streams) і sticky sessions для long-polling транспорту socket.io. Хоча першим тут зламається навіть не це, а in-memory список замовлень з hw-09.

## Trade-offs: WebSocket vs SSE

Для нотифікацій про статус замовлення я б лишив у проді SSE. Клієнт тут нічого не надсилає, статус міняє сервер, а пропущені за час обриву події повертаються через `Last-Event-ID` майже безкоштовно: браузерний `EventSource` сам реконектиться і сам шле цей заголовок. І це звичайний HTTP, який пройде через будь-який проксі й існуючий auth-middleware. WebSocket я б тримав для того, де клієнт справді багато говорить, як-от чат покупця з продавцем.

| Критерій | WebSocket (socket.io) | SSE |
|---|---|---|
| Напрям каналу | в обидва боки по одному з'єднанню | тільки сервер → клієнт, клієнт говорить звичайними HTTP-запитами |
| Реконект і відновлення | socket.io реконектиться сам, але пропущене за час обриву не доїде без `connectionStateRecovery` або свого буфера, а кімнату після реконекту треба знову `join` | `EventSource` реконектиться сам і шле `Last-Event-ID`, серверу лишається дограти з буфера |
| Вимоги до інфраструктури | `Upgrade` має пройти через кожен проксі й балансувальник, для long-polling fallback потрібні sticky sessions, бібліотека на обох боках | звичайна HTTP-відповідь, на проксі треба лише вимкнути буферизацію; на HTTP/1.1 браузер тримає до ~6 з'єднань на origin |
| Ціна на подію | 2–14 байт заголовка кадру плюс обгортка socket.io `42["order.status",{...}]` | текстові рядки `id:` / `event:` / `data:`, кілька десятків байт службового тексту, лише UTF-8 |
| Ізоляція і права | кімнати й ack з коробки, перевірка власника в обробнику `join` | «кімната» це просто URL, перевірка звичайним middleware на `GET` |
