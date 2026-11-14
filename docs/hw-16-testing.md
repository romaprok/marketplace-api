# Тестування (hw-16)

Драбинка довіри поверх усього попереднього. Інтеграційні тести ганяють справжній Postgres у testcontainers, E2E іде через supertest, а контракт перевіряє Pact з брокером і `can-i-deploy`.

## Де ця робота розходиться з текстом ДЗ

Постановка описує повний Nest-застосунок (`Test.createTestingModule`, `ValidationPipe`, `HttpStatus`). Nest у цьому проєкті немає взагалі: `src/app.js` з hw-09 написаний на Express з `express-openapi-validator`. Спільна функція конфігурації, про яку йдеться в підказках ДЗ, тут уже є, це `createApp()`. Переписувати застосунок на Nest заради формулювання означало б міняти робочий продакшн-код без потреби. Тому E2E ганяє `createApp()` через supertest напряму. Інструмент той самий, змінився лише клей.

Важливіше інше. `/v1/products` і `/v1/orders` досі працюють з масивами в памʼяті (`src/data.js`, hw-09). Шар Postgres/TypeORM з hw-12…14 живе окремо: ним користуються `seed.ts`, `report.ts`, `checkout.ts` і демо, але не HTTP.

Звідси три наслідки. Інтеграційні тести (`test/integration/`) перевіряють той шар, що реально є: TypeORM-репозиторії проти справжнього `postgres:16-alpine`. E2E (`test/e2e/`) проходить `create → read` через HTTP, але запис у Postgres довести не може, бо застосунок його не робить. Чесно він доводить ось що: `DB_URL` і `DB_PASSWORD_FILE` вказують на одноразовий Postgres з testcontainers, а не на dev-базу, і `/health` бачить живе зʼєднання через той самий конфіг. Контракт описує `GET /products/{productId}`, бо відповідь цього ендпоінта не залежить від того, звідки береться каталог. З тієї ж причини `stateHandler` для `product prod_1 exists` порожній: `prod_1` лежить у статичному каталозі завжди. Коли каталог переїде в Postgres, там зʼявиться `INSERT … ON CONFLICT DO NOTHING`.

## Файли

| Шлях | Що там |
|---|---|
| `test/testkit/postgres.ts` | піднімає `postgres:16-alpine` через `@testcontainers/postgresql`, накатує міграції з hw-13, дає `truncateAll()` |
| `test/testkit/app.ts` | справжній `createApp()` на одноразовому Postgres: для E2E і для верифікації провайдера |
| `test/testkit/builders.ts` | `aUser()`, `aProduct()`, `anOrder()`: валідні унікальні дефолти, тест називає лише поле, яке перевіряє |
| `test/integration/user.repository.test.ts`, `order.repository.test.ts` | 7 тестів на 2 репозиторії TypeORM: unique (23505), FK (23503), JOIN, GROUP BY |
| `test/e2e/orders.e2e.test.ts` | supertest проти `createApp()`: happy path, 404, 400 від `express-openapi-validator` |
| `test/contract/consumer/products.pact.test.ts` | Pact-консюмер `marketplace-web`, пише `pacts/marketplace-web-marketplace-api.json` |
| `test/contract/provider/verify.ts` | верифікація провайдера проти файлу або проти брокера, з публікацією результату |
| `.github/workflows/contract.yml` | job `test` (tsc, integration, e2e) і job `contract` (публікація, верифікація, `can-i-deploy`) |

## Ізоляція: TRUNCATE між тестами, контейнер на файл

Кожен тестовий файл піднімає свій `postgres:16-alpine` у `beforeAll` і гасить у `afterAll`, а між тестами `afterEach` робить `TRUNCATE … RESTART IDENTITY CASCADE`. ROLLBACK-стратегію я свідомо не взяв. Частина тестів навмисно ловить 23505 і 23503, а після такої помилки транзакція в Postgres лишається aborted, і щоб працювати далі, довелось би обгортати кожен ризикований запит у `SAVEPOINT`. TRUNCATE працює в autocommit, тож помилка одного запиту не заважає наступному. `npm run test:integration && npm run test:integration` проходить двічі поспіль без ручної чистки.

## Команди

```bash
npx tsc --noEmit           # основний застосунок (src/), test/ не чіпає

npm run test:integration   # 2 репозиторії, 7 тестів, testcontainers
npm run test:e2e           # supertest: happy path і 2 негативні кейси
npm run test:contract      # Pact-консюмер, пише pacts/*.json
npm run verify:provider    # провайдер проти локального pacts/*.json, брокер не потрібен
```

