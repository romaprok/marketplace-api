# Async-події через RabbitMQ (hw-19)

Цей розділ описує стан на hw-19. З hw-22 `placeOrder()` більше не публікує напряму, подія йде через outbox і relay (розділ «Outbox та ідемпотентність» нижче), а консюмер дедуплікує ще й через `processed_messages`.

Realtime з hw-18 доставляє лише тим, хто підключений зараз. Тут між сервісом і його читачами з'являється брокер, який тримає повідомлення, поки читач не прийде. Замовлення оформлюється тим самим `checkout()` з hw-14, після COMMIT публікується `order.placed`, а склад (окремий споживач) створює для замовлення запит на збирання в таблиці `fulfillments`. Якщо склад у цей момент лежить, подія чекає в черзі.

```
placeOrder() ─► checkout() COMMIT ─► publish order.placed, чекаємо confirm
                                          │
                             shop.events (topic)
              order.placed ───────────────┼────────────── будь-що інше
                    ▼                                          ▼
   warehouse.order-placed (quorum, delivery-limit 3)    shop.unrouted (alternate exchange)
     споживач: INSERT fulfillments ON CONFLICT DO NOTHING → ack
     помилка: reject(requeue) → після 4-ї доставки ─► shop.dlx ─► warehouse.order-placed.dlq
```

| Файл | Що там |
|---|---|
| `src/messaging/topology.ts` | exchange, черги, binding, DLX і DLQ, alternate exchange. Викликає споживач або демо, продюсер про це не знає |
| `src/messaging/order-placed.event.ts` | контракт події і перевірка вхідного тіла |
| `src/messaging/publisher.ts` | публікація через confirm-канал (`waitForConfirms`) |
| `src/messaging/order-placed.consumer.ts` | ручний ack після ефекту, `prefetch`, ідемпотентний ефект |
| `src/place-order.ts` | `checkout()` + публікація |
| `src/consumer.ts` | споживач як окремий процес (`npm run consumer`) |
| `src/entities/Fulfillment.ts`, `src/migrations/*AddFulfillments*` | таблиця ефекту |
| `src/demo-*.ts` | три демо, кожне саме чистить черги і свої дані з минулих прогонів |

Подія виглядає так. Це окремо спроектований контракт, а не ORM-сутність, розгорнута в JSON:

```json
{
  "eventId": "order.placed:5f0c…",
  "type": "order.placed",
  "version": 1,
  "occurredAt": "2026-10-01T13:20:11.402Z",
  "data": { "orderId": "5f0c…", "buyerId": "…", "productId": "…", "quantity": 1, "total": 10, "currency": "UAH" }
}
```

`eventId` виводиться з `orderId`, а не генерується щоразу заново. Замовлення оформлюється один раз, тож якщо продюсер колись перепублікує ту саму подію, вона прийде з тим самим id.

## Що показали три прогони

Чистий volume, `npm ci`, далі три команди підряд. Числа з моєї машини:

```
demo:publish                demo:dlq                      demo:duplicate
published=5                 rejected=4                    published=1
delivered=5                 deliveries=4                  killed=1
effect=5                    delivery-limit=3              deliveries=2
acked=5                     work=0                        redelivered=1
work=0                      dlq=1                         effect=1
dlq=0                       dlq-reason=delivery_limit     skipped=1
prefetch=20                 effect=0                      fulfillment-rows=1
fulfillment-rows=5          fulfillment-rows=0            work=0
effect-ms-avg=2.2                                         dlq=0
```

У `demo:dlq` отруєна подія коректна за формою, але посилається на замовлення, якого не існує. FK на `fulfillments` відмовляє щоразу, споживач робить `reject(requeue=true)`, і після четвертої доставки (перша плюс три повтори при `x-delivery-limit=3`) брокер відправляє її в DLQ. Причину демо читає із заголовка `x-first-death-reason`, у `x-death` там `reason=delivery_limit count=1`. Тіло, яке взагалі не парситься, споживач відхиляє одразу з `requeue=false`, бо повтор йому не допоможе. Причина тоді буде `rejected`.

Дубль у `demo:duplicate` я викликаю справжнім падінням. Споживач запускається окремим процесом, застосовує ефект, і перед ack вбиває сам себе `SIGKILL`. ОС закриває сокет, брокер бачить обрив і повертає повідомлення в чергу. Другий, здоровий споживач отримує його з `redelivered=true`, `INSERT` нічого не вставляє, і повідомлення просто підтверджується. `channel.close()` для цього не підходить, бо це коректне завершення, а не те, як падає под о третій ночі.

Демо перевіряють себе ще й з іншого боку. Я тимчасово робив ефект неідемпотентним (`ON CONFLICT DO UPDATE`), і `demo:duplicate` показав `effect=2` та впав з exit 1. З `noAck: true` він показав `deliveries=1`: під autoAck повідомлення зникає в момент доставки, повертати нічого.

## Чому prefetch=20

