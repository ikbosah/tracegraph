import { createApp } from './app';

const app  = createApp();
const port = process.env['PORT'] ? Number(process.env['PORT']) : 3000;

app.listen(port, () => {
  const invUrl = process.env['INVENTORY_SERVICE_URL'] ?? 'http://localhost:3001';
  process.stdout.write(`[order-service] Listening on http://localhost:${port}\n`);
  process.stdout.write(`[order-service] Inventory service → ${invUrl}\n`);
});
