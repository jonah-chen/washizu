'use strict';
// Vercel entry point. The whole backend (HTTP API and WebSocket) is this one function.
// Vercel drives the exported server; it must not call listen().
const { createApp } = require('../lib/app');
module.exports = createApp().server;