Ефект займає один `INSERT`, в середньому 1–2 мс (`effect-ms-avg`). З `prefetch=1` споживач після кожного ack простоював би на мережевий round trip. З дефолтним 0 ліміту немає взагалі, і перший споживач забрав би всю чергу. Перевірка за формулою `prefetch × час обробки < consumer_timeout`: 20 × 2 мс ≈ 40 мс, і навіть якщо обробка колись стане секундною, 20 с проти стокових 30 хвилин. Брати більше, наприклад 2000, теж не варто. Якщо один із двох споживачів почне гальмувати, усі ці повідомлення висітимуть на ньому, поки другий простоює.

## At-least-once, а не exactly-once

RabbitMQ обіцяє одне: повідомлення без ack повернеться в чергу. Ack означає «я більше не вимагаю повтору», і він може загубитися вже після того, як ефект застосовано. Саме це `demo:duplicate` робить навмисно. Тому доставка тут at-least-once, і `deliveries=2` в демо це підтверджує. Exactly-once доставки не дає ні RabbitMQ, ні будь-який інший брокер.

Результат при цьому один, бо ефект ідемпотентний. Одне замовлення — один запит на збирання: `INSERT INTO fulfillments … ON CONFLICT (order_id) DO NOTHING`, де `order_id` первинний ключ. Повторна доставка впирається в ключ і нічого не змінює (`effect=1`, `skipped=1`). Ідемпотентність тут властивість самої операції, вона дісталась від природного ключа. Тому ні окремий ключ ідемпотентності, ні таблиця оброблених id не знадобились. Дедуп у `Set` у пам'яті процесу не пережив би рестарт, а таблиця в Postgres переживе. At-least-once доставка плюс ідемпотентний ефект дають exactly-once результат.

## Що лишилось відкритим

- Публікація йде після COMMIT, і спільної транзакції між Postgres і RabbitMQ нема. Якщо процес впаде між ними, замовлення буде, а події ні. Закрито transactional outbox у hw-22.
- Щілини «позначив оброблене, а ефекту ще нема» тут немає, бо позначка і ефект — це той самий `INSERT`. Вона з'явиться, щойно ефект стане зовнішнім (лист, платіж). Тоді позначка і ефект мають іти одним COMMIT, це `processed_messages` з hw-22, де так і зроблено.
- Dead-lettering за замовчуванням at-most-once: брокер перепубліковує в DLX без confirm, і якщо DLQ недоступна, повідомлення губиться. Стратегія `dead-letter-strategy: at-least-once` працює тільки в парі з `overflow: reject-publish`. Без неї політика приймається, але брокер мовчки відкочується на at-most-once і пише про це лише в лог. Це з документації і з прогону в коді лекції, сам я цього не відтворював. Для ДЗ лишив дефолт.
- `reject` і `nack` з `requeue=true` поводяться по-різному. Я перевірив на двох версіях. На 4.2.9 обидва доходять до delivery-limit за ті ж 4 доставки. На 4.3.4 `nack` delivery-count не збільшує: 9357 доставок за 20 секунд і нічого в DLQ. Тому споживач робить `reject`, і апгрейд на 4.3 його не зламає.
- Повідомлення з routing key, на який ніхто не підписаний, брокер підтверджує позитивним confirm і викидає. Від цього стоїть alternate exchange `shop.unrouted`. Перевірив: опублікував `order.refunded`, confirm прийшов, повідомлення лежить у `shop.unrouted`.
- Якщо брокер скасує споживача (видалили чергу або пробито `consumer_timeout`), у callback приходить `null`. Споживач на це виходить з кодом 1, а не робить вигляд, що живий.

RabbitMQ 4.2.9, бо це LTS-гілка з підтримкою до 30.06.2030. 4.3 поточна, але підтримка в неї до 30.04.2028. Черга quorum, DLQ classic: у quorum-DLQ свій дефолтний delivery-limit, і оператор, який розглядає її через `get` + `nack`, міг би випадково вичерпати ліміт і загубити повідомлення.

Перед демо зупиніть `npm run consumer`, якщо він запущений. Він теж слухає `warehouse.order-placed` і забере частину повідомлень, тож числа демо попливуть.

## Grading (hw-19: RabbitMQ)

```bash
docker compose up -d --wait

export DB_URL=postgres://marketplace@127.0.0.1:6432/marketplace
export DB_PASSWORD_FILE=secrets/db_password.example
export BROKER_URL=amqp://marketplace:dev_local_only_changeme@127.0.0.1:5672
export SKIP_VAULT=1    # у грейдера немає доступу до сховища

npm ci

npm run demo:publish
npm run demo:dlq
npm run demo:duplicate
```

`BROKER_URL` іде на порт AMQP 5672. Порт 15672 — це вебморда менеджменту (`marketplace` / `dev_local_only_changeme`), там видно `x-death` очима. Демо самі збирають TypeScript і накочують міграції, окремо `npm run build` / `npm run migrate` запускати не треба. Основний шлях без `SKIP_VAULT` той самий: `BROKER_URL` і `DB_URL` приїжджають зі сховища через `scripts/with-secrets.sh`.
