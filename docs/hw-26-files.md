# Files (hw-26)

У проєкті з'явились файли: фото товарів, аватарки, дампи бази з hw-15. Тека на сервері не годиться вже на другому інстансі, бо файл приймає одна машина, а віддає інша. Тому файли лежать в S3-сумісному сховищі, а шлях «прийняти → зберегти → віддати» побудований так, щоб наш сервіс був на шляху авторизації і не був на шляху даних.

```
POST /v1/uploads/intent      гард hw-24, allowlist типу, ключ генерує сервер, рядок PENDING
  ≤ 10 МіБ: presigned PUT                 > 10 МіБ: CreateMultipartUpload
клієнт → PUT байтів прямо у сховище       POST /v1/uploads/:id/parts → ListParts → URL лише на відсутні частини
POST /v1/uploads/commit      HeadObject (і розмір) → COMPLETED; для multipart спершу Complete
GET  /v1/files/:id           гард → 302 на presigned GET на хвилину
публічні ассети: assets/app.<hash>.css з immutable → edge з кешем → приватний бакет
```

| Змінна | Джерело | Навіщо |
|---|---|---|
| `STORAGE_ACCESS_KEY` | сховище (#11) | ключ доступу до бакета: право читати й писати всі файли |
| `STORAGE_SECRET_KEY` | сховище (#11) | секрет до нього, ним підписуються presigned URL |
| `STORAGE_BUCKET` | сховище (#11) | ім'я бакета |
| `STORAGE_ENDPOINT` | оточення, порожньо для AWS | адреса S3-сумісного сховища, локально MinIO на 9900 |
| `STORAGE_REGION` | оточення, за замовчуванням `us-east-1` | регіон для підпису SigV4 |
| `EDGE_PORT` | оточення, за замовчуванням 9910 | порт `npm run edge` |

Ключ від сховища дорожчий за `DB_URL`: з ним читаються і пишуться всі файли, а ще ним підписуються presigned URL, тобто він видає доступ іншим. Тому він живе тільки у сховищі, без дефолтів у схемі. Демо й `npm run edge` ходять через `scripts/with-secrets.sh`. Ключа підпису CloudFront тут немає, бо signed URL CloudFront я не робив (про це нижче).

| Файл | Що там |
|---|---|
| `src/migrations/1789700000000-AddFiles.ts` | таблиця `files`: `key`, `owner_id`, `status`, `size`, `upload_id` |
| `src/files/policy.ts` | allowlist типів, поріг multipart, розмір частини, строки presigned |
| `src/files/uploads.ts`, `src/http/uploads.route.ts` | intent, URL на частини, commit, скачування через 302 |
| `src/files/assets.ts` | публікація ассета з хешем вмісту в імені і маніфест |
| `src/edge/edge.ts`, `src/edge.ts` | edge з кешем перед бакетом (`npm run edge`) |
| `src/storage/s3.ts`, `src/config/storage-env.ts` | клієнт S3 і його конфіг |
| `src/demo-upload.ts`, `demo-multipart.ts`, `demo-cdn.ts` (+ `demo-put.ts`, `demo-part-uploader.ts`, `demo-files-kit.ts`) | три демо і їхні дочірні процеси |

## Сховище: чому MinIO і саме цей образ

Локально стоїть MinIO, `bitnamilegacy/minio:2025.7.23`. Офіційні образи MinIO з 2025 року більше не публікуються, і на Docker Hub їх уже немає, тож це архівна збірка Bitnami, закріплена на версії. Для dev вистачає, для проду я б її не брав. Garage, на якому йшла лекція, я теж підняв і перевірив. Протермінований presigned URL він відхиляє з кодом 400 «Date is too old», а AWS і MinIO відповідають 403 AccessDenied, і мінімум 5 МіБ на частину Garage не перевіряє. LocalStack у безкоштовній версії за замовчуванням не перевіряє підпис і доступ до бакета, а саме це ДЗ і має довести. MinIO в усіх цих місцях поводиться як S3. Дані лежать у tmpfs на 1 ГБ, тож кожен `down` дає чистий аркуш. Бакет створює сам образ, а healthcheck зеленіє тільки тоді, коли бакет уже є, а не просто відповідає сервер.

Клієнт створюється з `requestChecksumCalculation: 'WHEN_REQUIRED'`. Presigned URL підписується ще до того, як з'явилось тіло, і з контрольними сумами SDK за замовчуванням у URL поїхала б CRC32 порожніх даних.

## Завантаження: intent → байти → commit

`POST /v1/uploads/intent` стоїть за гардом із hw-24 і приймає `content_type`, `size` і, для UI, `filename`. Тип звіряється з allowlist (`image/jpeg`, `image/png`, `image/webp` до 20 МіБ, `application/gzip` для дампів до 500 ГіБ). Ключ генерує сервер: `uploads/{userId}/{uuid}.{ext}`, а розширення береться з allowlist. Ім'я файла від клієнта в ключ не потрапляє взагалі, інакше клієнт отримав би право писати за будь-яким шляхом у бакеті. Демо шле `../../etc/passwd`, і в ключі його немає. У presigned PUT підписано і `content-type`: завантажити можна тільки той тип, який заявили (`wrong-type=403`). У базі з'являється рядок `PENDING`.

`POST /v1/uploads/commit` слову клієнта не вірить. Він робить HeadObject і звіряє розмір із заявленим, і тільки тоді ставить статус `COMPLETED`. Нічого не залито, отже 409, і рядок лишається `PENDING`. Без цього кроку база знала б про файли, яких немає, а сховище тримало б об'єкти, про які не знає база.

Список файлів користувача береться з таблиці `files`. Листинг бакета для цього не годиться: він платний, повільний і віддає по 1000 ключів.

Приватні файли читаються через `GET /v1/files/:id`. Гард і перевірка власника відпрацьовують на кожен запит, потім іде 302 на presigned GET, який живе хвилину. Так сервіс лишається в шляху авторизації, але байти через нього не ходять. Presigned URL відкликати неможливо: у нього немає ні `jti`, ні реєстру. Тому його не можна класти в лист, який відкриють через тиждень, а давати треба посилання на наш ендпоінт. У логи йдуть `file_id` і ключ, а сам URL ні: рядок у лозі з URL уже є виданим доступом.

## Строки presigned

PUT для фото з форми живе 5 хвилин. Завантаження стартує одразу після вибору файла, і навіть 20 МіБ на 1 Мбіт/с ідуть менше 3 хвилин. Якщо URL витече, ним можна записати лише один об'єкт, ключ якого згенерував сервер, і тільки цього типу. Тиждень, максимум SigV4, тут нічого не дав би, крім довшого вікна для витоку. До того ж у проді сервіс ходить у S3 під роллю STS, і presigned помирає разом із тимчасовими креденшелами, за замовчуванням через годину. URL на частини multipart живуть 15 хвилин і видаються пачками по 50: коли пачка скінчилась або протухла, клієнт просить наступну тим самим запитом, яким відновлюється після обриву. GET для скачування живе 60 с, бо браузер іде за 302 одразу. Що протермінований URL справді дає 403, демо перевіряє на тому самому коді підпису, тільки зі строком 2 с: спершу 200, через 3 с той самий URL дає 403.

## Multipart і довантаження

Поріг 10 МіБ, тобто дві мінімальні частини. Нижче нічого відновлювати: файл умістився б у дві частини, а обрив простого PUT коштує щонайбільше 10 МіБ повторно. Вище обрив коштує лише одну частину. Простий PUT однаково обмежений 5 ГіБ, тож великі дампи йдуть тільки через multipart.

Розмір частини рахується, а не береться константою: `max(5 МіБ, ⌈розмір / 10 000⌉ округлено вгору до МіБ)`. Частин не може бути більше 10 000, і кожна, крім останньої, має бути не менше 5 МіБ. Інакше Complete поверне `EntityTooSmall`, я перевірив на MinIO. Для 11 МіБ це 5 МіБ і три частини, для 100 ГіБ 11 МіБ, для 500 ГіБ 52 МіБ. Бібліотека із жорсткими 5 МіБ на файлі понад 50 ГБ просто впала б.

Відновлення працює так. Intent робить CreateMultipartUpload і повертає розмір і кількість частин. URL на частини дає `POST /v1/uploads/:id/parts`, яка щоразу питає сховище ListParts (з пагінацією по 1000) і підписує тільки те, чого бракує. Перше завантаження і довантаження після обриву тому ходять одним шляхом, і клієнт після рестарту нічого не мусить пам'ятати, крім `file_id`. Commit збирає частини через ListParts, робить CompleteMultipartUpload, потім HeadObject і звіряє розмір. ETag такого об'єкта має суфікс `-N` і MD5 файла не дорівнює, тож перевірка цілісності «порівняю ETag з локальним MD5» на multipart мовчки ламається.

Незавершений multipart тарифікується, хоча об'єкта немає і в листингу його не видно. На AWS для цього потрібне lifecycle-правило, і «видаляти все старше 30 днів» такі хвости не чіпає:

```json
{ "Rules": [{ "ID": "abort-incomplete-multipart", "Status": "Enabled",
  "Filter": { "Prefix": "uploads/" },
  "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 } }] }
```

Рядки `PENDING` старші за добу мала б добивати джоба BullMQ з hw-23: AbortMultipartUpload, потім DeleteObject, потім видалити рядок. Інакше накопичуються файли-сироти. Я її не робив, вона не оцінюється. Але місце для неї готове: воркер і планувальник уже є.

## CDN: локальний edge замість CloudFront

Обрав локальну форму. `npm run edge` (`src/edge/edge.ts`, близько 40 рядків логіки) віддає тільки `assets/*`. Об'єкт він бере зі сховища своїми креденшелами через SDK, кладе в кеш і відповідає з `X-Cache: HIT` або `MISS`. Це і є суть OAC: до бакета ходить кеш, а не публіка, а прямий анонімний запит у бакет отримує 403. Edge кешує тільки те, що дозволив origin: `public` і `max-age` з `Cache-Control` об'єкта. `no-cache`, `no-store` і `private` він не тримає. Кеш у пам'яті процесу з межею в 1000 записів, справжній CDN теж витісняє. Uploads через edge не віддаються зовсім, вони приватні і читаються через 302.

Для AWS той самий шар це CloudFront з Origin Access Control (OAI застарів), Block Public Access на бакеті і bucket policy, яка пускає лише одну конкретну дистрибуцію:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "CloudFrontReadsPublicAssets",
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::marketplace-files/assets/*",
    "Condition": {
      "StringEquals": { "AWS:SourceArn": "arn:aws:cloudfront::111122223333:distribution/EDFDVBD6EXAMPLE" }
    }
  }]
}
```

Без `Condition` з `AWS:SourceArn` політика пустила б будь-яку дистрибуцію CloudFront у світі. `Resource` обмежений `assets/*`, бо приватні uploads через CDN не йдуть.

Для приватного контенту через CloudFront є signed URL і signed cookies, і тоді у сховищі з'явився б ще й ключ підпису CloudFront: право видати доступ до всього приватного в дистрибуції. Це план на випадок, коли приватних файлів стане багато і їх треба буде роздавати з краю. Зараз їх закриває 302 на presigned з бакета. Signed cookies потрібні там, де клієнт тягне десятки файлів поспіль, як у галереї, і окремий URL на кожен вже незручний.

Для прямого PUT із браузера бакету знадобиться ще CORS-правило: `AllowedMethods: ["PUT"]`, `AllowedHeaders: ["content-type"]` і origin фронту. Демо ходять з Node, їм це не потрібно.

## Оновлення без інвалідації

Ім'я публічного ассета містить хеш вмісту: `assets/demo-app.<перші 8 символів sha256>.css`. `Cache-Control: public, max-age=31536000, immutable` ставиться на сам об'єкт при завантаженні, edge його лише читає. Без нього кешувати нічого: я прибрав заголовок, і `cache-hit` став 0. Після «деплою» новий вміст отримує нове ім'я. Старий запис у кеші нікому не заважає, бо його URL більше ніхто не просить, і інвалідацій нуль. Звідки клієнт дізнається нове ім'я: з маніфесту `assets/demo-manifest.json`, єдиного об'єкта з постійним ім'ям. У нього `Cache-Control: no-cache`, і edge його не кешує (`manifest-cache-hit=0`). У справжньому фронті роль маніфесту грає HTML.

Інвалідація CloudFront платна понад 1000 шляхів на місяць, скасувати її не можна, діє вона з обмеженням темпу і не дістає до браузерних і проміжних кешів. AWS для файлів, що часто оновлюються, сам радить насамперед версіонування імен, а не інвалідацію.

## Що показали прогони

Свіжий volume, команди з Grading нижче:

```
demo:upload                 demo:multipart              demo:cdn
intent=200                  intent=200                  direct=403
key-from-server=1           part-size-mib=5             edge-miss=200
api-alive=0                 parts-total=3               first-was-miss=1
put-offline=200             first-process-parts=2       edge-hit=200
put-process-secrets=0       first-process-killed=1      cache-hit=1
commit=200                  parts-on-store=2            immutable=1
download=200                head-before-complete=404    new-name=1
commit-without-bytes=409    already-there=2             manifest-points-to-new=1
tampered=403                resumed-parts=1             new-url=200
wrong-type=403              complete=200                content-changed=1
before-expiry=200           size-match=1                manifest-cache-hit=0
expired=403                 etag-multipart=1            old-url-still-cached=1
```

`demo:upload` вимикає наш API перед завантаженням байтів, і живість порту перевіряє сирим сокетом (`api-alive=0`). PUT робить окремий процес, в оточенні якого є лише `PATH` (`put-process-secrets=0`), і отримує 200. Після цього API піднімається на іншому порту, бо `fetch` тримає пул з'єднань на парі host:port, і commit проходить. Потім файл читається назад через 302, байти збігаються. `tampered` це той самий підписаний URL з іншим ключем у шляху: 403, підпис покриває шлях.

`demo:multipart` ріже 11 МіБ на 5 + 5 + 1. Перший процес заливає дві частини й убиває себе `SIGKILL`. Сховище тримає дві частини, але об'єкта ще немає (HeadObject дає 404). Новий процес питає, що вже лежить, бачить дві частини і доливає одну. Після Complete розмір збігається, ETag закінчується на `-3`. Кожен прогін на старті прибирає за попереднім і незавершені завантаження (ListMultipartUploads → AbortMultipartUpload), і об'єкти. Два прогони поспіль дають однакові числа.

`demo:cdn` публікує дві версії CSS. Edge і маніфест поводяться як описано вище.

Що я ламав навмисно, щоб перевірити самі демо:

| Що зламав | Що показало демо |
|---|---|
| commit без HeadObject | `commit-without-bytes=200`, exit 1 |
| `/parts` без ListParts, клієнт заливає все за один прохід | `already-there=0`, `resumed-parts=3`, exit 1 |
| той самий збій, але клієнт, як і мій, питає ще раз | перезаливає всі частини по колу, поки не впреться в рейт-ліміт (429), exit 1 |
| публічний бакет (`mc anonymous set download`) | `direct=200`, exit 1 |
| ім'я без хешу (`assets/demo-app.css`) | `new-name=0`, `content-changed=0`, exit 1 |
| об'єкт без `Cache-Control` | `cache-hit=0`, exit 1 |

## Дампи з hw-15

У постановці hw-15 стояло «S3 глибоко у #26», і бекап клали в локальну теку. Тепер його місце в тому самому бакеті під `backups/`, multipart з `application/gzip` якраз під це. Lifecycle може переносити старі дампи в дешевші класи. Дві чесні застереги. Glacier ламає RTO, бо об'єкт спершу треба відновити, а це години. І lifecycle не робить бекап перевіреним, restore-drill із hw-15 нікуди не дівається. Сам `scripts/backup.sh` я на S3 не переводив.

## Grading (hw-26: Files)

```bash
docker compose up -d --wait   # MinIO на 9900, разом з Postgres, PgBouncer і обома Redis

export STORAGE_ENDPOINT=http://127.0.0.1:9900
export STORAGE_ACCESS_KEY=marketplace
export STORAGE_SECRET_KEY=dev_local_only_changeme
export STORAGE_BUCKET=marketplace-files
export DB_URL=postgres://marketplace@127.0.0.1:6432/marketplace
export DB_PASSWORD_FILE=secrets/db_password.example
export REDIS_URL=redis://127.0.0.1:6380
export REDIS_QUEUE_URL=redis://127.0.0.1:6381
export SKIP_VAULT=1            # у грейдера немає доступу до сховища

# демо піднімають API з hw-24, йому потрібна пара ES256; одноразова, PEM у base64
node -e 'const {generateKeyPairSync}=require("node:crypto");
const k=generateKeyPairSync("ec",{namedCurve:"P-256",
  privateKeyEncoding:{type:"pkcs8",format:"pem"},
  publicKeyEncoding:{type:"spki",format:"pem"}});
const fs=require("node:fs");
fs.writeFileSync("/tmp/priv.b64",Buffer.from(k.privateKey).toString("base64"));
fs.writeFileSync("/tmp/pub.b64",Buffer.from(k.publicKey).toString("base64"));'
export JWT_KID=grader
export JWT_PRIVATE_KEY="$(cat /tmp/priv.b64)"
export JWT_PUBLIC_KEY="$(cat /tmp/pub.b64)"
export REFRESH_TOKEN_PEPPER="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"

npm ci

npm run demo:upload
npm run demo:multipart
npm run demo:cdn
```

Демо самі збирають TypeScript і накочують міграції. API і edge вони піднімають окремими процесами на вільних портах і вбивають після себе. Основний шлях без `SKIP_VAULT` той самий: ключі сховища, ключ підпису токенів, `DB_URL` і обидва Redis приїжджають зі сховища через `scripts/with-secrets.sh`.
