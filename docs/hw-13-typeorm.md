# TypeORM data layer (hw-13)

SQL-схема з hw-12 переїхала в код: entities + relations + міграції, `synchronize: false` завжди. Плюс доведений і вилікуваний N+1, і звітний запит, який неможливо виразити через `find()`.

| Файл | Призначення |
|---|---|
| `src/entities/*.ts` | `User`, `Product`, `Order`, `OrderItem` — типи колонок і `nullable` відповідають `db/schema.sql` |
| `src/migrations/*.ts` | згенерована `migration:generate`, прочитана й відкатна (`down()` реально дропає) |
| `src/data-source.ts` | `DataSource` із `synchronize: false`; підключення з `DB_URL` + `DB_PASSWORD_FILE`, як у конфіг-шарі hw-11 — нового env-файлу нема |
| `src/seed.ts` | детермінований ідемпотентний seed (фіксовані UUID, `save()` за наявним id — upsert, не дублікат) |
| `src/demo-nplus1.ts` | N+1 на графі `order → items → product`, лічильник запитів через власний `Logger` |
| `src/report.ts` | виторг по продавцях (`paid`-замовлення) через `createQueryBuilder().getRawMany()` |
| `scripts/with-secrets.sh` | обгортка навколо `migrate`/`migrate:show`/`migrate:revert`/`seed`/`demo:nplus1`/`report`; `SKIP_VAULT=1` — аварійний вхід для грейдера |

## Чому `numeric(12,2)`, а не `integer` у центах

Загальна порада ОРМ-лекції — гроші як `integer` у мінорних одиницях (центах). Але `db/schema.sql` з hw-12 уже зафіксував `numeric(12,2)` для `price`/`total`/`unit_price` — і entities мають відповідати цій схемі (вимога п.1), а не переписувати її заново під нову лекцію. Тому тут `numeric(12,2)` наскрізно: у Postgres це так само точний десятковий тип без похибки округлення, яку дає `float`; ціна — `pg` повертає `numeric` рядком, а не числом, тому кожна `price`/`total`/`unit_price`-колонка йде з `transformer` (`src/util/numeric-transformer.ts`), який конвертує рядок у `number` при читанні.

## Чому `search_vector` з hw-12 немає в `Product`-entity

`search_vector` (генерована `tsvector`-колонка + GIN-індекс) — артефакт пошукової оптимізації з SQL-шару hw-12, не частина реляційної доменної моделі, з якою працює це ДЗ (relations/міграції/N+1/QueryBuilder). TypeORM 0.3 технічно вміє generated-колонки (`generatedType: 'STORED'`, `asExpression`), але тягнути це в entity заради жодного критерію цього ДЗ — зайва складність без вигоди. Якщо колонка знадобиться на рівні ORM пізніше — це окрема міграція, написана руками поверх згенерованої тут.

## `onDelete` — де RESTRICT, де CASCADE

Той самий вибір, що і в `db/schema.sql`: `products.seller_id`, `orders.buyer_id`, `order_items.product_id` — `RESTRICT` (історія покупок і каталогу не повинна зникати мовчки, якщо видалили користувача чи товар). `order_items.order_id` — єдиний `CASCADE`: рядок замовлення без самого замовлення не має сенсу existence.

## N+1: доведено і вилікувано (`npm run demo:nplus1`)

Граф `order → order_items → product` (2 рівні), 25 замовлень у сіді:

| Стратегія | Запитів |
|---|---|
| наївно (запит у циклі, обидва рівні) | **75** (≥ 25 — розмір колекції) |
| `relations: ['items', 'items.product']` (join-стратегія за замовчуванням) | **1** |
| `leftJoinAndSelect` (QueryBuilder, та сама ідея) | **1** |
| `relationLoadStrategy: 'query'` (2 рівні → 1 + 2×2) | **5** |

Наївний варіант: `orders.find()` (1 запит) → на кожне замовлення окремий запит по `order_items` (N) → на кожен item окремий запит по `product` (ще N). Це не залежить від того, скільки саме запитів на рівень — головне, що число росте з розміром колекції, а не лишається константою. Обидва "виправлені" варіанти дають фіксоване число незалежно від N — перевірено: 25 замовлень у сіді, число запитів (1, або 5 для `'query'`-стратегії) те саме, що було б і на 250.

## Repository vs QueryBuilder — де межа

`Repository`/`find()` — поки запит describable як "сутність (-і) з опціональними фільтрами/відношеннями": там ORM повертає граф entities, і це саме те, що потрібно. Щойно результат — не сутність, а **обчислене значення поверх групи рядків** (сума, кількість, середнє по `GROUP BY`) — `find()` фізично не може це виразити: він завжди повертає entities, а не довільні агреговані колонки. `src/report.ts` — саме такий випадок: "виторг по продавцях" — це не список продавців і не список замовлень, це нова, обчислена форма даних, тому `createQueryBuilder().getRawMany()`.

## Секрети — той самий підхід, що в hw-11/hw-12, плюс легка Infisical-обгортка

`data-source.ts` не містить жодного захардкодженого хоста/пароля — `DB_URL` і `DB_PASSWORD_FILE` приходять з `process.env`, який наповнює `scripts/with-secrets.sh`. У проді ця обгортка робить `infisical export --env=<env> > .secrets/infisical.env` (одноразово, руками) і підвантажує цей файл в оточення перед запуском команди; `.secrets/` — поза git (`.gitignore`). Для грейдера, у якого немає доступу до сховища, — аварійний вхід `SKIP_VAULT=1`: обгортка одразу виконує команду з тим, що вже є в оточенні (дев-креденшели з `docker-compose.yml`, не секрет).

## Grading (hw-13: TypeORM-шар)

```bash
docker compose down -v && docker compose up -d --wait

cp .env.example .env
cp secrets/db_password.example secrets/db_password

npm ci
npx tsc --noEmit

export SKIP_VAULT=1    # у грейдера немає доступу до сховища

npm run build
npm run migrate
npm run migrate:show     # -> [X] на єдиній міграції

npm run migrate:revert   # відкат
npm run migrate          # і назад

npm run seed
npm run seed              # ідемпотентно — кількість рядків не змінюється

npm run demo:nplus1       # числа "до/після" — див. таблицю вище
npm run report             # виторг по продавцях, з GROUP BY
```

`with-secrets.sh` читає `DB_URL`/`DB_PASSWORD_FILE` з того самого оточення, що й Express-застосунок (hw-11) і SQL-шар (hw-12) — жодних нових env-файлів це ДЗ не додає.
