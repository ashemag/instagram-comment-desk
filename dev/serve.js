// Serves the harness at any /p/<code>/ path so content.js sees a post URL.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const port = Number(process.env.PORT || 5178);

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = url.pathname.startsWith('/p/')
      ? path.join(__dirname, 'harness.html')
      : path.join(root, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type }).end(data);
    });
  })
  .listen(port, () => console.log(`http://localhost:${port}/p/Ddo7FMeSVJh/`));
