// Local preview for development: serves the project and opens the popup with a
// fake `chrome` API and sample data, so the UI can be checked outside the extension.
//   npm run preview  ->  http://localhost:5178/
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 5178;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(302, { Location: '/src/popup/popup.html?mock=1' });
    return res.end();
  }
  const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    let body = data;
    if (url.pathname === '/src/popup/popup.html' && url.searchParams.has('mock')) {
      body = data.toString('utf8').replace('<script src="../lib/common.js">',
        '<script src="/tools/mock-chrome.js"></script>\n  <script src="../lib/common.js">');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  });
}).listen(PORT, () => console.log('Preview on http://localhost:' + PORT + '/'));
