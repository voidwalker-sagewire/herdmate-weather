const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const OWM_KEY = process.env.OWM_KEY || '';
const CACHE_MINUTES = parseInt(process.env.CACHE_MINUTES || '5');
const CACHE_MS = CACHE_MINUTES * 60 * 1000;

// ── DATABASE SETUP ──
const db = new Database(path.join(__dirname, 'weather.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS weather_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lat         REAL NOT NULL,
    lng         REAL NOT NULL,
    temp        TEXT,
    condition   TEXT,
    wind        TEXT,
    humidity    TEXT,
    raw_json    TEXT,
    source      TEXT DEFAULT 'owm',
    fetched_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_weather_coords_time
    ON weather_log (lat, lng, fetched_at DESC);
`);

// ── HELPERS ──
function roundCoord(n) { return Math.round(parseFloat(n) * 100) / 100; }

function degToCompass(deg) {
  if (deg === undefined || deg === null) return '';
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function buildResponse(row) {
  return {
    temp:      row.temp,
    condition: row.condition,
    wind:      row.wind,
    humidity:  row.humidity,
    cached:    true,
    fetched_at: new Date(row.fetched_at).toISOString()
  };
}

// ── FETCH FROM OWM ──
async function fetchFromOWM(lat, lng) {
  const url = `https://api.openweathermap.org/data/2.5/weather` +
    `?lat=${lat}&lon=${lng}&appid=${OWM_KEY}&units=imperial`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`OWM error ${res.status}`);
  const data = await res.json();
  if (!data.main) throw new Error('No weather data in OWM response');

  return {
    temp:      Math.round(data.main.temp) + '°F',
    condition: data.weather?.[0]?.description || '',
    wind:      Math.round(data.wind?.speed || 0) + ' mph ' + degToCompass(data.wind?.deg),
    humidity:  data.main.humidity + '%',
    raw:       JSON.stringify(data),
    source:    'owm'
  };
}

// ── FALLBACK: OPEN-METEO (free, no key) ──
async function fetchFromOpenMeteo(lat, lng) {
  const codes = {
    0:'Clear Sky',1:'Mainly Clear',2:'Partly Cloudy',3:'Overcast',
    51:'Light Drizzle',53:'Drizzle',61:'Light Rain',63:'Rain',65:'Heavy Rain',
    71:'Light Snow',73:'Snow',80:'Showers',95:'Thunderstorm'
  };
  const url = `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=1`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo error ${res.status}`);
  const data = await res.json();
  const c = data.current;
  if (!c) throw new Error('No current data from Open-Meteo');

  return {
    temp:      Math.round(c.temperature_2m) + '°F',
    condition: codes[c.weather_code] || 'Variable',
    wind:      Math.round(c.wind_speed_10m) + ' mph',
    humidity:  c.relative_humidity_2m + '%',
    raw:       JSON.stringify(data),
    source:    'open-meteo'
  };
}

// ── MAIN WEATHER ENDPOINT ──
app.get('/weather', async (req, res) => {
  const { lat, lng } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }

  const rLat = roundCoord(lat);
  const rLng = roundCoord(lng);
  const now = Date.now();
  const cutoff = now - CACHE_MS;

  // Check cache first
  const cached = db.prepare(
    `SELECT * FROM weather_log
     WHERE lat = ? AND lng = ? AND fetched_at > ?
     ORDER BY fetched_at DESC LIMIT 1`
  ).get(rLat, rLng, cutoff);

  if (cached) {
    return res.json({ ...buildResponse(cached), cached: true });
  }

  // Fetch fresh data
  let weather;
  try {
    weather = OWM_KEY ? await fetchFromOWM(rLat, rLng) : await fetchFromOpenMeteo(rLat, rLng);
  } catch (owmErr) {
    console.error('OWM failed, trying Open-Meteo:', owmErr.message);
    try {
      weather = await fetchFromOpenMeteo(rLat, rLng);
    } catch (fallbackErr) {
      console.error('Open-Meteo also failed:', fallbackErr.message);
      return res.status(502).json({ error: 'Weather unavailable', details: fallbackErr.message });
    }
  }

  // Save to log
  db.prepare(
    `INSERT INTO weather_log (lat, lng, temp, condition, wind, humidity, raw_json, source, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(rLat, rLng, weather.temp, weather.condition, weather.wind, weather.humidity, weather.raw, weather.source, now);

  return res.json({
    temp:      weather.temp,
    condition: weather.condition,
    wind:      weather.wind,
    humidity:  weather.humidity,
    cached:    false,
    fetched_at: new Date(now).toISOString()
  });
});

// ── HISTORY ENDPOINT ──
app.get('/weather/history', (req, res) => {
  const { lat, lng, limit = 50 } = req.query;

  let rows;
  if (lat && lng) {
    const rLat = roundCoord(lat);
    const rLng = roundCoord(lng);
    rows = db.prepare(
      `SELECT id, lat, lng, temp, condition, wind, humidity, source, fetched_at
       FROM weather_log WHERE lat = ? AND lng = ?
       ORDER BY fetched_at DESC LIMIT ?`
    ).all(rLat, rLng, parseInt(limit));
  } else {
    rows = db.prepare(
      `SELECT id, lat, lng, temp, condition, wind, humidity, source, fetched_at
       FROM weather_log ORDER BY fetched_at DESC LIMIT ?`
    ).all(parseInt(limit));
  }

  res.json({
    count: rows.length,
    results: rows.map(r => ({ ...r, fetched_at: new Date(r.fetched_at).toISOString() }))
  });
});

// ── HEALTH CHECK ──
app.get('/health', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as n FROM weather_log').get();
  res.json({
    status: 'ok',
    service: 'HerdMate Weather',
    records: count.n,
    cache_minutes: CACHE_MINUTES,
    owm_key_set: !!OWM_KEY,
    uptime_seconds: Math.round(process.uptime())
  });
});

app.listen(PORT, () => {
  console.log(`HerdMate Weather running on port ${PORT}`);
  console.log(`OWM key: ${OWM_KEY ? 'SET' : 'NOT SET — using Open-Meteo fallback'}`);
  console.log(`Cache: ${CACHE_MINUTES} minutes`);
});

