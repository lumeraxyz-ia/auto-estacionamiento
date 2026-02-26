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
  const D = tomorrowDayNumberLima(); // tu función actual

  // Asegura que el calendario esté visible
  await page.getByText(/Febrero|February|FECHA/i).first().scrollIntoViewIfNeeded().catch(()=>{});
  await page.waitForTimeout(200);

  // 1) candidatos: botones reales + elementos con rol
  const candidates = page.locator('button, [role="button"], [role="gridcell"]');

  const n = await candidates.count();
  for (let i = 0; i < Math.min(n, 400); i++) {
    const el = candidates.nth(i);

    // visible
    const visible = await el.isVisible().catch(()=>false);
    if (!visible) continue;

    // texto debe contener el número del día como token (27, no 127)
    const txt = (await el.innerText().catch(()=>''))?.replace(/\s+/g,' ').trim();
    if (!txt) continue;

    // match “27” como token
    if (!new RegExp(`(^|\\D)${D}(\\D|$)`).test(txt)) continue;

    // no disabled (disabled o aria-disabled)
    const disabledProp = await el.isDisabled().catch(()=>false);
    if (disabledProp) continue;

    const ariaDisabled = await el.getAttribute('aria-disabled').catch(()=>null);
    if (ariaDisabled && ariaDisabled.toLowerCase() === 'true') continue;

    // intenta click
    await el.scrollIntoViewIfNeeded().catch(()=>{});
    await el.click({ timeout: 5000 }).catch(()=>{});
    await page.waitForTimeout(150);

    // si después del click aparece hora o se marca selección, damos por OK
    const hourSection = page.locator('text=/HORA|HOUR/i');
    if (await hourSection.count()) return true;

    // aunque no detectemos sección, igual devolvemos true porque pudo haber seleccionado
    return true;
  }

  return false;
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

  const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ],
});
  const page = await browser.newPage();

  // Timeouts más altos
page.setDefaultNavigationTimeout(120000); // 2 min
page.setDefaultTimeout(60000);            // 60s para waits/clicks

// Señales anti-headless básico
await page.setExtraHTTPHeaders({
  "Accept-Language": "es-PE,es;q=0.9,en;q=0.8",
});
await page.setViewportSize({ width: 1280, height: 720 });

// Reintento de navegación (3 tries)
let lastErr;
for (let i = 1; i <= 3; i++) {
  try {
    await page.goto(bookingUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    lastErr = null;
    break;
  } catch (e) {
    lastErr = e;
    await page.waitForTimeout(1500 * i);
  }
}
if (lastErr) throw lastErr;

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
  if (!okDate) {
  await browser.close();
  return { status: "NO_SLOTS_TOMORROW", confirmed: false };
}

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
return { status: confirmed ? "BOOKED_CONFIRMED" : "BOOKED_UNCONFIRMED", confirmed };
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
