# Kiro Auto — Google OAuth registrar (v2)

Bulk-register Kiro accounts via Google (Workspace/GSuite) OAuth at **app.kiro.dev/signin**, using stealth-patched Firefox (Camoufox) by default. No AWS flow, no email OTP, no temp-mail.

## Architecture

`app.kiro.dev/signin` exposes four identity-provider buttons: Google, GitHub, AWS Builder ID, Organization SSO. This tool automates the **Google** button:

1. Open `https://app.kiro.dev/signin`
2. Click *Google Sign in*
3. Kiro's `InitiateLogin` RPC issues a PKCE state, redirects through `kiro-prod-us-east-1.auth.us-east-1.amazoncognito.com` (AWS Cognito User Pool brokering the Google IdP)
4. Google OAuth at `accounts.google.com`, scope `email openid`, `redirect_uri` → Cognito `/oauth2/idpresponse`
5. Cognito redirects back to `app.kiro.dev/signin/oauth` with its own auth code, Kiro web app exchanges it and writes the session cookie
6. All cookies + `localStorage` + `sessionStorage` are dumped to `show/sessions/<email>.<ts>.json`

Tokens are **Cognito-issued**, not the legacy AWS SSO `aor*` format. The session JSON contains everything needed to rehydrate a browser or API client.

## Requirements

- Node.js 20+ (Camoufox requires it; `engines: >=20` on `camoufox-js`)
- Windows / macOS / Linux
- A list of GSuite accounts you control (`email:password`)
- First run downloads the Camoufox Firefox binary (~170MB)

## Install

```powershell
npm install
npm run install-browser     # Chromium fallback
# Camoufox downloads itself on first launch
```

## Accounts file

`accounts/gsuite.txt`, one per line:

```
alice@yourdomain.com:SuperSecret123
bob@yourdomain.com:AnotherPass456
# comments + blank lines ignored
```

State tracked in `accounts/gsuite.state.json` — used accounts are skipped on next run. Delete to replay.

Both files are gitignored.

## Register

Interactive:

```powershell
npm run register
```

Non-interactive:

```powershell
npm run register -- --count 5 --concurrency 2 -y
npm run register -- --count 10 --proxy "http://user:pass@host:port" -y
npm run register -- --count 3 --engine chromium-stealth --headed -y
npm run register -- --count 3 --engine camoufox --no-geoip -y
```

Flags:

| flag | default | notes |
|------|---------|-------|
| `--count`, `-n` | 1 | clamped to `min(count, unused accounts)` |
| `--concurrency`, `-c` | 1 | parallel workers |
| `--delayMs`, `-d` | 0 | stagger between task starts |
| `--proxy` | — | http/socks proxy for browser + Node `fetch` |
| `--accounts` | `accounts/gsuite.txt` | |
| `--accounts-state` | `accounts/gsuite.state.json` | |
| `--engine` | `camoufox` | `camoufox` \| `chromium-stealth` \| `chromium-vanilla` |
| `--headed` / `--headless` | `--headless` | |
| `--humanize` / `--no-humanize` | humanize on | camoufox only (mouse trajectory) |
| `--geoip` / `--no-geoip` | geoip on with proxy | camoufox only (timezone/locale from IP) |
| `--no-fingerprint` | off | disable Chromium fingerprint injection |
| `--results` | `show/results.json` | run record |
| `--sessionsDir` | `show/sessions` | captured session JSONs |
| `--non-interactive`, `-y` | — | required for CLI mode |

## Stealth

**Camoufox** (default): Firefox fork with C-level fingerprint patches (Canvas/WebGL/AudioContext/Font metrics/navigator.webdriver). Better against Google's bot risk model than patched Chromium because the underlying engine signatures themselves differ. Auto-humanizes cursor. `geoip: true` resolves locale/timezone from the proxy's outbound IP.

**chromium-stealth** (fallback): `playwright-extra` + `puppeteer-extra-plugin-stealth` + the project's fingerprint injection scripts (`lib/fingerprint/*`).

**chromium-vanilla**: raw Playwright. For debugging only — will be detected.

## Session output

Each successful registration produces a JSON session under `show/sessions/`:

```json
{
  "email": "alice@yourdomain.com",
  "capturedAt": 1778670000000,
  "finalUrl": "https://app.kiro.dev/...",
  "cookies": [ { "name": "...", "value": "...", "domain": "...", ... } ],
  "localStorage": { "kiro-visitor-id": "...", ... },
  "sessionStorage": { ... },
  "userAgent": "Mozilla/5.0 ..."
}
```

