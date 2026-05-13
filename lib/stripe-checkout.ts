import type { Page, Frame, Locator } from 'playwright'
import type { VccEntry } from './vcc'

type LogCallback = (message: string) => void

export type StripeSubmitOutcome =
  /** Subscription succeeded — either the success page or a Kiro redirect. */
  | { kind: 'success'; finalUrl: string }
  /** Stripe prompted 3DS / OTP / OOB. `frameUrl` is the challenge iframe URL when detected. */
  | { kind: '3ds'; frameUrl?: string }
  /** Card was declined by the issuer. */
  | { kind: 'declined'; message: string }
  /** Stripe refused to submit due to field-level validation (bad card, bad expiry…). */
  | { kind: 'validation'; message: string; field?: string }
  /** Nothing observable happened in time — rare; usually a Stripe outage. */
  | { kind: 'timeout'; detail?: string }
  /** Generic Stripe-reported error that isn't a decline (e.g. processing_error). */
  | { kind: 'error'; message: string }

export type FillOptions = {
  /** Abort if the form isn't found / hydrated within this many ms. */
  formTimeoutMs?: number
  /** Timeout after Subscribe click for observable outcome. */
  submitTimeoutMs?: number
}

const CARD_NUMBER_SELECTOR = '#cardNumber, input[name="cardNumber"], input[autocomplete="cc-number"]'
const CARD_EXPIRY_SELECTOR = '#cardExpiry, input[name="cardExpiry"], input[autocomplete="cc-exp"]'
const CARD_CVC_SELECTOR = '#cardCvc, input[name="cardCvc"], input[autocomplete="cc-csc"]'
const BILLING_NAME_SELECTOR = '#billingName, input[name="billingName"], input[autocomplete="cc-name"]'
const BILLING_COUNTRY_SELECTOR =
  '#billingCountry, select[name="billingCountry"], select[autocomplete="billing country"]'
const BILLING_LINE1_SELECTOR = '#billingAddressLine1, input[name="billingAddressLine1"]'
const BILLING_LINE2_SELECTOR = '#billingAddressLine2, input[name="billingAddressLine2"]'
const BILLING_CITY_SELECTOR = '#billingLocality, input[name="billingLocality"]'
const BILLING_ADMIN_SELECTOR = '#billingAdministrativeArea, [name="billingAdministrativeArea"]'
const BILLING_POSTAL_SELECTOR = '#billingPostalCode, input[name="billingPostalCode"]'

const SUBMIT_BUTTON_SELECTOR =
  'button[data-testid="hosted-payment-submit-button"], button.SubmitButton[type="submit"]'

const FIELD_ERROR_SELECTOR = '.FieldError, span.FieldError'

function padMonth(m: number): string {
  return String(m).padStart(2, '0')
}

function expiryTyping(expMonth: number, expYear: number): string {
  // Stripe expects "MMYY" — the field auto-formats it into "MM / YY".
  // Typing the slash manually causes it to reject the value.
  const yy = String(expYear).slice(-2).padStart(2, '0')
  return `${padMonth(expMonth)}${yy}`
}

/** Type into a Stripe input one character at a time — their formatter only
 *  fires on InputEvent, so `.fill()` can leave the input in a half-validated
 *  state ("Your card number is incomplete"). */
async function typeInput(locator: Locator, value: string, delay = 35): Promise<void> {
  await locator.scrollIntoViewIfNeeded().catch(() => {})
  await locator.click({ timeout: 5000 })
  // Clear whatever's there — triple-click won't work on short inputs, so select-all.
  await locator.press('ControlOrMeta+A').catch(() => {})
  await locator.press('Delete').catch(() => {})
  await locator.pressSequentially(value, { delay })
  await locator.press('Tab').catch(() => {})
}

