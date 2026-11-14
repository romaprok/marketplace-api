# Marketplace API

Курсовий проєкт robot_dreams Node.js: API маркетплейсу, який від ДЗ до ДЗ обростає шаром даних, подіями, кешем, auth, файлами, а тепер і кластером. Цей README описує поточний крок (hw-28). Розділи попередніх ДЗ переїхали в `docs/` без змін по суті. README розрісся до 1300 рядків, а критерії hw-28 читають таблиці змінних саме з README, тож тут лишаються лише змінні цього кроку.

## Документація

| ДЗ | Про що | Файл |
|---|---|---|
| hw-09, hw-11 | контракт API, конфіг, ротація пароля БД, таблиця змінних застосунку | [docs/configuration.md](docs/configuration.md) |
| hw-12 | SQL-схема, обсяг даних, індекси | [docs/hw-12-data-layer.md](docs/hw-12-data-layer.md) |
| hw-13 | TypeORM, міграції, N+1 | [docs/hw-13-typeorm.md](docs/hw-13-typeorm.md) |
| hw-14 | конкурентність, атомарний checkout | [docs/hw-14-concurrency.md](docs/hw-14-concurrency.md) |
| hw-15 | PgBouncer, бекап, restore-drill | [docs/hw-15-ops.md](docs/hw-15-ops.md) |
| hw-16 | testcontainers, supertest, Pact | [docs/hw-16-testing.md](docs/hw-16-testing.md) |
| hw-18 | realtime: socket.io і SSE | [docs/hw-18-realtime.md](docs/hw-18-realtime.md) |
| hw-19 | RabbitMQ, ack, DLQ | [docs/hw-19-rabbitmq.md](docs/hw-19-rabbitmq.md) |
| hw-22 | transactional outbox, ідемпотентність | [docs/hw-22-outbox.md](docs/hw-22-outbox.md) |
| hw-23 | Redis: кеш, сесії, ліміт, BullMQ | [docs/hw-23-redis.md](docs/hw-23-redis.md) |
| hw-24 | JWT, ротація refresh, RBAC | [docs/hw-24-auth.md](docs/hw-24-auth.md) |
| hw-26 | presigned, multipart, edge-кеш | [docs/hw-26-files.md](docs/hw-26-files.md) |

Застосунок у кластері це API з hw-09 (`src/server.js`, `npm run start:inmemory`). Саме він живе в контейнері з ДЗ #5, і він уміє все, що потрібно цьому кроку: `/healthz`, `/readyz`, прогрів і дренаж.

## Kubernetes (hw-28)

На ДЗ #5 питання було «чи запуститься образ». Тепер інше: чи переживе сервіс оновлення під навантаженням. Відповідь тут число з лічильника, який рахує коди відповідей із файла: **0 невдалих відповідей на 42-163 тисячах запитів, у кожному з чотирьох прогонів**.

```
docker/Dockerfile ──► marketplace-api:hw28 (distroless, uid 65532) ──► kind load ──► kind: marketplace
infra/ (Pulumi, TypeScript) ──► Namespace marketplace
                                Secret api-secrets            ◄── DB_PASSWORD зі сховища через with-secrets.sh
                                Deployment api ×3             readiness /readyz, liveness /healthz, maxUnavailable 0
                                Service api NodePort 30080    ◄── 127.0.0.1:30080 з хоста
                                PodDisruptionBudget api       minAvailable 2
                                HorizontalPodAutoscaler api   autoscaling/v2, 3..6, cpu 70 %
```

