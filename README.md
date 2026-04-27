# Mediasoup SFU Service

This service hosts a dedicated mediasoup SFU and handles only real-time media signaling.

## Architecture

- Frontend → Backend (Render/API)
- Backend maps `roomId` to `sfuUrl` via Redis
- Frontend connects directly to the SFU using `sfuUrl`
- Media signaling and WebRTC lifecycle are handled only by the SFU server

## Getting started

1. Copy `.env.example` to `.env`
2. Set `JWT_SECRET` to the same secret used by your backend JWT signing
3. Run:

```bash
npm install
npm start
```

## Endpoints

- `GET /health` – health check

## Socket events

- `sfu:getRouterRtpCapabilities`
- `sfu:createWebRtcTransport`
- `sfu:connectWebRtcTransport`
- `sfu:produce`
- `sfu:getProducers`
- `sfu:consume`
- `sfu:resumeConsumer`