async function setSelectByValueOrLabel(
  page: Page,
  selector: string,
  value: string,
  log: LogCallback
): Promise<boolean> {
  // selectOption falls back to label if value doesn't match, but Stripe's
  // administrativeArea sometimes uses the full country name rather than the
  // code — we try value first, then label, then a case-insensitive label.
  const loc = page.locator(selector).first()
  try {
    await loc.selectOption({ value }, { timeout: 3000 })
    return true
  } catch {}
  try {
    await loc.selectOption({ label: value }, { timeout: 3000 })
    return true
  } catch {}
  try {
    const options = await loc.locator('option').all()
    for (const opt of options) {
      const optValue = (await opt.getAttribute('value')) ?? ''
      const optText = ((await opt.textContent()) ?? '').trim()
      if (
        optValue.toLowerCase() === value.toLowerCase() ||
        optText.toLowerCase() === value.toLowerCase() ||
        optText.toLowerCase().startsWith(`${value.toLowerCase()} `) ||
        optText.toLowerCase().includes(` — ${value.toLowerCase()}`)
      ) {
        await loc.selectOption({ value: optValue }, { timeout: 3000 })
        return true
      }
    }
  } catch (e) {
    log(`[stripe] select "${selector}" match-by-option failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  return false
}

/** Is this field rendered as a <select>? Country-dependent — US/ID use a select
 *  for administrativeArea, FR/DE use a text input. */
async function isSelect(page: Page, selector: string): Promise<boolean> {
  const tag = await page
    .locator(selector)
    .first()
    .evaluate((el) => (el as HTMLElement).tagName.toLowerCase())
    .catch(() => '')
  return tag === 'select'
}

async function waitForField(page: Page, selector: string, timeoutMs: number): Promise<boolean> {
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

/** Collect any user-facing field error currently visible in the form.
 *  Stripe keeps FieldError spans in the DOM but hides them with opacity:0
 *  when the field is clean, so we filter by rendered visibility. */
async function readFieldErrors(page: Page): Promise<string[]> {
  try {
    const texts = await page
      .locator(FIELD_ERROR_SELECTOR)
      .evaluateAll((els) =>
        els
          .filter((el) => {
            const cs = window.getComputedStyle(el as HTMLElement)
            if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none') {
              return false
            }
            const h = (el as HTMLElement).offsetHeight
            return h > 0
          })
          .map((el) => (el.textContent ?? '').trim())
          .filter((t) => t.length > 0)
      )
    return Array.from(new Set(texts))
  } catch {
    return []
  }
}

function looksLikeDecline(text: string): boolean {
  const s = text.toLowerCase()
  return (
    /(declin)/i.test(s) ||
    /insufficient funds/i.test(s) ||
    /card (?:was|has been) declined/i.test(s) ||
    /do not honou?r/i.test(s) ||
    /lost card|stolen card|pickup card/i.test(s) ||
    /card (?:is )?(?:blocked|restricted|not supported)/i.test(s) ||
    /cannot be used for this payment/i.test(s) ||
    /issuer|bank/i.test(s) && /(?:declin|reject|refuse)/i.test(s)
  )
}

function looksLikeValidation(text: string): boolean {
  const s = text.toLowerCase()
  return (
    /incomplete|invalid|not valid|must be|required/.test(s) &&
    !looksLikeDecline(s)
  )
}

function looksLikeThreeDs(frameUrl: string): boolean {
  return /hooks\.stripe\.com\/(?:3d_secure|redirect)|three[-_]?ds|3d-secure|authenticate|stripe\.network\/authorize/i.test(
    frameUrl
  )
}

async function findThreeDsFrame(page: Page): Promise<Frame | null> {
  for (const frame of page.frames()) {
    const url = frame.url()
    if (!url) continue
    if (looksLikeThreeDs(url)) return frame
  }
  // Some builds render 3DS in a top-level modal iframe with title "3D Secure".
  try {
    const modal = await page
      .locator(
        'iframe[name*="3ds" i], iframe[title*="3D Secure" i], iframe[title*="authenticate" i], iframe[src*="3d_secure"]'
      )
      .first()
      .elementHandle({ timeout: 200 })
    if (modal) {
      const frame = await modal.contentFrame()
      if (frame) return frame
    }
  } catch {}
  return null
}

async function fillBillingAddress(
  page: Page,
  vcc: VccEntry,
  log: LogCallback,
  timeoutMs: number
): Promise<void> {
  // Cardholder name.
  if (await waitForField(page, BILLING_NAME_SELECTOR, timeoutMs)) {
    await typeInput(page.locator(BILLING_NAME_SELECTOR).first(), vcc.billing.name)
  }

  // Country. This MUST be set first — Stripe rebuilds the rest of the billing
  // form (admin area select vs input, postal code pattern, etc.) based on it.
  if (await waitForField(page, BILLING_COUNTRY_SELECTOR, timeoutMs)) {
    const ok = await setSelectByValueOrLabel(page, BILLING_COUNTRY_SELECTOR, vcc.billing.country, log)
    if (!ok) {
      throw new Error(
        `stripe: could not select country "${vcc.billing.country}" (must be ISO-3166 alpha-2)`
      )
    }
    // Let Stripe re-render the dependent fields.
    await page.waitForTimeout(600)
  }

  // Line 1 / 2.
  if (await waitForField(page, BILLING_LINE1_SELECTOR, timeoutMs)) {
    await typeInput(page.locator(BILLING_LINE1_SELECTOR).first(), vcc.billing.line1)
  }
  if (vcc.billing.line2) {
    const hasLine2 = await page
      .locator(BILLING_LINE2_SELECTOR)
      .first()
      .isVisible()
      .catch(() => false)
    if (hasLine2) {
      await typeInput(page.locator(BILLING_LINE2_SELECTOR).first(), vcc.billing.line2)
    }
  }

  // City.
  if (await waitForField(page, BILLING_CITY_SELECTOR, 3000)) {
    await typeInput(page.locator(BILLING_CITY_SELECTOR).first(), vcc.billing.city)
  }

  // Administrative area — may be <select> or <input> depending on country.
  const adminVisible = await page
    .locator(BILLING_ADMIN_SELECTOR)
    .first()
    .isVisible()
    .catch(() => false)
  if (adminVisible && vcc.billing.state) {
    if (await isSelect(page, BILLING_ADMIN_SELECTOR)) {
      const ok = await setSelectByValueOrLabel(
        page,
        BILLING_ADMIN_SELECTOR,
        vcc.billing.state,
        log
      )
      if (!ok) {
        log(
          `[stripe] WARN: administrative area "${vcc.billing.state}" not found in dropdown — leaving blank`
        )
      }
    } else {
      await typeInput(page.locator(BILLING_ADMIN_SELECTOR).first(), vcc.billing.state)
    }
  }

  // Postal code.
  if (await waitForField(page, BILLING_POSTAL_SELECTOR, 3000)) {
    await typeInput(page.locator(BILLING_POSTAL_SELECTOR).first(), vcc.billing.postalCode)
  }
}

/**
 * Fill the Stripe hosted checkout form with a single VCC.
 *
 * Returns after fields are typed + Tab-blurred but BEFORE Subscribe is clicked.
 * Caller invokes `submitAndClassify` separately so it can decide retry policy
 * on top of the classified outcome.
 */
export async function fillStripeCheckout(
  page: Page,
  vcc: VccEntry,
  log: LogCallback,
  options: FillOptions = {}
): Promise<void> {
  const formTimeout = options.formTimeoutMs ?? 30000
  log(`[stripe] waiting for hosted checkout form to hydrate`)

  // Card number is the canonical sentinel — when it's mounted, the form is live.
  if (!(await waitForField(page, CARD_NUMBER_SELECTOR, formTimeout))) {
    throw new Error('stripe: card number field never appeared')
  }

  log(
    `[stripe] filling card last4=${vcc.number.slice(-4)} exp=${padMonth(vcc.expMonth)}/${String(
      vcc.expYear
    ).slice(-2)} brand=${vcc.brand ?? 'auto'}`
  )

  await typeInput(page.locator(CARD_NUMBER_SELECTOR).first(), vcc.number)
  await typeInput(
    page.locator(CARD_EXPIRY_SELECTOR).first(),
    expiryTyping(vcc.expMonth, vcc.expYear)
  )
  await typeInput(page.locator(CARD_CVC_SELECTOR).first(), vcc.cvc)

  await fillBillingAddress(page, vcc, log, 8000)

  // Surface any immediate field-level errors Stripe flagged while typing
  // (bad card number, wrong length CVC, etc.). Non-fatal here — the caller's
  // submit step will re-read the same errors.
  const preErrors = await readFieldErrors(page)
  if (preErrors.length > 0) {
    log(`[stripe] pre-submit field errors: ${preErrors.join(' | ')}`)
  }
}

/**
 * Click Subscribe and classify the outcome. This is deliberately split from
 * the filling step so retry policies can reuse a loaded form with a new VCC
 * if desired (delete fields → re-fill → re-submit).
 */
export async function submitAndClassify(
  page: Page,
  log: LogCallback,
  options: FillOptions = {}
): Promise<StripeSubmitOutcome> {
  const submitTimeout = options.submitTimeoutMs ?? 90000

  const submitLoc = page.locator(SUBMIT_BUTTON_SELECTOR).first()
  try {
    await submitLoc.waitFor({ state: 'visible', timeout: 10000 })
  } catch {
    return {
      kind: 'error',
      message: 'Subscribe button never appeared'
    }
  }

  log('[stripe] clicking Subscribe')
  await submitLoc.scrollIntoViewIfNeeded().catch(() => {})
  await submitLoc.click({ timeout: 5000 })

  // Poll for any of: success navigation, 3DS frame, decline/validation text.
  const deadline = Date.now() + submitTimeout
  let lastLoggedState = ''
  while (Date.now() < deadline) {
    if (page.isClosed()) {
      return { kind: 'timeout', detail: 'page closed unexpectedly' }
    }

    const currentUrl = page.url()

    // Success — Stripe redirects back to a Kiro / session URL or its own
    // /p/p_… success route.
    try {
      const host = new URL(currentUrl).hostname
      if (
        host.endsWith('kiro.dev') ||
        /\/p\/p_[a-z0-9]+\/?success/i.test(currentUrl) ||
        /[?&](?:redirect_status|payment_intent_status)=succeeded/i.test(currentUrl)
      ) {
        log(`[stripe] resolved to success URL ${currentUrl}`)
        return { kind: 'success', finalUrl: currentUrl }
      }
    } catch {}

    // 3DS detection.
    const threeDsFrame = await findThreeDsFrame(page)
    if (threeDsFrame) {
      const frameUrl = threeDsFrame.url()
      log(`[stripe] detected 3DS challenge frame: ${frameUrl}`)
      return { kind: '3ds', frameUrl }
    }

    // Field-level errors (non-zero opacity).
    const errs = await readFieldErrors(page)
    if (errs.length > 0) {
      const joined = errs.join(' | ')
      if (joined !== lastLoggedState) {
        log(`[stripe] field errors: ${joined}`)
        lastLoggedState = joined
      }
      if (errs.some(looksLikeDecline)) {
        return { kind: 'declined', message: joined }
      }
      if (errs.some(looksLikeValidation)) {
        return { kind: 'validation', message: joined }
      }
    }

    // Top-of-form banner (Stripe's generic error region).
    const banner = await page
      .locator(
        '[data-testid="payment-form-global-error"], .PaymentForm-error, [role="alert"]'
      )
      .first()
      .textContent()
      .catch(() => null)
    if (banner && banner.trim()) {
      const msg = banner.trim()
      if (looksLikeDecline(msg)) return { kind: 'declined', message: msg }
      if (looksLikeValidation(msg)) return { kind: 'validation', message: msg }
      // Non-empty alert we can't classify — keep polling; it may clear.
      if (msg !== lastLoggedState) {
        log(`[stripe] banner: ${msg}`)
        lastLoggedState = msg
      }
    }

    await page.waitForTimeout(750)
  }

  // Final attempt — maybe we're already on a success destination we missed.
  try {
    const host = new URL(page.url()).hostname
    if (host.endsWith('kiro.dev')) {
      return { kind: 'success', finalUrl: page.url() }
    }
  } catch {}
  return { kind: 'timeout', detail: `last url: ${page.url()}` }
}

/**
 * Convenience wrapper: fill + submit + classify in one call.
 */
export async function runStripeCheckout(
  page: Page,
  vcc: VccEntry,
  log: LogCallback,
  options: FillOptions = {}
): Promise<StripeSubmitOutcome> {
  await fillStripeCheckout(page, vcc, log, options)
  return submitAndClassify(page, log, options)
}
