import { createApp } from './app';

const app  = createApp();
const port = process.env['PORT'] ? Number(process.env['PORT']) : 3001;

app.listen(port, () => {
  process.stdout.write(`[inventory-service] Listening on http://localhost:${port}\n`);
});
