<<<<<<< HEAD
# mediasouf-srf
=======
# Mediasoup SFU Service

A dedicated mediasoup SFU service for English Practice room audio/video signaling.

## Overview

This repository provides a MediaSoup-based SFU backend for real-time audio/video signaling. The server manages transports, producers, and consumers and exposes socket events for WebRTC lifecycle control.

## Requirements

- Node.js 18+ (or compatible runtime that supports ES modules)
- Redis instance for room / routing state
- JWT secret for authentication

## Install

```bash
npm install
```

## Configuration

1. Copy `.env.example` to `.env`.
2. Configure environment values, including `JWT_SECRET` and Redis settings.
3. Start the server.

## Run

```bash
npm start
```

For development with automatic reload:

```bash
npm run dev
```

## Endpoints

- `GET /health` — health check

## Socket events

- `sfu:getRouterRtpCapabilities`
- `sfu:createWebRtcTransport`
- `sfu:connectWebRtcTransport`
- `sfu:produce`
- `sfu:getProducers`
- `sfu:consume`
- `sfu:resumeConsumer`

## Project structure

- `server.js` — app entrypoint
- `socket.js` — socket event routing and handlers
- `mediasoup/` — SFU helper modules
  - `worker.js`
  - `router.js`
  - `transport.js`
  - `producer.js`
  - `consumer.js`

## Notes

- Do not commit `.env` or local secrets.
- `node_modules/` is ignored by `.gitignore`.
>>>>>>> 7618537 (webrtc fixe final d)