| Змінна | Джерело | Навіщо |
|---|---|---|
| `DB_PASSWORD` | сховище (#11) | пароль до БД; програма кладе його в K8s Secret, под отримує через `secretKeyRef` |
| `PULUMI_CONFIG_PASSPHRASE` | сховище (#11) | ключ шифрування стану Pulumi (секрети в ньому зашифровані) |
| `PULUMI_BACKEND_URL` | оточення | локальний файловий бекенд стану, `file://$PWD/.pulumi`; без акаунта Pulumi |
| `.npm_token` | файл поза git; у CI секрет репозиторію | токен приватного реєстру для `npm ci` під час збірки, BuildKit-секрет |
| `SCAN_MAX`, `SCAN_SEVERITY` | оточення | поріг і рівні для `npm run scan` |

Конфіг стеку (Pulumi): `profile` (`hardened` або `naive`), `replicas` (3), `rev` (міняє шаблон пода), `image`, `kubeContext`, `dbUrl`. Значення за замовчуванням лежать у `infra/Pulumi.yaml`. Файл `infra/Pulumi.<stack>.yaml` створює перший `npm run up`, і в ньому сіль парольної фрази, тому він не в git: чужою фразою його не відкрити.

### Кластер

Підіймав на kind 0.33.0, вузол `kindest/node:v1.34.0`, Docker Desktop з 7,65 ГіБ пам'яті і 10 CPU. Вузол із трьома подами застосунку займає 907 МіБ (`docker stats`), тож місця вистачає з запасом. `npm run cluster:up` уперше йшов 53 с (з них 16 с до готовності вузла, решта на завантаження образів), далі він лише довантажує образ. Образ, зібраний на хості, у кластері не існує, поки його не завантажити. Тому `cluster:up` після кожної збірки робить `docker save` і `kind load image-archive`: пряме `kind load docker-image` спотикається об containerd-сховище образів Docker Desktop. NodePort 30080 прокинутий на `127.0.0.1:30080` через `extraPortMappings` у `k8s/kind-config.yaml`.

### Образ

`docker/Dockerfile` має дві стадії. У `deps` (node:22-bookworm-slim) є shell і npm, там ставляться prod-залежності. Фінальна стадія `gcr.io/distroless/nodejs22-debian13:nonroot`: там є node і більше нічого, ні `sh`, ні пакетного менеджера. Сенс distroless тут не в розмірі (325 МБ, бо в образ їдуть усі prod-залежності проєкту). Після RCE в такому образі немає shell, у який можна потрапити. Обидві бази закріплені за дайджестом. `USER 65532:65532` записано числом: kubelet не вміє звірити ім'я `nonroot` з `runAsNonRoot` і дає `CreateContainerConfigError`.

Токен реєстру потрапляє тільки в один `RUN` через `--mount=type=secret`. `ARG` осів би в метаданих образу, а `COPY` + `rm` наступним шаром у байтах шару. `.npmrc` з `${NPM_TOKEN}` лежить у `docker/npmrc`, поза коренем репо, щоб локальний `npm ci` не вимагав токена. Приватного реєстру в проєкті немає, тож токен грає роль приманки: випадковий рядок у `.npm_token`, який шукає `demo:image`.

```
npm run demo:image
stages=2  shell-inside=0  runtime-uid=65532  token-in-history=0  token-in-config=0  token-in-layers=0  layers-scanned=27
```

Shell демо шукає запуском `docker run --entrypoint sh`, а не читанням Dockerfile: успадкована база могла б принести його непомітно. Токен шукає в трьох місцях: `docker history`, `docker image inspect` і кожен шар із розпакованого `docker save` (за потреби розтиснутий gzip). Я зібрав три зламані варіанти, щоб переконатися, що демо їх бачить:

| Варіант | Що показало демо |
|---|---|
| одна стадія `node:22-slim` без `USER` | `stages=1`, `shell-inside=1`, `runtime-uid=0` |
| токен через `ARG` (і `ENV`) | `token-in-history=2`, `token-in-config=1`, `token-in-layers=0` |
| `COPY .npm_token` + `rm` наступним шаром | `token-in-history=0`, `token-in-layers=1` |

Другий і третій варіанти показують, чому каналів три: жоден один інструмент не бачить обидва витоки.

### Сканування з порогом

`npm run scan` запускає Trivy 0.67.2 з Docker-образу, тож нічого ставити не треба. Образ передається йому архівом `docker save`, без Docker-сокета в контейнері. Рахуються лише виправні знахідки заданих рівнів (`--ignore-unfixed`): поріг на те, що зараз ніхто не може виправити, лише привчає ігнорувати поріг. Вердикт обчислюється: `found` порівнюється з `SCAN_MAX`, і від цього залежать і рядок `gate=`, і код виходу.

```
SCAN_MAX=-1     npm run scan   → found=0 max-allowed=-1    gate=fail  exit 1
SCAN_MAX=99999  npm run scan   → found=0 max-allowed=99999 gate=pass  exit 0
```

На базі debian12 сканер знайшов 17 виправних знахідок: 2 CRITICAL у `libssl3`, решта HIGH у npm-пакетах. Перехід на distroless debian13 (OpenSSL 3.5.9) прибрав системні, а `npm update` п'яти транзитивних залежностей у межах їхніх semver-діапазонів (`proxy-addr`, `body-parser`, `brace-expansion`, `fast-uri`, `multer`) прибрав решту. Сьогодні вийшло 0. Робочий поріг у CI (`.github/workflows/image.yml`) жорсткий: нуль виправних CRITICAL і HIGH. База сканера оновлюється щодоби, тому завтра гейт може почервоніти без жодної зміни в коді. Для того він і стоїть: червоний гейт каже оновити дайджест бази або lock-файл.

### Застосунок: дві проби, прогрів, дренаж

`/healthz` відповідає на «чи треба мене вбити»: процес живий і відповідає. `/readyz` відповідає на «чи можна мені слати трафік»: прогрів закінчився і процес не зупиняється. Це різні питання на різних URL. Якби liveness дивилась на `/readyz`, тимчасово неготовий под перезапускався б безкінечно. Обидві проби стоять поза OpenAPI-валідатором.

Перед `listen()` застосунок 4 с прогрівається (`WARMUP_MS`), як реальний сервіс з міграціями й пулом БД. Без цього вимір був би порожнім: зламаний профіль не встиг би нічого зламати. На SIGTERM порядок такий. Спершу `/readyz` стає червоним, і endpoints-контролер прибирає под із Service. Далі 5 с дренажу (`DRAIN_MS`): под ще обслуговує запити, але відповідає з `Connection: close`, щоб keep-alive клієнти перепідключились на живі поди. Лише після цього закривається сокет, а через 2 с примусово закриваються залишки, зокрема websocket. `terminationGracePeriodSeconds: 15` більше за дренаж плюс закриття, інакше SIGKILL прилетів би посеред дренажу. Локально обидва числа 0, і `npm run start:inmemory` поводиться як раніше.

Проби у профілі `hardened`:

- `startupProbe` на `/healthz`, кожну секунду, до 30 спроб. Поки вона не пройшла, liveness і readiness не працюють.
- `readinessProbe` на `/readyz`, кожну секунду, `failureThreshold: 1`. Червоніє на першій же перевірці після SIGTERM.
- `livenessProbe` на `/healthz`, кожні 10 с, `failureThreshold: 3`.

startupProbe замість `initialDelaySeconds` у liveness. З `initialDelaySeconds: 10` под, якому довелось прогріватися 25 с, отримав би перший рестарт на 10 + 3 × 10 = 40 с і ніколи б не встиг стартувати, якщо прогрів довший. Зі startupProbe у нього 30 с на старт, а потім liveness працює з повною чутливістю і вимикати її для повільного старту не треба.

Стратегія: `maxUnavailable: 0`, `maxSurge: 1`. Старий под знімається лише після того, як новий сказав «готовий».

Проби в програмі типізовані як `Pick<Container, 'startupProbe' | 'readinessProbe' | 'livenessProbe'>`. tsc ловить одруківку поля, лише коли воно написане прямо, а в умовному spread мовчить. Об'єкт явного типу цю дірку закриває. Проби однаково перевіряються ще й читанням кластера, бо поле з одруківкою просто не доїхало б туди.

### Вимір: rolling update під навантаженням

`npm run demo:rollout` вмикає генератор навантаження (`scripts/load.mjs`, 16 паралельних циклів GET `/v1/products` через NodePort, кожен не частіше ніж раз на 10 мс). Кожна відповідь пише свій код у тимчасовий файл, відсутність відповіді (відмова, обрив, таймаут) пишеться як `000`. Потім демо викочує нову ревізію тим самим `pulumi up`, міняючи лише `rev` у шаблоні пода, чекає завершення, тримає навантаження ще 8 с для хвоста дренажу і рахує все з файла.

```
                           requests   ok        failed   rollout-seconds
hardened (без темпу)       163474     163474    0        19.3
hardened                    42768      42768    0        18.1
hardened                    42786      42786    0        18.3
hardened                    42676      42676    0        18.4
naive                       17386      10018    7368      4.0
```

Нуль збоїв на `hardened` відтворюється від прогону до прогону. Кількість запитів плаває, тому критерій і дивиться на `failed`. У профілі `naive` немає проб, `maxUnavailable: 1` і немає дренажу. Там 7368 з 17386 запитів лишились без відповіді (42 %), і всі вони `000`, жодного 5xx: ми ходимо в NodePort напряму, і збій тут означає, що з'єднання не встановилось. За Ingress те саме стало б 502/503. Под без readiness вважається готовим, щойно контейнер стартував, і отримує трафік, поки ще 4 с прогрівається з закритим портом. Старий под без дренажу закривається одразу. Перший мій генератор був без темпу, і на naive він давав 80 % збоїв: відмова повертається миттєво, тож цикли під час збою крутились у рази швидше і роздували частку. Темп у 10 мс прибрав це викривлення. `hardened` викочується в 4,5 раза довше, і це ціна нуля: кожен новий под мусить прогрітися й сказати «готовий», а кожен старий дренує 5 с.

Після виміру з `ROLLOUT_PROFILE=naive` демо саме повертає кластер у `hardened`.

### PodDisruptionBudget

`minAvailable: 2` при трьох репліках. Один под можна забрати на обслуговування вузла, другий уже ні. `minAvailable == replicas` блокував би будь-який drain: адмін не зміг би оновити вузол узагалі. А з однією реплікою PDB нічого не захищає.

```
npm run demo:pdb
healthy=3  minAvailable=2  disruptions-allowed-before=1  evict-1=201  evict-2=429  healthy-after=3
```

Виселення йдуть через Eviction API (`kubectl create --raw …/eviction`), так само як їх робить `kubectl drain`. Код відповіді демо бере з логу запиту kubectl (`-v=6`). Тимчасово поставив `minAvailable: 3`, і отримав `disruptionsAllowed=0` та `evict-1=429` одразу. Звичайний `kubectl delete pod` PDB не зупиняє, бюджет діє тільки на виселення. Після демо замінений под знову готовий, але бюджет на секунди витрачений, тому `disruptionsAllowed` перед демо треба читати до нього.

### HPA і `replicas`

HPA оголошено як `autoscaling/v2`: від 3 до 6 реплік, ціль 70 % CPU, і в Deployment задані `requests.cpu`, від яких рахується відсоток. У kind немає metrics-server, тому HPA показує `cpu: <unknown>/70%` і `REPLICAS 0` і нічого не масштабує. Саме тому `spec.replicas: 3` у програмі лишається, інакше Deployment мав би одну репліку і PDB втратив би сенс.

У бойовому кластері з metrics-server це вже конфлікт володіння полем. У `spec.replicas` пишуть двоє: програма (Pulumi через server-side apply) і контролер HPA через scale-підресурс. HPA підняв до п'яти під навантаженням, наступний `pulumi up` повертає три, HPA знову піднімає. Під час піку деплой зрізає репліки. Там `replicas` треба прибрати з програми після першого створення або поставити `ignoreChanges: ["spec.replicas"]`, і тоді поле належить HPA.

### Секрет рантайму

`DB_PASSWORD` приходить зі сховища через `scripts/with-secrets.sh` (на ньому стоять `npm run up`, `destroy` і `demo:rollout`). Програма першою дією перевіряє, що він є, ще до будь-якого звернення до кластера, і падає з його назвою. Дефолту немає: дефолт тут дорівнював би паролю в репо.

```
env -u DB_PASSWORD pulumi preview               → exit 1: DB_PASSWORD is required: it comes from the vault …
env -u PULUMI_CONFIG_PASSPHRASE pulumi preview  → exit 1: passphrase must be set with PULUMI_CONFIG_PASSPHRASE …
```

Програма кладе пароль у Secret `api-secrets` через поле `data` у base64. `stringData` тут не годиться: воно лише для запису, API його не повертає, і провайдер бачив би різницю на кожному `up`. З `data` другий `pulumi up` поспіль дає `8 unchanged`. Deployment бере значення посиланням `secretKeyRef`: у маніфесті одне посилання і нуль входжень самого значення. Застосунок читає `DB_PASSWORD` з env, а без нього, як і раніше, файл `DB_PASSWORD_FILE` (локальна ротація з hw-11 нікуди не ділась). Зміна пароля в поді означає новий под, тобто той самий rollout без збоїв.

base64 не шифрування. У kind значення лежить в etcd відкритим текстом, `EncryptionConfiguration` за замовчуванням не налаштовано. Тож «поклав у Secret» означає «прибрав із git», а не «зашифрував». У бойовому кластері потрібне шифрування etcd через KMS. І межа, яку варто сказати вголос: BuildKit-секрет живе під час `docker build` і захищає образ, K8s Secret живе в рантаймі й захищає репозиторій. Потрібні обидва, і жоден не замінює іншого.

Промислово значення в кластер не ходить через `pulumi up` з машини розробника. External Secrets Operator синхронізує Secret зі сховища (Vault, AWS Secrets Manager, Infisical) за розкладом, і ротація там не потребує деплою. Secrets Store CSI Driver монтує секрет файлом прямо з провайдера, без K8s Secret у etcd. Тоді застосунок читає файл, як у hw-11. Оператор у цей кластер я не ставив.

### Стан Pulumi

Бекенд стану локальний файловий (`PULUMI_BACKEND_URL=file://…`), без акаунта і `pulumi login`, а секрети в стані зашифровані парольною фразою. `pulumi refresh` на цьому стеку робити не варто: він викидає Secret зі стану, і наступний `up` падає з `already exists`. Лікується це `kubectl delete secret` і звичайним `up`.

### Grading (hw-28: Kubernetes)

Потрібні Docker, kind, kubectl і Pulumi CLI. Порт 30080 на хості має бути вільним.

```bash
export SKIP_VAULT=1                     # у грейдера немає доступу до сховища
export DB_PASSWORD=grader-secret
export PULUMI_BACKEND_URL="file://$PWD/.pulumi"
export PULUMI_CONFIG_PASSPHRASE=hw28-grading

npm --prefix infra ci
printf 'dummy-npm-token' > .npm_token   # секрет етапу збірки; у git його немає

npm run image:build                     # docker/Dockerfile -> marketplace-api:hw28
npm run cluster:up                      # kind create (кластер marketplace) + завантаження образу
npm run up                              # pulumi up, стек dev

npm run demo:image
SCAN_MAX=-1 npm run scan                # gate=fail, exit 1
SCAN_MAX=99999 npm run scan             # gate=pass, exit 0
npm run demo:pdb                        # спершу прочитайте disruptionsAllowed, демо його витрачає
npm run demo:rollout
```

Імена для критеріїв, що читають кластер: контекст `kind-marketplace` (kind робить його поточним), namespace `marketplace`, Deployment, PDB і HPA звуться `api`. Знести все: `npm run destroy && npm run cluster:down`.
