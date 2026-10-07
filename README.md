# Household Finances — Budget & Bill Monitoring

An offline-first Progressive Web App (PWA) for household budgets and bills.
Google Sheets is the master database, Google Apps Script is the API, and each
device keeps a working copy in IndexedDB so the app works with no internet.

| File | Purpose |
|---|---|
| `Code.gs` | Apps Script backend: database setup, API, bill generation, payments, sync, de-duplication, conflicts, audit log, self-tests |
| `index.html` | The entire frontend: UI, CSS, IndexedDB, sync queue, charts, reports |
| `service-worker.js` | Caches the app shell so the app opens offline |
| `manifest.json` | Makes the app installable |
| `icons/` | App icons (192, 512, maskable, Apple touch) |

---

## A. Architecture overview

```
 Phone / laptop (static HTTPS host, e.g. GitHub Pages)          Google
 ┌──────────────────────────────────────────────┐        ┌─────────────────────────┐
 │ index.html (UI)                              │        │ Apps Script Web App     │
 │   ├─ Calc  – same bill/budget rules as server│  POST  │  doPost → handleRequest │
 │   ├─ Store – in-memory mirror                │ ─────► │  LockService            │
 │   ├─ LocalDB – IndexedDB (data + queue)      │  JSON  │  processSyncOperation   │
 │   └─ Sync – queue, retry, delta pull         │ ◄───── │  Sync_Log (audit/dedup) │
 │ service-worker.js – app-shell cache          │        │         │               │
 └──────────────────────────────────────────────┘        │  Google Sheets (master) │
                                                         └─────────────────────────┘
```

**Every write is local first.** Saving an expense, payment, income or note
writes the record to IndexedDB and puts an operation into the IndexedDB queue
*before* any network call. If online, the queue is flushed immediately; if not,
it is flushed automatically when the connection returns. The UI never waits on
the server to show your entry.

### Important hosting limitation (read this)

Apps Script web apps are served inside a sandboxed iframe on
`*.googleusercontent.com`. A page there **cannot register a service worker**
and **cannot be installed as a PWA**, because the service worker would have to
come from the same origin and scope as the page, and Apps Script cannot serve
it that way. So:

* **Full PWA (recommended):** host `index.html`, `service-worker.js`,
  `manifest.json` and `icons/` on any static HTTPS host (GitHub Pages,
  Netlify, Cloudflare Pages, Firebase Hosting). The page calls the Apps Script
  Web App as a JSON API. This gives offline launch, installation, and the
  offline queue.
* **Fallback (no hosting):** the same `index.html` can also be added to the
  Apps Script project and opened at the `/exec` URL. It then talks to the
  server through `google.script.run`. IndexedDB and the queue still work
  while the tab is open, but the app **cannot open with no internet** and
  cannot be installed. The app detects this mode and says so in Settings.

Cross-origin calls work because the app sends `POST` with
`Content-Type: text/plain` (no CORS preflight, which Apps Script can't
answer), and Apps Script's JSON responses allow any origin.

## B. Google Sheets database structure

All sheets are created by `initializeDatabase()`. Columns are found by **header
name**, so you can reorder columns or add your own. Rows are never used as IDs.

| Sheet | Columns |
|---|---|
| **Settings** | key, value, updatedAt |
| **Recurring_Bills** | recurringBillId, name, category, amount, frequency, dueDay, dueWeekday, intervalDays, startDate, endDate, paymentMethod, isActive, notes, createdAt, updatedAt |
| **Bill_Instances** | billInstanceId, recurringBillId, billName, category, billingPeriod, dueDate, expectedAmount, actualAmount, remainingAmount, difference, status, paymentMethod, paidDate, notes, createdAt, updatedAt, instanceKey, frequency, paymentCount, manualOverride, isVoid |
| **Payments** | paymentId, billInstanceId, operationId, paymentDate, amount, paymentMethod, notes, createdAt, updatedAt, recurringBillId, billName, billingPeriod, isVoid |
| **Expenses** | expenseId, date, description, category, amount, paymentMethod, notes, operationId, createdAt, updatedAt, isDeleted |
| **Income** | incomeId, date, source, category, expectedAmount, actualAmount, paymentMethod, status, notes, operationId, createdAt, updatedAt, isDeleted |
| **Categories** | categoryId, type (EXPENSE / INCOME / BILL), name, isActive, sortOrder, createdAt, updatedAt |
| **Monthly_Budget** | budgetId, month, plannedAmount, notes, createdAt, updatedAt |
| **Sync_Log** | logId, timestamp, operationId, entityType, entityId, action, status, message, details, source |
| **Dashboard_Data** | month, monthlyBudget, expectedBills, actualBills, otherExpenses, totalSpent, remaining, unpaidAmount, overBudgetAmount, expectedIncome, actualIncome, netCashFlow, budgetHealth, paid/partial/unpaid/overdue/overBudget counts, updatedAt |