To resume in another browser / API client: load the cookies into your context before navigating to `app.kiro.dev`.

## Switch (legacy)

`npm run switch` still works for legacy `aor*` refresh tokens produced by the old AWS Builder ID flow, consumed from `show/builderid-template.json`. The new Google flow does **not** produce `aor*` tokens — it produces Cognito session cookies, which `switch.ts` does not understand yet. Treat `switch.ts` as orthogonal until you explicitly port it.

## Upgrade to Pro (Stripe checkout)

After a successful `npm run register`, each account lives as a `show/sessions/<email>.<ts>.json` session dump. `npm run upgrade` consumes those sessions + a VCC pool and drives the hosted Stripe checkout end-to-end.

Flow per account:

1. Authenticate. Three policies (`--auth-mode`):
   - `hydrate_or_login` (default) — try to rehydrate the captured `show/sessions/<email>.*.json` first; if the session is expired / the Pro check comes back indeterminate, fall back to a fresh Google OAuth login using the password from `accounts/gsuite.txt`.
   - `hydrate` — cookies + storage only. Fastest; fails hard when the Cognito session has expired.
   - `google_login` — always do a fresh Google OAuth login. Slowest, most reliable, re-triggers Google risk signals.
2. Verify tier on `/account/usage`. If the plan chip already says Pro, skip. If an `Upgrade to Pro` button is rendered, click it.
3. Follow Kiro's redirect to `checkout.stripe.com` (new tab or same tab — handled both ways).
4. Fill the hosted checkout form with the next unused VCC: card number / expiry / CVC, cardholder name, country, address, city, administrative area (select or input depending on country), postal code.
5. Click **Subscribe** and classify the outcome:
   - `success` — Stripe redirects back to Kiro, or hits a `redirect_status=succeeded` URL.
   - `3ds` — an issuer authentication frame appears. Policy controlled by `--on3ds`.
   - `declined` — issuer decline; the next VCC (if `--max-vcc-attempts > 1`) is tried automatically.
   - `validation` — Stripe's own field validation refused the card; VCC is marked invalid and the next one is tried.
   - `timeout` / `error` — the account attempt is recorded as failed.
6. Navigate back to `/account/usage` and verify the Pro badge before marking the account upgraded.

### VCC file

`accounts/vcc.json` — a JSON array (or `{ "cards": [...] }`):

```json
[
  {
    "id": "stable-id-optional",
    "label": "Jane Doe — US",
    "number": "4242 4242 4242 4242",
    "expMonth": 12,
    "expYear": 2029,
    "cvc": "123",
    "billing": {
      "name": "Jane Doe",
      "country": "US",
      "line1": "1600 Amphitheatre Parkway",
      "city": "Mountain View",
      "state": "CA",
      "postalCode": "94043"
    }
  }
]
```

Field aliases accepted: `number` / `pan` / `card` / `cardNumber`, `expiry` (`"MM/YY"` / `"MM/YYYY"` / `"MMYY"`) in place of `expMonth`+`expYear`, `cvc` / `cvv` / `cvn`, `billing.line1` / `address1` / `addressLine1`, `billing.state` / `province` / `administrativeArea`, `billing.postalCode` / `postal` / `zip`. Card numbers that fail Luhn are rejected on load.

`billing.country` **must** be ISO-3166 alpha-2 (`US`, `ID`, `GB`, …) — Stripe's country `<select>` is keyed by that code. For countries that render `administrativeArea` as a dropdown (US, Indonesia, …), `billing.state` must match a Stripe option value exactly (e.g. `"DKI Jakarta"` not `"Jakarta"`).

Use-state is tracked in `accounts/vcc.state.json` keyed by VCC id (derived from last4+expiry+name hash when not supplied). Cards marked `success` / `declined` / `invalid` / `challenge` / `failed` are skipped on subsequent runs — delete the state file to replay.

Both `accounts/vcc.json` and `accounts/vcc.state.json` are gitignored; only `accounts/vcc.example.json` is committed.

### Upgrade CLI

Interactive:

```powershell
npm run upgrade
```

Non-interactive:

```powershell
npm run upgrade -- --count 5 --concurrency 2 -y
npm run upgrade -- --session-file show/sessions/alice.1778670000000.json --headed -y
npm run upgrade -- --count 10 --on3ds pause --3ds-timeout-s 600 --headed -y
npm run upgrade -- --count 3 --max-vcc-attempts 3 --engine chromium-stealth -y
npm run upgrade -- --only alice@you.com,bob@you.com -y
```

Flags:

