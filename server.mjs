// Vercel entry point. Vercel finds this file at the project root and drives the exported
// server itself, so it must not call listen(). The whole backend (HTTP API and WebSocket)
// is this one function. To run the game on your own machine use `npm start` (dev.js).
import app from './lib/app.js';

const server = app.createApp().server;

export default server;
