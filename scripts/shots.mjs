/**
 * Demo ekran görüntülərini çəkir (README və paylaşım üçün).
 * Server işlək olmalıdır: npm start
 *
 * İstifadə:  npm run shots
 */

import puppeteer from "puppeteer-core";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "docs");
const BASE = process.env.SHOT_URL || "http://localhost:3100";

const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await fs.mkdir(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--hide-scrollbars",
      "--window-size=1600,1000",
    ],
    defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 2 },
  });

  const page = await browser.newPage();

  console.log("Səhifə açılır…");
  await page.goto(`${BASE}/?compare=1`, { waitUntil: "networkidle2", timeout: 90_000 });

  // Başlanğıc ekranı hazır olana qədər gözləyirik
  await page.waitForFunction(() => !document.getElementById("startBtn").disabled, {
    timeout: 90_000,
  });
  await sleep(2500);

  console.log("1/4 — başlanğıc ekranı");
  await page.screenshot({ path: path.join(OUT, "01-splash.png") });

  await page.click("#startBtn");

  // Statistikanın oturuşması üçün kifayət qədər qərar toplanmalıdır
  console.log("Qərarlar toplanır (~2 dəq)…");
  await page.waitForFunction(
    () => Number(document.getElementById("jevCalls").textContent) >= 12,
    { timeout: 240_000, polling: 2000 }
  );
  await sleep(4000);

  console.log("2/4 — əsas panel");
  await page.screenshot({ path: path.join(OUT, "02-dispatch.png") });

  // Yaxınlaşdırılmış görünüş: 3D taksilər və binalar aydın görünsün
  console.log("3/4 — yaxın plan");
  await page.mouse.move(600, 500);
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel({ deltaY: -240 });
    await sleep(900);
  }
  await sleep(6000);
  await page.screenshot({ path: path.join(OUT, "03-closeup.png") });

  console.log("4/4 — izahat paneli");
  await page.evaluate(() => document.getElementById("drawer").classList.add("open"));
  await sleep(1200);
  await page.screenshot({ path: path.join(OUT, "04-explainer.png") });

  const stats = await page.evaluate(() => ({
    jev: document.getElementById("jevMedian").textContent,
    llm: document.getElementById("llmMedian").textContent,
    verdict: document.getElementById("verdict").textContent.trim(),
  }));

  await browser.close();

  console.log(`\nHazırdır → ${OUT}`);
  console.log(`JEV ${stats.jev}ms · LLM ${stats.llm}ms`);
  console.log(stats.verdict);
}

main().catch((err) => {
  console.error("Xəta:", err.message);
  process.exit(1);
});
