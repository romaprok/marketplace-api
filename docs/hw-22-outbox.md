# Outbox та ідемпотентність (hw-22)

З hw-24 `POST /v1/checkout` вимагає access-токен і бере покупця з нього, `X-User-Id` більше не читається (розділ Auth). Приклади з `X-User-Id` нижче описують стан на hw-22.

У hw-19 замовлення комітилось у Postgres, а подія публікувалась окремим кроком уже після COMMIT. Між цими двома записами вміщалося падіння процесу: замовлення є, а події немає. Тепер подія лягає в таблицю `outbox` тієї самої бази тим самим COMMIT, а назовні її виносить окремий relay. Ціна відома наперед. Relay може опублікувати подію двічі, тому консюмер дедуплікує, і робить це на двох рівнях.

```
POST /v1/checkout (npm run orders-api), Idempotency-Key + X-User-Id
→ placeOrder(key), одна транзакція:
  INSERT idempotency_keys          ключ запиту
  checkout(): stock, balance, order, order_items, tasks
  INSERT outbox (order.placed)
  COMMIT

relay:      SELECT … WHERE published_at IS NULL FOR UPDATE SKIP LOCKED
            → publish (confirm) → UPDATE published_at → COMMIT

консюмер, одна транзакція:
            INSERT processed_messages ON CONFLICT DO NOTHING
            INSERT fulfillments ON CONFLICT (order_id) DO NOTHING
            → ack
```

| Файл | Що там |
|---|---|
| `src/migrations/*AddOutboxInbox*` | `outbox` з частковим індексом `WHERE published_at IS NULL`, `processed_messages`, `idempotency_keys` |
| `src/http/checkout.route.ts`, `src/orders-api.ts` | HTTP-край: `POST /v1/checkout` окремим процесом (`npm run orders-api`, порт `ORDERS_API_PORT`) |
| `src/place-order.ts` | ключ, замовлення і рядок outbox одним COMMIT; publish тут немає |
| `src/checkout.ts` | тіло checkout з hw-14 винесено в `checkoutWith(manager, …)`, щоб воно жило всередині чужої транзакції |
| `src/messaging/outbox-relay.ts` | один прохід relay; `src/relay.ts` крутить його в циклі (`npm run relay`) |
| `src/messaging/order-placed.consumer.ts` | inbox і природний ключ в одній транзакції |
| `src/demo-outbox.ts`, `demo-crash-write.ts`, `demo-crash-relay.ts` (+ `-child`) | три демо, кожне саме прибирає за собою |

## Три рівні ідемпотентності

Ключ на краю, рівень 3. Заголовок той самий, що в hw-09: `Idempotency-Key`, обов'язковий. `POST /v1/checkout` передає його в `placeOrder`, а та першим ділом вставляє ключ у `idempotency_keys` з `ON CONFLICT DO NOTHING`. Якщо паралельно прийде такий самий запит, його вставка чекає на унікальному індексі, поки перший не закомітиться, потім бачить конфлікт і повертає те саме замовлення. Склад і баланс другий запит не чіпає. Відповідь на повтор така сама, як на перший запит (201 і той самий `order_id`), плюс `Idempotency-Replay: true`, як у hw-09.

Ключ означає намір купити, тому тіло запиту не хешується: два однакові замовлення з різними ключами законно стають двома. Але той самий ключ з іншим покупцем, товаром чи кількістю дає 422. Такий запит означає баг у клієнті. Заодно чужий покупець не отримає чуже замовлення, вгадавши ключ. Порівняння робиться в SQL, тож регістр UUID не важить. Ключ лежить у Postgres і комітиться разом із замовленням. Тому його бачать усі інстанси, і він переживає рестарт, на відміну від `Map` у hw-09.

Чому окремий процес і новий шлях замість `POST /v1/orders`? Замовлення hw-09 живуть у пам'яті, і на них стоять Pact-контракт з hw-16 і realtime-статуси з hw-18. Переводити все це на Postgres означало б переписати три попередні ДЗ. Тож in-memory `/v1/orders` лишився як був, а запис у Postgres отримав свій ендпоінт на окремому порту. Він не описаний в `openapi.yaml`, бо той контракт належить API з `npm start`.

```bash
npm run build && npm run migrate && npm run orders-api      # :3001
curl -i -X POST localhost:3001/v1/checkout \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" -H 'X-User-Id: <uuid покупця>' \
  -d '{"product_id":"<uuid товару>","quantity":1}'
```

| Відповідь | Коли |
|---|---|
| 201 `{ "order_id" }` | замовлення створено, або це повтор (тоді ще `Idempotency-Replay: true`) |
| 400 | немає ключа чи `X-User-Id`, невалідне або зламане тіло |
| 409 | не вистачає товару чи грошей; ключ відкочується разом із транзакцією, тож повтор пробує заново |
| 422 | той самий ключ з іншим тілом або від іншого покупця |

Inbox, рівень 2: `processed_messages (message_id, consumer)`. Ключ у ньому `eventId`, і з hw-22 це id рядка outbox (у hw-19 він виводився з `orderId`). Подія пишеться в outbox один раз і при кожній спробі публікації читається з того самого рядка, тож повтор приходить з тим самим id. Форма контракту не змінилась. Позначка і ефект комітяться разом. Якщо ефект падає, позначка відкочується з ним, і повтор чесно пробує ще раз.

Природний ключ, рівень 1, лишився з hw-19: один `fulfillment` на замовлення. Після того як inbox почистять, він не дасть зробити ефект удруге.

## Що показали три прогони

