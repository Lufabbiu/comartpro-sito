const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME = {
  '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
  '.js':'application/javascript; charset=utf-8','.png':'image/png',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml',
  '.ico':'image/x-icon','.json':'application/json; charset=utf-8',
  '.pdf':'application/pdf','.webp':'image/webp',
};

http.createServer((req,res)=>{
  let urlPath=decodeURIComponent(req.url.split('?')[0]);
  if(urlPath==='/')urlPath='/index.html';
  const filePath=path.join(ROOT,urlPath);
  if(!filePath.startsWith(ROOT)){res.writeHead(403);return res.end('Forbidden')}
  fs.readFile(filePath,(err,data)=>{
    if(err){res.writeHead(404,{'Content-Type':'text/plain'});return res.end('Not found')}
    const ext=path.extname(filePath).toLowerCase();
    res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream','Cache-Control':'public, max-age=3600'});
    res.end(data);
  });
}).listen(PORT,'0.0.0.0',()=>console.log(`comartpro.it listening on 0.0.0.0:${PORT}`));
