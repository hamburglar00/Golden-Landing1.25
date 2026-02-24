import { CONFIG_SHEETS } from '../credenciales/google-sheets.js';

/**
 * Helpers IP (más correcto que filtrar 172.* o 141.* completo)
 */
function isPrivateIPv4(ip) {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;

  const a = Number(m[1]);
  const b = Number(m[2]);

  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  // Solo 172.16.0.0 – 172.31.255.255 es privado
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

  // Localhost IPv6
  if (ip === '::1') return '';

  // IPv4 mapeada en IPv6: ::ffff:1.2.3.4
  if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');

  // Si es IPv4 privada, descartamos
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && isPrivateIPv4(ip)) return '';

  // IPv6 local / link-local (no sirve como IP pública)
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
  // Acepta number/string. Devuelve epoch seconds.
  const now = Math.floor(Date.now() / 1000);

  if (v === undefined || v === null || v === '') return now;

  const n = Number(v);

  // Si viene en milisegundos (muy grande), convertimos
  if (Number.isFinite(n) && n > 1e12) {
    const ms = Math.floor(n);
    const sec = Math.floor(ms / 1000);
    return Number.isFinite(sec) ? sec : now;
  }

  if (Number.isFinite(n) && n > 0) return Math.floor(n);

  return now;
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
      geo_city,
      geo_region,
      geo_country,
      promo_code
    } = body;

    // Mínimos: al menos uno de estos
    if (!event_id && !external_id && !phone && !email) {
      return res.status(400).json({ error: 'Faltan datos mínimos.' });
    }

    const sheetPayload = {
      timestamp: new Date().toISOString(),

      phone: safeTrim(phone),
      email: safeTrim(email),
      fn: safeTrim(fn),
      ln: safeTrim(ln),

      ct: safeTrim(ct),
      st: safeTrim(st),
      zip: safeTrim(zip),
      country: safeTrim(country),

      fbp: safeTrim(fbp),
      fbc: safeTrim(fbc),

      event_id: safeTrim(event_id),
      clientIP: clientIp || '',
      agentuser: userAgent || '',

      // Campos “de hoja”
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
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Error interno:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