How the data is stored:

* **Dates** are `YYYY-MM-DD` text and **months** are `YYYY-MM` text. The columns use plain-text format so Sheets never turns them into date values that could shift across time zones.
* **Timestamps** are ISO UTC strings.
* **Money** is stored as plain numbers. A blank `actualAmount` means "no payment yet", which is not the same as ₱0.
* **Nothing is hard-deleted.** Expenses and income use `isDeleted`. Payments and bill instances use `isVoid`.
* **Duplicate-safety columns** (`instanceKey`, `operationId`, `isVoid`, `isDeleted`, `manualOverride`, `intervalDays`) were added beyond the spec.

## C. Data flow

1. **Startup:** the app loads everything from IndexedDB and shows it right away. It then fetches only the records changed since the last sync (`getAllData` with `since`). The server also creates any missing bills for this month and the next two.
2. **Save:** the record goes to IndexedDB, the operation joins the queue, and the queue is flushed if the device is online. Results come back with server-recalculated records (for example, the bill's new status after a payment), and those replace the local copies.
3. **Dashboard:** it is calculated from local data with the same rules as `Code.gs`, so it also works offline. When online, the app calls `getDashboardData()` and compares the totals. A match shows "✓ Totals verified with Google Sheets". A mismatch triggers a full reload from the sheet.

## D. Online/offline synchronization strategy

**Queue item:** `operationId, entityType, action, localId, payload, createdAt, status, retryCount` (plus `baseUpdatedAt`, `baseValues` and `changedFields` for conflict detection).

**Indicator states:** ● Online • Synced · ● Offline • Saved locally · ● Syncing… · ⚠ Sync pending · ⚠ Sync failed · ✓ All changes synced.

When the connection returns (the `online` event, tab focus, or a 20-second check), the sync runs in this order:

1. Read the queue, oldest first, in batches of 50.
2. `syncOfflineOperations` runs the whole batch under one `LockService` script lock.
3. For each operation, `isOperationProcessed()` checks `Sync_Log` and the `operationId` columns.
   * If the operation was already applied, it is reported as `DUPLICATE` and nothing is written.
   * Otherwise it is applied and written to the audit log.
4. The server returns the `serverId` and the authoritative records. The client updates IndexedDB and removes the finished operation.
5. A delta pull refreshes the cache, and the dashboard re-renders.

**Failures:**

* Network errors are retried with backoff (5 s, 10 s, 20 s … up to 10 minutes).
* Validation errors are marked `REJECTED` and shown in Sync / Offline, where you can retry or discard them.
* Queued operations are never removed until the server confirms them.

**Duplicate prevention works at four levels:**

1. Save buttons are disabled while saving.
2. Each form has one fixed `operationId` and record ID, so repeated clicks re-queue the same operation.
3. The server refuses an `operationId` it has already processed.
4. Bill instances have deterministic IDs.

**Conflicts.** Updates carry the server `updatedAt` and the field values they started from.

* If the server copy changed afterwards:
  * Different fields → the changes merge.
  * The same text field → the newer timestamp wins, and the losing value is kept in the `Sync_Log` details.
  * The same money or date field → **NEEDS REVIEW**. Nothing is overwritten. Sync / Offline offers "Keep this device's version" or "Keep server version".
* Deleting a record that was edited elsewhere also needs review.

## E. Bill-generation logic

`generateBillInstances()` reads the active recurring bills and, for each month, works out when each one is due:

| Frequency | When it is due |
|---|---|
| MONTHLY | `dueDay`, moved to the last day in short months (31 → 30 Nov) |
| QUARTERLY / YEARLY | every 3 / 12 months counted from the start month, on `dueDay` |
| WEEKLY | every `dueWeekday` (0 = Sunday … 6 = Saturday), e.g. five Saturdays in Oct 2026 |
| CUSTOM | every `intervalDays` days from `startDate` |

`startDate` and `endDate` are always respected. Dates are calculated as whole days, so time zones cannot shift them.

**No duplicates:** each instance ID is `BI-<recurringBillId>-<YYYYMMDD>`, and an
`instanceKey = recurringBillId|billingPeriod|occurrenceDate` is checked as well.
Running generation any number of times creates nothing new. It runs during
initialization, during sync, when you browse to a month, and daily via
`installTriggers()`.

**Changing a recurring bill** (for example Internet ₱1,299 → ₱1,400) asks
"apply to unpaid bills from [month]" (default: this month, never earlier).
Only instances in that month or later **that have no payments** get the new
amount. Paid instances and earlier months are never touched. Bills generated
later use the new amount.

**Disabling** a bill voids its future unpaid instances (`isVoid = TRUE`, the row
is kept). Past and paid instances stay. Enabling it again restores them.

## F. Payment and status logic

* **Actual** = sum of non-void payments. **Remaining = Difference = Expected − Actual.**
* Payments are separate rows, so one bill can have many partial payments. A mistaken payment is *voided*, never deleted.

Status priority:

1. **VOID**
2. **OVER BUDGET** (actual > expected)
3. **PAID** (actual ≥ expected)
4. **OVERDUE** (past due and not fully paid)
5. **PARTIAL**
6. **UNPAID** (blank actual)

The server recalculates every status. The client uses the same function only for offline display.

**Dashboard:**

* **Budget:** the planned amount from `Monthly_Budget`, or `defaultMonthlyBudget`. On first setup that default is calculated as the sum of active monthly bills = ₱46,089.
* **Expected:** the sum of this month's bill instances. This includes weekly items, so it is higher than ₱46,089.
* **Actual:** bill payments plus other expenses.
* **Remaining:** Budget − Actual.
* **Unpaid:** the outstanding balance of open bills.
* **Over Budget:** the total paid above expected amounts.
* **Net Cash Flow:** Actual Income − Actual Bills − Other Expenses.

**Budget Health:**

* **OVER BUDGET:** spending is already above budget.
* **WATCH:** any of these, each shown as a reason on the card:
  * projected spending (all scheduled bills + expenses) is above budget
  * 90% of the budget is used
  * there are overdue bills
  * bills were overpaid
  * spending is ahead of the calendar
  * expected income doesn't cover projected spending
* **ON TRACK:** none of the above.

> With the default data, Budget Health starts at **WATCH**, because the
> weekly items (≈ ₱22,000/month) are not in the ₱46,089 fixed budget. To
> include them, raise the month's budget (Dashboard → Adjust).

---

## 6. Google Apps Script setup

1. Create a new Google Sheet (e.g. *Household Finances DB*). You can also reuse an existing one, because initialization never clears data.
2. Open **Extensions → Apps Script**. Delete the sample code, paste all of `Code.gs`, and save.
3. *(Optional fallback mode only)* Click **+ → HTML**, name it `index` (exactly), and paste all of `index.html`.
4. In the function dropdown choose **`initializeDatabase`** and click **Run**. Approve the permissions (Sheets and script properties).
5. Open **View → Execution log** and **copy the API key** printed there. It is shown once. Only its SHA-256 hash is stored. If you lose it, run `rotateApiKey()`.
6. Run **`installTriggers`** once. This installs the daily 1 AM (Manila) job that generates bills, refreshes OVERDUE statuses and updates `Dashboard_Data`.
7. *(Recommended)* Run **`runSelfTests`**. It runs the backend test plan on temporary `ZZTEST_` sheets with a fixed date, then deletes them. Your data is not touched. Expect `35 / 35 tests passed` in the log.

After reloading the spreadsheet, a **Household Finances** menu also offers these actions.

## 7. Deployment (Apps Script Web App)

1. **Deploy → New deployment → type: Web app.**
2. **Execute as:** *Me*. **Who has access:** *Anyone*.
   * "Anyone" is required so the PWA on another domain can reach the API.
   * Every data request is still refused without your API key.
   * The spreadsheet itself stays private.
3. Copy the **Web app URL** (ends in `/exec`).
4. After changing `Code.gs` later, go to **Deploy → Manage deployments → Edit → Version: New version**. This keeps the same URL.

## 8. PWA setup (GitHub Pages example)

1. Create a GitHub repository (it can be private if your plan supports Pages for private repos). Upload `index.html`, `service-worker.js`, `manifest.json` and the `icons/` folder to the root.
2. Open **Settings → Pages → Deploy from branch → main / root**. Your app will be at `https://<user>.github.io/<repo>/`.
3. Open that URL, go to **Settings → Connection**, paste the `/exec` URL and the API key, then tap **Save & test connection**. The first sync loads everything.
4. Install the app:
   * **Chrome / Edge / Android:** browser menu → *Install app*, or the button in Settings.
   * **iPhone:** Safari → Share → *Add to Home Screen*.
5. When you update `index.html`, change `CACHE_VERSION` in `service-worker.js` so devices pick up the new shell.

Each device needs the URL and key once; they are stored only on that device.
Use **Disconnect this device** on a lost or shared device, and run `rotateApiKey()` if you think the key leaked.

## 9. Testing checklist

Backend (run `runSelfTests()`):

* Init is idempotent.
* Seeds are created once.
* The default budget = ₱46,089.
* Tests 1–8 and 12–15 pass.
* The conflict, security and validation checks pass.

Full app, manually:

| # | Do this | Expect |
|---|---|---|
| 1 | Recurring Bills → Add (monthly ₱1,299) | Row in **Recurring_Bills**, 3 instances in **Bill_Instances** |
| 2–3 | Menu → Generate bill instances (twice) | "Created 0" the second time; no duplicate `instanceKey` |
| 4 | Bills → Internet → Mark as Paid | 1 row in **Payments**; Internet **PAID**; dashboard Actual +₱1,299 |
| 5 | Pay ₱800 on a ₱1,299 bill | **PARTIAL**, remaining ₱499 |
| 6 | Pay balance ₱499 | **PAID**, 2 payments listed in Details |
| 7 | Pay ₱1,500 on a ₱1,299 bill | Form warns first; status **OVER BUDGET**, difference −₱201 |
| 8 | Add expense online | Row appears in **Expenses** within seconds |
| 9 | Airplane mode → add ₱500 Groceries | Shows instantly, "Saved locally", indicator "Offline • Saved locally" |
| 10 | Close the app, reopen it offline | App opens; entry is still there; Sync / Offline shows it pending |
| 11 | Reconnect | Syncs automatically; row appears in **Expenses** |
| 12 | Tap Sync now repeatedly / replay the operation | Still one row; `Sync_Log` shows `DUPLICATE` |
| 13 | Run generation several times | No duplicates |
| 14 | Edit Internet → ₱1,400, apply from next month | That month and later = ₱1,400; earlier/paid = ₱1,299 |
| 15 | Disable a recurring bill | Future unpaid rows → `VOID`; history unchanged; no new instances |

These were all automated during development: a Node mock of SpreadsheetApp,
LockService and the other services running the real `Code.gs` behind a
cross-origin `/exec` endpoint, plus headless-Chromium tests (48/48 passing)
covering online and offline use, closing and reopening offline, a dropped
connection on reconnect, triple-click submits, conflicts, mobile layout and
CSV export. Run the Apps Script self-tests and the checklist once in your own
account.

## Limitations & notes

* **Apps Script hosting:** see "Important hosting limitation" above. A static HTTPS host is needed for offline launch and installation.
* **Fonts offline:** Google Fonts are cached after the first online visit. Before that, the app falls back to Georgia and the system sans-serif.
* **Browser storage eviction:** the app requests persistent storage. Safari may still clear site data for websites not added to the Home Screen after about 7 days of no use. Unsynced changes are the only thing at risk, so open the app online now and then (or install it).
* **Apps Script quotas:** each request runs under a 30-second lock wait and the 6-minute execution limit. Batches are capped at 100 operations, far beyond normal household use.
* **Editing the sheet by hand:** this is safe, because columns are matched by header and dates typed by hand are normalized. Keep the ID columns unique, and prefer voiding or `isDeleted = TRUE` over deleting rows.
* **Due days:** the seeded due days (Internet 15th, House 5th, Water 20th, Electricity 25th, Credit Card 28th, Kasambahay Fridays, Cat Food & Litter Saturdays) are placeholders. Edit them in Recurring Bills.
