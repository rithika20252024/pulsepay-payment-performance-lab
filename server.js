const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const api = require('./api/[...path].js');

const root = path.join(__dirname, 'dist');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png' };
const server = http.createServer(async (req,res) => {
  if (new URL(req.url, `http://${req.headers.host||'localhost'}`).pathname.startsWith('/api/')) return api(req,res);
  let requested = decodeURIComponent(new URL(req.url, `http://${req.headers.host||'localhost'}`).pathname);
  let file = path.resolve(root, `.${requested}`);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root,'index.html');
  if (!fs.existsSync(file)) { res.writeHead(500,{'content-type':'text/plain'});return res.end('Build the frontend first with npm run build.'); }
  res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','cache-control':file.endsWith('index.html')?'no-cache':'public, max-age=31536000, immutable'});
  fs.createReadStream(file).pipe(res);
});
server.listen(Number(process.env.PORT||3000),()=>console.log(`PulsePay running on http://localhost:${process.env.PORT||3000}`));
