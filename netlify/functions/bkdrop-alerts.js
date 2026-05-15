// Alertas automáticas por Telegram cuando una campaña gasta sin convertir.
// - Corre cada 15 minutos via Netlify Scheduled Functions.
// - Revisa campañas activas hoy en TikTok + Meta (Chile + GT).
// - Umbrales (en CLP):
//     🟡 gasto >= $10.000 + 0 órdenes reales
//     🟠 gasto >= $15.000 + 1 orden real
// - Anti-spam: cada (campaign_id + tipo) se notifica una sola vez por día.
//   Storage en Netlify Blobs ('bk-alerts'/'sent_YYYY-MM-DD').

import { getStore } from '@netlify/blobs';

const THRESHOLD_NO_SALES = 10000;   // CLP
const THRESHOLD_ONE_SALE = 15000;   // CLP

export default async function handler(req) {
  const url = new URL(req.url);
  const preview = url.searchParams.get('preview') === '1';
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  if (!preview && (!botToken || !chatId)) {
    return new Response('Telegram no configurado (faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID).', { status: 200 });
  }

  // Fecha local Chile (UTC-3 verano / -4 invierno; simplificamos a UTC-3)
  const now = new Date(Date.now() - 3 * 3600 * 1000);
  const todayCL = now.toISOString().slice(0, 10);

  // Storage de alertas ya enviadas hoy (preview no actualiza, solo lee)
  const alertStore = getStore({ name: 'bk-alerts', consistency: 'strong' });
  const sentKey = 'sent_' + todayCL;
  let sent = (await alertStore.get(sentKey, { type: 'json' })) || {};
  // En preview, ignoramos el anti-spam para mostrar TODAS las alertas activas del día.
  if (preview) sent = {};

  // Origin para llamar a otros endpoints (Netlify lo inyecta como process.env.URL)
  const origin = process.env.URL || 'https://bkdrop.netlify.app';

  const alerts = [];

  // ── TikTok ────────────────────────────────────────────────────────────────
  try {
    const tokenStore = getStore({ name: 'bk-tokens', consistency: 'strong' });
    const ttAuth = await tokenStore.get('tiktok_auth', { type: 'json' });
    if (ttAuth && ttAuth.access_token && Array.isArray(ttAuth.advertiser_ids)) {
      for (const advId of ttAuth.advertiser_ids) {
        const url = `${origin}/.netlify/functions/tiktok-report?advertiser_id=${encodeURIComponent(advId)}&date_preset=today&tenant=chile`;
        const r = await fetch(url);
        if (!r.ok) continue;
        const data = await r.json();
        for (const row of (data.rows || [])) {
          const isActive = row.status === 'STATUS_ENABLE' || row.status === 'ENABLE';
          if (!isActive) continue;
          collectAlerts(alerts, sent, {
            platform: 'TikTok',
            account: data.accountName || 'TikTok',
            campaign: row.name,
            campaignId: row.id,
            spend: row.spend || 0,
            realPurchases: row.realPurchases || 0,
            currency: data.currency || 'CLP',
          });
        }
      }
    }
  } catch (e) {
    console.error('TikTok alerts error:', e);
  }

  // ── Meta (Chile + GT) ─────────────────────────────────────────────────────
  for (const tenant of ['chile', 'gt']) {
    try {
      const accRes = await fetch(`${origin}/.netlify/functions/meta-ad-accounts?tenant=${tenant}`);
      if (!accRes.ok) continue;
      const accData = await accRes.json();
      const accounts = accData.accounts || [];
      for (const account of accounts) {
        const url = `${origin}/.netlify/functions/cross-report?account_id=${encodeURIComponent(account.id)}&date_preset=today${tenant === 'gt' ? '&tenant=gt' : ''}`;
        const r = await fetch(url);
        if (!r.ok) continue;
        const data = await r.json();
        for (const row of (data.byCampaign || [])) {
          const isActive = String(row.status || '').toUpperCase().includes('ACTIVE');
          if (!isActive) continue;
          collectAlerts(alerts, sent, {
            platform: tenant === 'gt' ? 'Meta GT' : 'Meta',
            account: account.name || 'Meta',
            campaign: row.name,
            campaignId: row.id,
            spend: row.spend || 0,
            realPurchases: row.realPurchases || 0,
            currency: data.currency || 'CLP',
          });
        }
      }
    } catch (e) {
      console.error('Meta ' + tenant + ' alerts error:', e);
    }
  }

  // Si es modo preview, devolver las alertas sin enviar a Telegram ni tocar el storage.
  if (preview) {
    return new Response(JSON.stringify({
      ok: true,
      date: todayCL,
      alerts: alerts.map(a => ({ key: a.key, text: a.text, platform: a.platform, campaign: a.campaign, type: a.type, spend: a.spend, realPurchases: a.realPurchases, account: a.account })),
    }), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }

  // ── Enviar alertas a Telegram (y marcar como enviadas) ────────────────────
  let sentCount = 0;
  const errors = [];
  for (const alert of alerts) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: alert.text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
      });
      const j = await resp.json();
      if (j.ok) {
        sent[alert.key] = { at: new Date().toISOString(), text: alert.text.slice(0, 80) };
        sentCount++;
      } else {
        errors.push(j.description || 'Telegram error');
      }
    } catch (e) {
      errors.push(e.message || 'fetch error');
    }
  }

  if (sentCount > 0) await alertStore.setJSON(sentKey, sent);

  return new Response(JSON.stringify({
    ok: true,
    date: todayCL,
    candidates: alerts.length,
    sent: sentCount,
    errors,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// Evalúa thresholds y arma el texto del mensaje. Mantiene anti-spam.
function collectAlerts(out, sent, ctx) {
  const { platform, account, campaign, campaignId, spend, realPurchases, currency } = ctx;
  const fmt = (v) => '$' + Math.round(v).toLocaleString('es-CL');
  const safeCamp = (campaign || '').replace(/[*_`[\]]/g, ''); // Markdown escape

  // Umbral A: gasto >= 10k sin ventas
  if (spend >= THRESHOLD_NO_SALES && realPurchases === 0) {
    const key = `${platform}-${campaignId}-A`;
    if (!sent[key]) {
      out.push({
        key, type: 'A', platform, account, campaign: safeCamp, spend, realPurchases,
        text: `🟡 *${platform}* · ${account}\n\n` +
              `📣 Campaña: *${safeCamp}*\n` +
              `💰 Gasto: ${fmt(spend)} ${currency}\n` +
              `🛒 Órdenes reales: *0*\n\n` +
              `Lleva más del umbral (${fmt(THRESHOLD_NO_SALES)}) sin generar ventas. ¿Apagar o ajustar?`,
      });
    }
  }

  // Umbral B: gasto >= 15k con 1 sola venta
  if (spend >= THRESHOLD_ONE_SALE && realPurchases === 1) {
    const key = `${platform}-${campaignId}-B`;
    if (!sent[key]) {
      const cpa = spend / 1;
      out.push({
        key, type: 'B', platform, account, campaign: safeCamp, spend, realPurchases,
        text: `🟠 *${platform}* · ${account}\n\n` +
              `📣 Campaña: *${safeCamp}*\n` +
              `💰 Gasto: ${fmt(spend)} ${currency}\n` +
              `🛒 Órdenes reales: *1*\n` +
              `📊 CPA real: ${fmt(cpa)}\n\n` +
              `Lleva más del umbral (${fmt(THRESHOLD_ONE_SALE)}) con solo 1 venta. Revisar y decidir.`,
      });
    }
  }
}

// Corre cada 15 minutos. Netlify usa UTC, no filtramos por horario porque el
// anti-spam (1 alerta por día por campaña por tipo) ya hace que solo dispare
// cuando algo cambia.
export const config = {
  schedule: '*/15 * * * *',
  path: '/.netlify/functions/bkdrop-alerts',
};
