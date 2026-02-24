import { CONFIG_SHEETS } from '../credenciales/google-sheets.js';

/**
 * Helpers IP (más correcto que filtrar 172.* completo)
 */
function isPrivateIPv4(ip) {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;

  const a = Number(m[1]);
  const b = Number(m[2]);

  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;

  return false;
}

function cleanClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  let ip =
    (forwarded ? String(forwarded).split(',')[0].trim() : '') ||
    req.socket?.remoteAddress ||
    '';

  if (!ip) return '';

  if (ip === '::1') return '';
  if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');

  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && isPrivateIPv4(ip)) return '';

  const lower = ip.toLowerCase();
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return '';

  return ip;
}

function safeString(v) {
  return (v === undefined || v === null) ? '' : String(v);
}

function safeTrim(v) {
  return safeString(v).trim();
}

function safeEventTime(v) {
  const now = Math.floor(Date.now() / 1000);
  if (v === undefined || v === null || v === '') return now;

  const n = Number(v);

  // Si viene en ms
  if (Number.isFinite(n) && n > 1e12) return Math.floor(n / 1000);

  if (Number.isFinite(n) && n > 0) return Math.floor(n);

  return now;
}

/**
 * GEO por headers (Vercel + fallbacks)
 * - Vercel:
 *   x-vercel-ip-country
 *   x-vercel-ip-country-region
 *   x-vercel-ip-city
 * - Cloudflare:
 *   cf-ipcountry
 *   cf-region
 *   cf-ipcity (no siempre)
 * - Fly:
 *   fly-region (region), sin city/country estándar
 */
function getGeoFromHeaders(req) {
  const h = req.headers || {};

  // Vercel (más común para Next/Vercel)
  const vercelCountry = safeTrim(h['x-vercel-ip-country']);
  const vercelRegion  = safeTrim(h['x-vercel-ip-country-region']);
  const vercelCity    = safeTrim(h['x-vercel-ip-city']);

  if (vercelCountry || vercelRegion || vercelCity) {
    return {
      geo_country: vercelCountry,
      geo_region: vercelRegion,
      geo_city: vercelCity
    };
  }

  // Cloudflare fallback
  const cfCountry = safeTrim(h['cf-ipcountry']);
  const cfRegion  = safeTrim(h['cf-region']);
  const cfCity    = safeTrim(h['cf-ipcity']); // no siempre existe

  if (cfCountry || cfRegion || cfCity) {
    return {
      geo_country: cfCountry,
      geo_region: cfRegion,
      geo_city: cfCity
    };
  }

  // Otros / genéricos
  return { geo_country: '', geo_region: '', geo_city: '' };
}

export default async function handler(req, res) {
  // Preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const clientIp = cleanClientIp(req);
    const userAgent = safeString(req.headers['user-agent']);

    const body = req.body || {};

    const {
      event_source_url,
      fbp,
      fbc,
      email,
      phone,
      fn,
      ln,
      zip,
      ct,
      st,
      country,
      event_id,
      external_id,
      utm_campaign,
      event_time,
      telefono_asignado,
      device_type,
      promo_code,

      // GEO que venga del frontend (hoy tu landing lo manda vacío)
      geo_city: geoCityFromBody,
      geo_region: geoRegionFromBody,
      geo_country: geoCountryFromBody
    } = body;

    // Mínimos
    if (!event_id && !external_id && !phone && !email) {
      return res.status(400).json({ error: 'Faltan datos mínimos.' });
    }

    // GEO: prioridad = body si viene, sino headers (Vercel/CF)
    const geoFromHeaders = getGeoFromHeaders(req);
    const geo_city = safeTrim(geoCityFromBody) || geoFromHeaders.geo_city;
    const geo_region = safeTrim(geoRegionFromBody) || geoFromHeaders.geo_region;
    const geo_country = safeTrim(geoCountryFromBody) || geoFromHeaders.geo_country;

    // country “clásico” (campo tuyo) si no viene, lo derivamos de geo_country si existe
    const finalCountry = safeTrim(country) || geo_country || '';

    const sheetPayload = {
      timestamp: new Date().toISOString(),

      phone: safeTrim(phone),
      email: safeTrim(email),
      fn: safeTrim(fn),
      ln: safeTrim(ln),

      ct: safeTrim(ct),
      st: safeTrim(st),
      zip: safeTrim(zip),
      country: finalCountry,

      fbp: safeTrim(fbp),
      fbc: safeTrim(fbc),

      event_id: safeTrim(event_id),
      clientIP: clientIp || '',
      agentuser: userAgent || '',

      // Campos de hoja
      estado: '',
      valor: '',
      estado_envio: '',
      observaciones: '',

      external_id: safeTrim(external_id),
      utm_campaign: safeTrim(utm_campaign),
      event_source_url: safeTrim(event_source_url),
      event_time: safeEventTime(event_time),

      telefono_asignado: safeTrim(telefono_asignado),
      device_type: safeTrim(device_type),

      // GEO REAL (server-side)
      geo_city: safeTrim(geo_city),
      geo_region: safeTrim(geo_region),
      geo_country: safeTrim(geo_country),

      promo_code: safeTrim(promo_code)
    };

    const gsRes = await fetch(CONFIG_SHEETS.GOOGLE_SHEETS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sheetPayload)
    });

    const responseText = await gsRes.text();

    if (!gsRes.ok) {
      console.error('❌ Error desde Google Sheets:', responseText);
      return res.status(502).json({ error: 'Sheets error', details: responseText });
    }

    console.log('✅ Registrado en Google Sheets:', responseText);
    return res.status(200).json({
      success: true,
      geo: { geo_city, geo_region, geo_country } // útil para test, podés sacarlo si querés
    });
  } catch (error) {
    console.error('❌ Error interno:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
