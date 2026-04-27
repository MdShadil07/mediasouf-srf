export async function createTransport(router, userId) {
  const transport = await router.createWebRtcTransport({
    listenIps: [
      {
        ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
        announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null,
      },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    // SCTP disabled — data channels not needed for audio/video-only rooms
    enableSctp: false,
    // Simulcast manages per-consumer rates; these are per-transport caps
    initialAvailableOutgoingBitrate: 1_000_000,
    minimumAvailableOutgoingBitrate: 100_000,
  });

  transport.appData = { userId };

  transport.on('dtlsstatechange', (dtlsState) => {
    console.log(`[SFU] Transport ${transport.id} DTLS state: ${dtlsState}`);
    if (dtlsState === 'closed') {
      transport.close();
    }
  });

  transport.on('icegatheringstatechange', (state) => {
    console.log(`[SFU] Transport ${transport.id} ICE gathering: ${state}`);
  });

  transport.on('connectionstatechange', (state) => {
    console.log(`[SFU] Transport ${transport.id} connection state: ${state}`);
  });

  transport.on('close', () => {
    console.log(`[SFU] Transport ${transport.id} closed for user ${userId}`);
  });

  return transport;
}

export async function connectTransport(transport, dtlsParameters) {
  await transport.connect({ dtlsParameters });
}