Потрібен Node 22.22 або новіший: testcontainers 12 тягне `undici@8`, який на Node 20 падає ще до першого тесту з `webidl.util.markAsUncloneable is not a function`, і Pact теж вимагає 22. Dockerfile і CI вже на 22.

Усі чотири компілюють `test/**/*.ts` окремим `tsconfig.test.json` у `dist-test/`, основний `dist/` від `npm run build` лишається як був. Запускаються через `node --experimental-vm-modules`, бо проєкт увесь на ESM, а Jest 30 досі тримає ESM за цим прапорцем. `pacts/` лежить у `.gitignore`: контракт щоразу генерує `npm run test:contract`, і в CI так само.

## Локальний брокер і повний гейт `can-i-deploy`

```bash
docker compose up -d --wait        # разом з Postgres і PgBouncer піднімає broker-db і broker на :9292

npm run test:contract              # pacts/marketplace-web-marketplace-api.json

VERSION=1.0.0-local

# 1. публікація контракту
curl -X PUT "http://127.0.0.1:9292/pacts/provider/marketplace-api/consumer/marketplace-web/version/$VERSION" \
  -H 'Content-Type: application/json' -d @pacts/marketplace-web-marketplace-api.json
# 201

# 2. до верифікації деплоїти ще не можна
curl "http://127.0.0.1:9292/can-i-deploy?pacticipant=marketplace-web&version=$VERSION&to=prod"
# "deployable":null, "unknown":1

# 3. провайдер верифікує контракт з брокера і публікує результат
PACT_BROKER_URL=http://127.0.0.1:9292 PACT_PROVIDER_VERSION=$VERSION npm run verify:provider
# exit 0, "Results published to Pact Broker", "has a matching body (OK)"

# 4. тег prod на ту саму версію провайдера
curl -X PUT "http://127.0.0.1:9292/pacticipants/marketplace-api/versions/$VERSION/tags/prod" \
  -H 'Content-Type: application/json'
# 201

# 5. тепер можна
curl "http://127.0.0.1:9292/can-i-deploy?pacticipant=marketplace-web&version=$VERSION&to=prod"
# "deployable":true

docker compose down -v
```

Обидві відповіді кроку 5, зняті на моїй машині:

```
До тега:    "deployable":null,"reason":"There is no verified pact between version 1.0.0-local of marketplace-web and the latest version of marketplace-api with tag prod (no such version exists)","success":0,"failed":0,"unknown":1
Після тега: "deployable":true,"reason":"All required verification results are published and successful","success":1,"failed":0,"unknown":0
```

Зазвичай я запускаю верифікацію через обгортку: `bash scripts/with-secrets.sh dev npm run verify:provider`. Тоді `PACT_BROKER_URL` і `PACT_BROKER_TOKEN` приїжджають зі сховища з ДЗ #11, так само як `DB_URL`. У грейдера сховища нема, тому в кроці 3 адреса стоїть прямо в оточенні. Під `SKIP_VAULT=1` обгортка виконує ту саму команду без змін, тож обидві форми рівноцінні. Код читає лише `process.env.PACT_BROKER_URL` і `PACT_BROKER_TOKEN`, адреси чи токена в ньому немає. Без `PACT_BROKER_URL` верифікація йде проти локального `pacts/*.json`. Сам застосунок під час верифікації, як і в E2E, стартує на одноразовому Postgres з testcontainers (`test/testkit/app.ts`), тож ні `.env`, ні сховище для бази йому не потрібні.

## CI: `.github/workflows/contract.yml`

Job `test` ставить залежності, перевіряє `tsc --noEmit` і ганяє `test:integration` та `test:e2e`. Docker на `ubuntu-latest` уже є, тож testcontainers працюють без налаштувань. Job `contract` стартує лише після нього: піднімає брокер з того ж `docker-compose.yml`, генерує і публікує контракт, верифікує провайдера з `publishVerificationResult: true`, ставить тег `prod` і валить джобу, якщо `can-i-deploy` не відповів `"deployable":true`. Адреса й токен брокера беруться з GitHub secrets `PACT_BROKER_URL` і `PACT_BROKER_TOKEN`. Поки hosted-брокера немає, secrets порожні, і job ходить у брокер, який сам підняв на `127.0.0.1:9292`. Версією і провайдера, і консюмера CI бере `github.sha`, один рядок на всіх кроках прогону.
