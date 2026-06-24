const http = require('http');

// Simple HTTP server with a health endpoint for container health checks
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '1.0.0' }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ECR Deep Dive Lab - v1.0.0\n');
  }
});

server.listen(3000, () => {
  console.log('Server running on port 3000');
});