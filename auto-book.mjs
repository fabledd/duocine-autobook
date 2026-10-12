#!/usr/bin/env node
/**
 * Pathé Auto-Booking Script
 * Flux réel validé le 12/10/2026 — voir docs/PATHE_BOOKING_FLOW.md
 * Réservation de référence : WPQSTNJ (CinéPass Gold Duo, 0 €)
 *
 * Runs via GitHub Actions every 5 minutes
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const API_URL = process.env.DUOCINE_API_URL || 'https://duocine.com';
const SESSION_FILE = process.env.PATHE_SESSION_FILE || './pathe-session.json';
const LOG_FILE = './booking-log.json';

/** 15 minutes max entre sélection de place et validation commande */
const SESSION_BUDGET_MS = 14 * 60 * 1000;

async function fetchPendingOrders() {
  try {
    const res = await fetch(`${API_URL}/api/cinema/book`, {
      headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET}` }
    });
    const data = await res.json();
    return data.pendingOrders || [];
  } catch (err) {
    console.error('Failed to fetch orders:', err.message);
    return [];
  }
}

/**
 * Réservation complète sur s.pathe.fr
 * order: { movieSlug, cinemaId, cinemaNum, date, time, seats[], bookingUrl? }
 *
 * - bookingUrl : URL s.pathe.fr/fr/{ID}/booking?pos=...&token=... si déjà lancée
 * - sinon on part d'une URL de séance connue
 */
async function bookOnPathe(page, order) {
  const started = Date.now();
  console.log(`Booking: ${order.movieTitle || order.movieSlug} @ ${order.time} seats=${(order.seats||['auto']).join(',')}`);

  // ── Atteindre la page de sélection des places ──────────────────────────
  // pos=c2VhdGluZw%3D%3D == base64("seating")
  const seatingUrl = order.bookingUrl
    ? order.bookingUrl
    : `https://s.pathe.fr/fr/${order.patheSessionId}/booking?pos=c2VhdGluZw%3D%3D&token=${order.patheToken}`;

  await page.goto(seatingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('td.seat', { timeout: 15000 });

  // Détection session expirée
  const expired = page.getByText('Votre session a expiré', { exact: false });
  if (await expired.count()) {
    const restart = page.getByText('Recommencer', { exact: true });
    if (await restart.count()) {
      await restart.click();
      await page.waitForSelector('td.seat', { timeout: 15000 });
    } else {
      throw new Error('session_expired_no_restart');
    }
  }

  // ── [1] Sélection des places ───────────────────────────────────────────
  const seatsNeeded = (order.seats && order.seats.length) || 1;
  for (let i = 0; i < seatsNeeded; i++) {
    // Priorité aux places standard (éviter PMR si possible)
    let seat = page.locator('td[data-status="available"]:not([data-seattypecode="DIS"])').first();
    if (!(await seat.count())) {
      seat = page.locator('td[data-status="available"]').first();
    }
    if (!(await seat.count())) {
      throw new Error('no_free_seat');
    }
    await seat.click();
    await page.waitForTimeout(300);

    // Popin PMR (places data-seattypecode="DIS")
    const pmrOk = page.getByRole('button', { name: "J'ai compris", exact: true });
    if (await pmrOk.count()) {
      await pmrOk.click();
      await page.waitForTimeout(200);
    }
  }

  // Vérifier la sélection
  const selected = await page.locator('td[data-status="selected"]').count();
  if (selected < seatsNeeded) {
    throw new Error(`seat_select_failed selected=${selected} needed=${seatsNeeded}`);
  }
  console.log(`  seats selected: ${selected}`);

  // ── Valider → page tarifs ──────────────────────────────────────────────
  await page.locator('button').filter({ hasText: /^Valider$/ }).click();
  await page.waitForURL(/pos=cHJpY2luZw/, { timeout: 10000 });
  console.log('  pricing page OK');

  // ── [2] Tarifs : Cinépass Gold Duo (0 €) ───────────────────────────────
  // 1re place = "Cinépass de Redwan", 2e place = "Mon Accompagnant CinéPass"
  const tariffNames = ['Cinépass de Redwan', 'Mon Accompagnant CinéPass'];
  for (let i = 0; i < seatsNeeded && i < tariffNames.length; i++) {
    const plus = page.locator('li').filter({ hasText: tariffNames[i] }).locator('button.more-btn');
    if (await plus.count()) {
      await plus.click();
      await page.waitForTimeout(150);
    } else {
      console.warn(`  tariff not found: ${tariffNames[i]}`);
    }
  }

  // Vérifier le bouton de confirmation
  const confirmBtn = page.getByText('Valider ma commande', { exact: true });
  await confirmBtn.waitFor({ state: 'visible', timeout: 5000 });

  // ── [3] Valider la commande (rapide — budget 15 min) ───────────────────
  const elapsed = Date.now() - started;
  if (elapsed > SESSION_BUDGET_MS) {
    throw new Error(`session_budget_exceeded ${elapsed}ms`);
  }
  await confirmBtn.click();
  console.log(`  order submitted after ${Math.round(elapsed / 1000)}s`);

  // ── [4] Confirmation ───────────────────────────────────────────────────
  await page.waitForURL(/confirmation/, { timeout: 20000 });
  await page.waitForTimeout(1500);

  const body = await page.locator('body').innerText();
  const refMatch = body.match(/N° de réservation\s*:\s*([A-Z0-9]+)/i);
  const ref = refMatch ? refMatch[1] : 'UNKNOWN-' + Date.now().toString(36).toUpperCase();

  // URL e-billet / QR (cookies requis)
  let ticketUrl = null;
  const url = page.url(); // .../confirmation?token=TOKEN
  const tokenMatch = url.match(/token=([^&]+)/);
  const cinemaNum = (url.match(/\/fr\/V(\d+)/) || [])[1] || order.cinemaNum || '';
  if (tokenMatch) {
    ticketUrl = `https://s.pathe.fr/api/order/fr-FR/${cinemaNum}/${tokenMatch[1]}/complementary_ticket/img`;
  }

  console.log(`  ✅ ref=${ref}`);
  return {
    success: true,
    ref,
    ticketUrl,
    seats: (order.seats && order.seats.length) ? order.seats : [`auto-${selected}`],
    elapsedMs: elapsed,
  };
}

async function main() {
  const SIMULATION = process.env.PATHE_BOOKING_SIMULATION === 'true';
  console.log(`Mode: ${SIMULATION ? 'SIMULATION' : 'RÉEL'}`);

  if (SIMULATION) {
    // Ne crée pas de vraie réservation — sert aux tests CI
    console.log('✅ Simulation - réservation test (non envoyée à Pathé)');
    console.log('  Ref: SIM-' + Date.now().toString(36).toUpperCase());
    return;
  }

  console.log('🎬 Pathé Auto-Booking started');
  console.log('Time:', new Date().toISOString());

  const orders = await fetchPendingOrders();
  console.log(`📋 ${orders.length} pending orders`);
  if (orders.length === 0) {
    console.log('✅ Nothing to book');
    writeFileSync(LOG_FILE, JSON.stringify({ timestamp: new Date().toISOString(), orders: 0, results: [] }));
    return;
  }

  if (!existsSync(SESSION_FILE)) {
    console.log('⚠️  No session file — run scripts/pathe-login.mjs first');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: existsSync(SESSION_FILE) ? SESSION_FILE : undefined,
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
  });
  const page = await context.newPage();

  const results = [];
  for (const order of orders) {
    try {
      // Règle des 10 minutes avant la séance
      const showtime = new Date(`${order.date}T${order.time}`);
      const minutesUntil = (showtime.getTime() - Date.now()) / 60000;
      if (minutesUntil < 10) {
        console.log(`⏰ Order ${order.id}: too late (${Math.floor(minutesUntil)} min)`);
        results.push({ orderId: order.id, status: 'skipped', reason: 'too_late' });
        continue;
      }

      const result = await bookOnPathe(page, order);
      results.push({ orderId: order.id, ...result, status: 'booked' });
      console.log(`✅ Order ${order.id}: booked ref=${result.ref}`);

      try {
        await fetch(`${API_URL}/api/cinema/book`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.CRON_SECRET}`,
          },
          body: JSON.stringify({
            orderId: order.id,
            status: 'confirmed',
            bookingRef: result.ref,
            ticketUrl: result.ticketUrl,
          }),
        });
      } catch (apiErr) {
        console.warn('API update failed:', apiErr.message);
      }
    } catch (err) {
      console.error(`❌ Order ${order.id}:`, err.message);
      results.push({ orderId: order.id, status: 'failed', error: err.message });
    }
  }

  await browser.close();

  const log = {
    timestamp: new Date().toISOString(),
    orders: orders.length,
    results,
    summary: {
      booked: results.filter(r => r.status === 'booked').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      failed: results.filter(r => r.status === 'failed').length,
    }
  };
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  console.log(`🎬 Done: ${log.summary.booked} booked, ${log.summary.skipped} skipped, ${log.summary.failed} failed`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
