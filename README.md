# Marketplace API — контракт спочатку

Це перше ДЗ курсового проєкту. Ідея проста: перед тим, як писати ендпоінти, ми спочатку домовляємось про контракт — пишемо OpenAPI-спеку, а потім робимо так, щоб код фізично не міг цей контракт порушити.

Домен — маркетплейс: `/products` (каталог) і `/orders` (замовлення). П'ять операцій, cursor-пагінація, Idempotency-Key на створенні замовлення і problem+json на всіх помилках — все те, про що була дев'ята лекція.

## Який варіант обрано

**Варіант Б — runtime-валідація на кордоні.**

Мінімальний Express-сервер, де `express-openapi-validator` валідує кожен запит і кожну відповідь проти `openapi/openapi.yaml`. Якщо хендлер спробує повернути щось, що не збігається зі схемою — впаде з помилкою ще до того, як відповідь піде клієнту. Спека тут не просто документація, а те, що реально контролює поведінку сервера.

## Структура

```
openapi/openapi.yaml   — контракт: 2 ресурси, 5 операцій, cursor-пагінація, Idempotency-Key, problem+json
src/
  app.js                — Express-застосунок + express-openapi-validator
  server.js             — точка входу (npm start)
  data.js               — in-memory "база" (products, orders)
  pagination.js         — cursor-пагінація (encode/decode курсору)
  problem.js            — RFC 9457 problem+json хелпери
  idempotency.js        — Idempotency-Key: replay / conflict / mismatch
test/
  app.test.mjs           — інтеграційні тести на всі сценарії нижче
```

## Швидкий старт

```bash
npm install
npm start
```

Сервер піднімається на `http://localhost:3000/v1`.

## Що можна перевірити руками

```bash
# Каталог товарів, cursor-пагінація
curl "http://localhost:3000/v1/products?limit=2"

# Товар за id
curl http://localhost:3000/v1/products/prod_1

# Створення замовлення без Idempotency-Key — 400, і це не if у коді,
# це спека каже валідатору, що заголовок required
curl -si -X POST http://localhost:3000/v1/orders \
  -H 'content-type: application/json' \
  -d '{"items":[{"product_id":"prod_1","quantity":1}]}'

# З ключем — 201 + Location
curl -si -X POST http://localhost:3000/v1/orders \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-key-1' \
  -d '{"items":[{"product_id":"prod_1","quantity":2}]}'

# Той самий ключ + те саме тіло — повертає той самий 201,
# але з заголовком Idempotency-Replay: true
curl -si -X POST http://localhost:3000/v1/orders \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-key-1' \
  -d '{"items":[{"product_id":"prod_1","quantity":2}]}'

# Той самий ключ, інше тіло — 422
curl -si -X POST http://localhost:3000/v1/orders \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-key-1' \
  -d '{"items":[{"product_id":"prod_2","quantity":1}]}'
```

Усі помилки повертаються в форматі `application/problem+json` (RFC 9457) — один парсер для будь-якого фейлу, без сюрпризів.

## Перевірка спеки

```bash
npm run lint:spec        # exit 0, warnings — ок, errors — ні
npm run bundle:spec      # збирає spec.json для подальших перевірок
```

## Тести

```bash
npm test
```

Ганяє інтеграційні тести проти живого застосунку (без mock'ів) — каталог, пагінація, валідація, ідемпотентність, 404/400/409/422.

## Чому саме так

- **Cursor, а не offset.** Offset-пагінація дрейфить, якщо між запитами хтось встиг щось додати чи видалити — ви або пропустите елемент, або побачите дублікат. Курсор — непрозорий токен, прив'язаний до конкретного елемента, тому дрейфу нема.
- **Idempotency-Key на POST /orders.** Мережа ненадійна, клієнти ретраять запити. Без ключа повторний ретрай = друге замовлення. З ключем — другий виклик з тим самим тілом просто повертає той самий результат.
- **problem+json скрізь.** Раніше типова ситуація — три різні формати помилки для трьох різних ендпоінтів, і клієнту доводиться писати парсер під кожен. Один формат — один парсер.
- **total_cents, а не total.** Ціна — ціле число в копійках/центах, не рядок-decimal і не float. Це рятує від купи болю з парсингом і округленням на клієнті.
- **express-openapi-validator, а не "довіряй та перевіряй".** Спека без валідатора — просто файл, який почне брехати після першого рефакторингу. Валідатор — це те, що фізично не дає коду розійтися з контрактом.
