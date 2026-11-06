# Конкурентність (hw-14)

Транзакційний checkout поверх схеми з hw-12/hw-13: декремент stock, списання балансу покупця, запис замовлення і задачі на post-processing — усе в одній транзакції, з атомарним захистом від oversell.

| Файл | Призначення |
|---|---|
| `src/checkout.ts` | транзакційне оформлення замовлення: атомарний `UPDATE ... WHERE stock >= $n RETURNING` |
| `src/entities/Task.ts` + `src/migrations/*AddStockBalanceTasks*.ts` | черга задач post-processing (`stock`/`balance` теж тут — нові колонки, не було в hw-12/13) |
| `src/demo-race.ts` (`npm run demo:race`) | 50 паралельних checkout на товар зі stock=10 — доводить відсутність oversell |
| `src/demo-workers.ts` (`npm run demo:workers`) | 4 воркери розбирають чергу через `FOR UPDATE SKIP LOCKED` |
| `src/with-retry.ts` + `src/demo-retry.ts` (`npm run demo:retry`) | ретрай-обгортка на 40001/40P01, сценарій, що провокує serialization failure |

## Чому атомарний `UPDATE ... RETURNING`, а не `SELECT ... FOR UPDATE`

`UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING price` — перевірка і лок в одному виразі: Postgres бере лок на рядок і одразу ж переевалює `WHERE` проти актуального (щойно залоченого) значення `stock`, тому два конкурентні checkout на останню одиницю фізично не можуть обидва побачити `stock >= 1` як true. Нуль рядків у відповіді = товару нема, без окремого `SELECT` і без вікна для гонки. Працює на звичайному `READ COMMITTED` — саме тому цей патерн кращий за `SELECT ... FOR UPDATE` + перевірку в JS для цього конкретного випадку: не треба піднімати isolation level, і код коротший (`SELECT FOR UPDATE` теж унеможливлює гонку, але вимагає додаткового `if` в JS між читанням і записом — зайва поверхня для помилки).

## `npm run demo:race` — числа з мого запуску

```
Attempts: 50
Successful: 10
Failed: 40 (insufficient stock: 40, insufficient balance: 0)
Final stock: 0
Rows with negative stock: 0
```

Рівно 10 успішних (= початковий stock), 0 рядків з від'ємним stock — жодного oversell при 50 справді одночасних (`Promise.all`, без черг у застосунку) спробах купити останню одиницю.

**Пастка, на яку я наступив:** `manager.query()` в TypeORM для `UPDATE`/`DELETE` повертає кортеж `[rows, rowCount]`, а не масив рядків напряму (на відміну від `SELECT`/`INSERT`) — перша версія перевіряла `stockRows.length === 0`, що для кортежу довжини 2 ніколи не було true, тому перевірка stock мовчки не спрацьовувала (усі 50 "успішали", `total` виходив `NaN`, бо `stockRows[0]` був масивом, а не рядком). Фікс — деструктурувати `const [stockRows] = await manager.query(...)`.

## `npm run demo:workers` — числа з мого запуску

```
Tasks: 20, workers: 4
Distribution: { 'worker-1': 5, 'worker-2': 5, 'worker-3': 5, 'worker-4': 5 }
Processed exactly once: 20/20
Processed twice or more (should be 0): 0
Parallel wall-clock time: 177ms
Sequential estimate (20 x ~35ms): 700ms
```

20 задач, 4 воркери, кожна задача оброблена рівно один раз (`processed` — лічильник у самому рядку). ~177 мс паралельно проти оцінки ~700 мс послідовно — приблизно 4× швидше, збігається з кількістю воркерів (жодної задачі, за яку "посперечались" би два воркери одночасно — `SKIP LOCKED` пропускає залочені рядки замість очікування).

## `npm run demo:retry` — числа з мого запуску

```
retry #1 for +30: caught 40001, backing off and retrying whole transaction
Initial balance: 100
Top-ups: 50 + 30
Retries caught (40001/40P01): 1
Final balance: 180 (expected 180)
```

Два конкурентних поповнення балансу (`+50` і `+30`) під `REPEATABLE READ`: обидва читають той самий знімок `balance`, обидва рахують нове значення від нього — друга транзакція, що намагається закомітитись, отримує `40001` (Postgres бачить, що рядок змінився відносно її знімка). Ретрай-обгортка ловить **тільки** `40001`/`40P01` і повторює **всю** транзакцію (включно з читанням) — фінальний баланс `180` (`100 + 50 + 30`) підтверджує, що це не lost update: повтор лише запису замість повного повтору транзакції дав би `130` або `150`, залежно від того, яке з двох поповнень "загубилось" би.

## Чому ретрай ловить лише `40001`/`40P01`

Це єдині два коди Postgres, які означають "транзакція відкочена через конфлікт з іншою транзакцією, спробуй ще раз з нуля" — а не "твій запит помилковий" чи "бізнес-правило порушено". Будь-яка інша помилка (порушення `CHECK`, `NOT NULL`, `InsufficientStockError`/`InsufficientBalanceError` із `checkout.ts`) — це реальна відмова чи баг, і повторювати її сліпо означає замаскувати справжню проблему нескінченним циклом ретраїв.

## Grading (hw-14: конкурентність)

```bash
docker compose down -v && docker compose up -d --wait

cp .env.example .env
cp secrets/db_password.example secrets/db_password

npm ci
npx tsc --noEmit

export SKIP_VAULT=1    # у грейдера немає доступу до сховища

npm run build
npm run migrate          # застосовує і InitSchema (hw-13), і AddStockBalanceTasks (hw-14)

npm run demo:race        # exit 0, "Successful: 10", "Rows with negative stock: 0"
npm run demo:workers     # exit 0, "Processed twice or more (should be 0): 0"
npm run demo:retry       # exit 0, "Final balance: 180 (expected 180)"
```