| flag | default | notes |
|------|---------|-------|
| `--count`, `-n` | 1 | number of accounts to process |
| `--concurrency`, `-c` | 1 | parallel workers |
| `--delayMs`, `-d` | 0 | stagger between task starts |
| `--proxy` | — | http/socks proxy for browser + Node `fetch` |
| `--engine` | `camoufox` | `camoufox` \| `chromium-stealth` \| `chromium-vanilla` |
| `--headed` / `--headless` | `--headless` | |
| `--humanize` / `--no-humanize` | humanize on | camoufox only |
| `--geoip` / `--no-geoip` | geoip on with proxy | camoufox only |
| `--no-fingerprint` | off | disable Chromium fingerprint injection |
| `--sessionsDir` | `show/sessions` | scanned for session JSONs |
| `--session-file` | — | override: a single session JSON |
| `--only` | — | comma-separated emails to include (applied after scan) |
| `--vcc` | `accounts/vcc.json` | VCC pool path |
| `--vcc-state` | `accounts/vcc.state.json` | per-VCC use-state |
| `--accounts` | `accounts/gsuite.txt` | GSuite file — supplies Google passwords for login auth modes |
| `--auth-mode` | `hydrate_or_login` | `hydrate` \| `google_login` \| `hydrate_or_login` |
| `--results` | `show/upgrade-results.json` | run record |
| `--state-file` | `show/upgrade-state.json` | per-account upgrade state |
| `--on3ds` | `auto_flip` | `auto_flip` = relaunch headed and retry; `pause` = wait for manual completion; `fail` = stop |
| `--max-vcc-attempts` | 1 | cards to try per account on decline / validation |
| `--3ds-timeout-s` | 300 | how long to wait when `--on3ds pause` |
| `--non-interactive`, `-y` | — | required for CLI mode |

### 3DS / OTP handling

Indonesian issuers almost always present 3DS when a new card is charged from a datacenter IP. Default `--on3ds auto_flip` closes the headless browser, relaunches headed, and re-drives the flow so the user can complete the challenge in-window. `--on3ds pause` keeps the current browser open and polls until the Kiro host is reached (or `--3ds-timeout-s` expires). `--on3ds fail` skips the account and marks the VCC `challenge` in `vcc.state.json`.

## Layout

```
kiro-auto/
├── accounts/
│   ├── gsuite.example.txt
│   └── vcc.example.json
├── lib/
│   ├── accounts.ts            # txt loader + atomic state for GSuite accounts
│   ├── browser.ts             # engine factory (camoufox | chromium-stealth | chromium-vanilla)
│   ├── google-login.ts        # app.kiro.dev + Google automation + session capture
│   ├── kiro-pro.ts            # Upgrade-to-Pro click + Pro tier verification
│   ├── register.ts            # single-account registration
│   ├── session-hydrate.ts     # restore cookies + localStorage into a fresh context
│   ├── stripe-checkout.ts     # hosted Stripe checkout form fill + submit + classify
│   ├── upgrade.ts             # end-to-end upgrade orchestrator (hydrate → Stripe → verify)
│   ├── vcc.ts                 # VCC file loader + Luhn validation + pool + state
│   └── fingerprint/           # Chromium-side fingerprint injection
├── scripts/
│   ├── register.ts            # bulk registration runner
│   ├── switch.ts              # legacy aor* switcher
│   └── upgrade.ts             # bulk upgrade runner
├── show/
│   ├── results.json           # register run records
│   ├── upgrade-results.json   # upgrade run records
│   ├── upgrade-state.json     # per-account upgrade state (skip already-Pro)
│   └── sessions/              # captured Kiro sessions
└── README.md
```

## Failure modes

Per account, captured in `results.json` and `gsuite.state.json`:

| reason | meaning |
|--------|---------|
| `google_button_not_found` | DOM changed at app.kiro.dev — update selectors |
| `google_redirect_failed` | Kiro `InitiateLogin` call hung / Cognito 5xx |
| `challenge_required` | Google 2FA / device verification / recovery email gate |
| `captcha_required` | reCAPTCHA — needs residential IP and real session history |
| `bot_detection` | fingerprint/IP flagged by Google |
| `wrong_password` | bad creds in accounts file |
| `account_disabled` | Workspace account terminated |
| `consent_screen_unexpected` | first-time tenant consent screen needs admin approval |
| `callback_timeout` | didn't land on app.kiro.dev in 60s after password |

Fresh Workspace accounts on datacenter IPs almost always hit `challenge_required` or `bot_detection`. Residential/ISP-grade proxies materially change pass rate.

## Disclaimer

For personal automation of accounts you own. Obey Google Workspace TOS, Kiro TOS, and local law.
