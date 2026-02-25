import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

const BOOKING_URL_DEFAULT =
  "https://outlook.office365.com/book/Reservadeestacionamiento@pacifico.com.pe/?ismsaljsauthenabled=true";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getLimaNowParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value;
  return { hh: +get("hour"), mm: +get("minute"), ss: +get("second") };
}

function tomorrowDayNumberLima() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date()); // YYYY-MM-DD
  const [Y, M, D] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(Y, M - 1, D, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.getUTCDate();
}

async function clickTomorrow(page) {
  const D = tomorrowDayNumberLima();

  // intenta por aria-label
  const aria = page.locator(`button[aria-label*="${D}"]`);
  const ariaCount = await aria.count();
  for (let i = 0; i < ariaCount; i++) {
    const btn = aria.nth(i);
    if (await btn.isVisible().catch(() => false)) {
      if (!(await btn.isDisabled().catch(() => false))) {
        await btn.click();
        return true;
      }
    }
  }

  // intenta por texto del día
  const dayButtons = page.locator("button", { hasText: new RegExp(`^${D}$`) });
  const n = await dayButtons.count();
  for (let i = 0; i < n; i++) {
    const btn = dayButtons.nth(i);
    if (await btn.isVisible().catch(() => false)) {
      if (!(await btn.isDisabled().catch(() => false))) {
        await btn.click();
        return true;
      }
    }
  }

  // fallback: primer botón habilitado con número (si solo hay 1 opción “activa”)
  const enabled = page.locator("button:not([disabled])");
  const total = await enabled.count();
  for (let i = 0; i < Math.min(total, 200); i++) {
    const b = enabled.nth(i);
    const txt = (await b.innerText().catch(() => "")).trim();
    if (/^\d{1,2}$/.test(txt)) {
      await b.click();
      return true;
    }
  }

  return false;
}

async function pickFirstAvailableTime(page) {
  const timeBtn = page.getByRole("button").filter({ hasText: /(\d{1,2}:\d{2})|AM|PM|am|pm/ }).first();
  if (await timeBtn.count()) { await timeBtn.click(); return true; }

  const fallback = page.getByRole("button").filter({ hasText: /dispon|avail|reserv/i }).first();
  if (await fallback.count()) { await fallback.click(); return true; }

  return false;
}

async function runBooking({ url, fullName, email, dni }) {
  const bookingUrl = url || BOOKING_URL_DEFAULT;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(bookingUrl, { waitUntil: "domcontentloaded" });

  // Si te disparas 23:59:55 desde n8n, espera a 00:00 y recarga
  const t = getLimaNowParts();
  if (t.hh === 23 && t.mm === 59) {
    const msToMidnight = ((60 - t.ss) * 1000) + 250;
    await sleep(Math.max(msToMidnight, 0));
    await page.reload({ waitUntil: "networkidle" });
  } else {
    await page.waitForLoadState("networkidle");
  }

  // selecciona mañana
  const okDate = await clickTomorrow(page);
  if (!okDate) throw new Error("No pude seleccionar la fecha (mañana).");

  // selecciona hora disponible
  await page.waitForTimeout(400);
  let okTime = await pickFirstAvailableTime(page);
  if (!okTime) {
    await page.getByText(/HORA/i).scrollIntoViewIfNeeded().catch(()=>{});
    await page.waitForTimeout(300);
    okTime = await pickFirstAvailableTime(page);
    if (!okTime) throw new Error("No encontré un horario disponible.");
  }

  // completa campos
  await page.getByLabel(/Nombre y apellidos/i).fill(fullName);
  await page.getByLabel(/Correo electr[oó]nico/i).fill(email);
  await page.getByLabel(/^DNI/i).fill(dni);

  // reservar
  const reservarBtn = page.getByRole("button").filter({ hasText: /^Reservar$/i }).first();
  if (!(await reservarBtn.count())) throw new Error('No encontré el botón "Reservar".');

  await reservarBtn.click();
  await page.waitForTimeout(1200);

  // señal de confirmación (variable)
  const confirm = page.locator('text=/confirm|reservad|gracias|confirmed|booked/i');
  const confirmed = (await confirm.count()) > 0;

  await browser.close();
  return { confirmed };
}

// Endpoint que n8n llamará
app.post("/reserve", async (req, res) => {
  try {
    const { url, fullName, email, dni, token } = req.body || {};

    // token simple para que nadie te abuse el endpoint
    if (process.env.API_TOKEN && token !== process.env.API_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    if (!fullName || !email || !dni) {
      return res.status(400).json({ ok: false, error: "Missing fullName/email/dni" });
    }

    const result = await runBooking({ url, fullName, email, dni });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/", (_req, res) => res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on", port));
