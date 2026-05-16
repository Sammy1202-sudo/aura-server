const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const SECRET = process.env.AURA_SECRET || 'aura-secret-key';

// Auth middleware
function auth(req, res, next) {
  const key = req.headers['x-aura-key'];
  if (key !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'AURA Server running', version: '1.0.0' });
});

// ── Helper: build OpenTable slug from restaurant name ──
function toSlug(name) {
  return name
    .toLowerCase()
    .replace(/[äöüß]/g, c => ({'ä':'ae','ö':'oe','ü':'ue','ß':'ss'}[c]))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Restaurant reservation via OpenTable ──
app.post('/reserve/restaurant', auth, async (req, res) => {
  const { restaurant, date, time, party_size, first_name, last_name, email, phone, opentable_url } = req.body;

  if (!restaurant || !date || !time || !party_size) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();

    // Step 1: Go directly to restaurant page with date/time/covers pre-filled
    const slug = opentable_url || toSlug(restaurant);
    const directUrl = `https://www.opentable.de/r/${slug}?covers=${party_size}&dateTime=${date}T${time}:00`;
    console.log(`Opening OpenTable: ${directUrl}`);

    const response = await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Check if page exists
    if (response.status() === 404) {
      // Try search as fallback
      const searchUrl = `https://www.opentable.de/s?covers=${party_size}&dateTime=${date}T${time}:00&term=${encodeURIComponent(restaurant)}&metroId=9`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Click first result
      const firstLink = await page.$('a[href*="/r/"]');
      if (!firstLink) {
        return res.json({ success: false, fallback: 'call', message: `${restaurant} nicht auf OpenTable gefunden` });
      }
      await firstLink.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    }

    await page.waitForTimeout(3000);

    // Step 2: Find available time slots
    // OpenTable uses various selectors depending on version
    const slotSelectors = [
      'button[data-test="time-slot"]',
      '[data-cy="timeslot"]',
      'button[class*="timeslot"]',
      'button[class*="TimeSlot"]',
      'button[class*="time-slot"]',
      '[data-testid*="time"]',
      'button[aria-label*="Uhr"]',
      'button[aria-label*="PM"]',
      'button[aria-label*="AM"]',
    ];

    let timeSlot = null;
    for (const sel of slotSelectors) {
      const slots = await page.$$(sel);
      if (slots.length > 0) {
        console.log(`Found ${slots.length} slots with selector: ${sel}`);
        // Try to find slot closest to requested time
        timeSlot = slots[0];
        break;
      }
    }

    if (!timeSlot) {
      // Take screenshot to debug
      const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
      console.log('No time slots found, page HTML snippet:', await page.content().then(h => h.substring(0, 500)));
      return res.json({
        success: false,
        fallback: 'call',
        message: `Keine Verfügbarkeit um ${time} Uhr bei ${restaurant} gefunden`,
        debug: 'no_slots'
      });
    }

    await timeSlot.click();
    await page.waitForTimeout(2000);

    // Step 3: Fill reservation form
    const fieldMap = [
      { selectors: ['input[name="firstName"]', 'input[id*="firstName"]', 'input[placeholder*="Vorname"]', 'input[autocomplete="given-name"]'], value: first_name || 'Christopher' },
      { selectors: ['input[name="lastName"]', 'input[id*="lastName"]', 'input[placeholder*="Nachname"]', 'input[autocomplete="family-name"]'], value: last_name || 'Steinberger' },
      { selectors: ['input[name="email"]', 'input[type="email"]', 'input[autocomplete="email"]'], value: email || 'booking@aura-assistant.app' },
      { selectors: ['input[name="phone"]', 'input[type="tel"]', 'input[autocomplete="tel"]'], value: phone || '+4917612345678' },
    ];

    for (const field of fieldMap) {
      for (const sel of field.selectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await el.fill(field.value);
            console.log(`Filled ${sel} with ${field.value}`);
            break;
          }
        } catch(e) { continue; }
      }
    }

    await page.waitForTimeout(1000);

    // Step 4: Submit
    const submitSelectors = [
      'button[type="submit"]',
      'button[data-test="complete-reservation"]',
      'button[data-testid*="submit"]',
      'button[class*="submit"]',
      'button:has-text("Reservierung abschließen")',
      'button:has-text("Jetzt reservieren")',
      'button:has-text("Bestätigen")',
    ];

    for (const sel of submitSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          console.log(`Clicked submit: ${sel}`);
          break;
        }
      } catch(e) { continue; }
    }

    await page.waitForTimeout(3000);

    // Step 5: Check confirmation
    const currentUrl = page.url();
    const pageText = await page.textContent('body').catch(() => '');
    const isConfirmed =
      currentUrl.includes('confirmation') ||
      currentUrl.includes('confirmed') ||
      pageText.includes('Bestätigung') ||
      pageText.includes('bestätigt') ||
      pageText.includes('confirmed') ||
      pageText.includes('Reservation confirmed');

    if (isConfirmed) {
      return res.json({
        success: true,
        method: 'opentable',
        message: `Reservierung bestätigt bei ${restaurant} für ${party_size} Personen um ${time} Uhr`,
      });
    } else {
      const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
      console.log('Not confirmed, URL:', currentUrl);
      return res.json({
        success: false,
        fallback: 'call',
        message: `Buchung bei ${restaurant} konnte nicht abgeschlossen werden`,
        debug_url: currentUrl
      });
    }

  } catch (err) {
    console.error('Reservation error:', err.message);
    return res.json({
      success: false,
      error: err.message,
      fallback: 'call',
      message: `Fehler bei ${restaurant} — fallback auf Telefonanruf`
    });
  } finally {
    if (browser) await browser.close();
  }
});

// ── Search restaurant on OpenTable (just check availability) ──
app.post('/search/restaurant', auth, async (req, res) => {
  const { restaurant, date, time, party_size } = req.body;

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({ locale: 'de-DE' });
    const page = await context.newPage();

    const searchUrl = `https://www.opentable.de/s?covers=${party_size}&dateTime=${date}T${time}&term=${encodeURIComponent(restaurant)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Get restaurant results
    const results = await page.$$eval(
      '[data-test="search-result"], .result-item',
      els => els.slice(0, 3).map(el => ({
        name: el.querySelector('h2, [data-test="restaurant-name"]')?.textContent?.trim(),
        rating: el.querySelector('[data-test="rating"]')?.textContent?.trim(),
        cuisine: el.querySelector('[data-test="cuisine"]')?.textContent?.trim(),
      }))
    );

    const hasAvailability = await page.$('[data-test="time-slot"], .timeslot') !== null;

    return res.json({
      success: true,
      results,
      has_availability: hasAvailability,
      searched: restaurant
    });

  } catch (err) {
    return res.json({ success: false, error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// ── Ping ──
app.get('/ping', (req, res) => res.json({ pong: true, time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`AURA Server running on port ${PORT}`);
});
