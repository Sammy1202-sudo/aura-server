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

// ── Restaurant reservation via OpenTable ──
app.post('/reserve/restaurant', auth, async (req, res) => {
  const { restaurant, date, time, party_size, first_name, last_name, email, phone } = req.body;

  if (!restaurant || !date || !time || !party_size) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'de-DE'
    });

    const page = await context.newPage();

    // Step 1: Search OpenTable for the restaurant
    const searchUrl = `https://www.opentable.de/s?covers=${party_size}&dateTime=${date}T${time}&term=${encodeURIComponent(restaurant)}&radius=5`;
    console.log(`Searching OpenTable: ${searchUrl}`);

    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Step 2: Find first restaurant result
    const firstResult = await page.$('[data-test="search-result"]');
    if (!firstResult) {
      // Try alternative selector
      const altResult = await page.$('a[href*="/restaurant/"]');
      if (!altResult) {
        return res.json({
          success: false,
          method: 'opentable',
          message: 'Restaurant nicht auf OpenTable gefunden — versuche direkten Anruf',
          fallback: 'call'
        });
      }
    }

    // Step 3: Click on the restaurant
    await page.click('[data-test="search-result"]:first-child, a[href*="/restaurant/"]:first-child');
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    await page.waitForTimeout(1500);

    // Step 4: Select time slot
    const timeSlots = await page.$$('[data-test="time-slot"], button[data-cy="timeslot"]');
    if (timeSlots.length === 0) {
      return res.json({
        success: false,
        message: 'Keine Verfügbarkeit für diesen Zeitpunkt gefunden',
        fallback: 'call'
      });
    }

    // Click closest time slot
    await timeSlots[0].click();
    await page.waitForTimeout(1000);

    // Step 5: Fill in reservation form
    await page.waitForSelector('input[name="firstName"], input[id*="first"]', { timeout: 10000 });

    await page.fill('input[name="firstName"], input[id*="first"]', first_name || 'Christopher');
    await page.fill('input[name="lastName"], input[id*="last"]', last_name || 'Steinberger');
    await page.fill('input[name="email"], input[type="email"]', email || 'booking@aura.app');
    await page.fill('input[name="phone"], input[type="tel"]', phone || '+4917600000000');

    // Step 6: Submit
    await page.click('button[type="submit"], button[data-test="complete-reservation"]');
    await page.waitForTimeout(2000);

    // Check for confirmation
    const confirmed = await page.$('[data-test="confirmation"], .confirmation, h1:has-text("Bestätigung"), h1:has-text("Confirmed")');

    if (confirmed) {
      const confirmText = await confirmed.textContent();
      return res.json({
        success: true,
        method: 'opentable',
        message: `Reservierung bestätigt bei ${restaurant}`,
        details: {
          restaurant,
          date,
          time,
          party_size,
          confirmation: confirmText?.trim()
        }
      });
    } else {
      // Take screenshot for debugging
      const screenshot = await page.screenshot({ encoding: 'base64' });
      return res.json({
        success: false,
        message: 'Buchung konnte nicht abgeschlossen werden',
        fallback: 'call',
        debug_screenshot: screenshot.substring(0, 100) + '...'
      });
    }

  } catch (err) {
    console.error('Reservation error:', err.message);
    return res.json({
      success: false,
      error: err.message,
      fallback: 'call',
      message: 'Fehler bei der Buchung — fallback auf Telefonanruf'
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