Свіжий volume, міграції з нуля, команди з Grading нижче. Мої числа:

```
demo:outbox           demo:crash-write        demo:crash-relay
requests=2            write-failed=1          killed=1
status-201=2          outbox-before-crash=1   published-before-kill=1
replayed=1            orders=0                unpublished-after-kill=1
key-reuse-422=1       outbox=0                published=1
orders=1              published=0             deliveries=2
outbox=1              deliveries=0            applied=1
published=1           effect=0                skipped=1
deliveries=1          stock-left=100          effect=1
effect=1                                      processed=1
processed=1
stock-taken=1
```

`demo:outbox` піднімає справжній маршрут `/v1/checkout` на вільному порту і шле два HTTP-запити з одним ключем одночасно, як клієнт, що не дочекався відповіді й повторив. Обидва отримали 201 з тим самим `order_id`, один із них позначений як replay. Вийшло одне замовлення, одна подія, одна доставка, і зі складу пішла одна одиниця. Третій запит з тим самим ключем, але кількістю 2, отримав 422.

`demo:crash-write` валить транзакцію вже після вставки в outbox. Щоб це було видно в числах, хук перед COMMIT рахує рядки outbox і бачить один (`outbox-before-crash=1`), а тоді кидає виняток. ROLLBACK забирає і замовлення, і подію, relay нічого не знаходить, склад лишається 100. Падіння тут змодельоване винятком у транзакції: для Postgres це той самий ROLLBACK, що й смерть процесу посеред транзакції.

`demo:crash-relay` вбиває relay по-справжньому. Relay працює в дочірньому процесі й після підтвердження від брокера робить собі `SIGKILL`, ще до `UPDATE published_at`. ОС закриває сокети, Postgres відкочує транзакцію relay, і рядок лишається неопублікованим. Здоровий relay публікує його вдруге. Консюмер отримує дві доставки, першу застосовує, другу відкидає inbox.

Я перевірив і зворотний бік, навмисно ламаючи код. Маршрут, який ігнорує заголовок і генерує ключ сам, дав у `demo:outbox` `orders=3` і `stock-taken=4`, exit 1. Консюмер без дедупу дав `applied=2`, і `demo:crash-relay` вийшов з кодом 1. Outbox, записаний окремим COMMIT, дав у `demo:crash-write` подію-сироту: `outbox=1 published=1` при `orders=0`. Вона ще й чотири рази пройшла через консюмер і впала в DLQ, бо такого замовлення не існує.

Окремо прогнав два `npm run relay` паралельно на 200 подіях: 200 повідомлень, 0 дублів, кожен relay виніс рівно 100.

## Чому не можна поміняти місцями publish і `UPDATE published_at`

Якщо спершу закомітити позначку «опубліковано», а потім публікувати, то відмова брокера або смерть процесу між цими кроками лишить рядок, який каже «вже віддано», хоча брокер його не отримав. Relay його більше не візьме, і подія загубиться назавжди. У правильному порядку найгірше, що трапиться, це дубль, а дубль консюмер відкидає. Помилка від publish теж не означає «не доставлено»: могла загубитись лише відповідь брокера. Тож вибір тут між дублем і втратою, і дубль лікується, а втрата ні.

## Порядок, прибирання, Debezium

Порядку доставки relay не гарантує. `ORDER BY created_at, id` впорядковує лише вибірку, а `SKIP LOCKED` розкидає рядки між relay. Консюмеру порядок і не потрібен: на замовлення одна подія, ефект ідемпотентний. Якби знадобився, то тільки в межах ключа партиціонування (`aggregate_id`). Курсора по id тут немає й бути не може, бо рядок стає видимим на COMMIT, а не тоді, коли отримав id. Тому relay шукає саме `published_at IS NULL`.

Outbox росте, і разом з ним дорожчає частковий індекс, на якому стоїть relay. План: періодичне `DELETE FROM outbox WHERE published_at < now() - interval '7 days'` пачками, а на більших обсягах місячні партиції з `DROP PARTITION`. `processed_messages` так само, але з TTL довшим за найдовше вікно повторної доставки. Після чистки страхує природний ключ.

Імена колонок у snake_case. Debezium Outbox Event Router за замовчуванням чекає `aggregatetype` і `aggregateid`, тож при переході на CDC треба буде явно задати `route.by.field=aggregate_type` і `table.field.event.key=aggregate_id`. Ролі полів ті самі, консюмерів переписувати не доведеться.

Ефект консюмера тепер окрема транзакція з двома вставками, тож `effect-ms-avg` у `demo:publish` виріс до 13–30 мс залежно від прогону. Для `prefetch=20` це однаково 20 × 30 мс ≈ 0.6 с проти 30 хвилин `consumer_timeout`.

## Grading (hw-22: outbox)

```bash
docker compose up -d --wait

export DB_URL=postgres://marketplace@127.0.0.1:6432/marketplace
export DB_PASSWORD_FILE=secrets/db_password.example
export BROKER_URL=amqp://marketplace:dev_local_only_changeme@127.0.0.1:5672
export SKIP_VAULT=1    # у грейдера немає доступу до сховища

npm ci

npm run demo:outbox
npm run demo:crash-write
npm run demo:crash-relay
```

Брокер той самий RabbitMQ з hw-19, окремий процес, AMQP на 5672. Демо самі збирають TypeScript і накочують міграції. Основний шлях без `SKIP_VAULT` той самий: `DB_URL` і `BROKER_URL` приїжджають зі сховища через `scripts/with-secrets.sh`.
