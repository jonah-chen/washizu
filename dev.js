'use strict';
// Run the game on your own machine: node dev.js
// Uses Redis when REDIS_URL is set; otherwise keeps everything in memory until you stop it.
const { createApp } = require('./lib/app');
const PORT = +process.env.PORT || 3000;
const app = createApp();
app.server.listen(PORT, () => console.log(`Washizu Mahjong on http://localhost:${PORT} (${app.store.kind} store)`));
