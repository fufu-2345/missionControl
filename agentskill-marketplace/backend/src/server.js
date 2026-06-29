import { app } from './app.js';
import { initDb } from './db.js';
import { seed } from './seed.js';

const PORT = process.env.PORT || 4000;

initDb();
seed();

app.listen(PORT, () => {
  console.log(`[agentskill-backend] listening on http://localhost:${PORT}`);
});
