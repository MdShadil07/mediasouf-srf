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
    initialAvailableOutgoingBitrate: 1000000,
    minimumAvailableOutgoingBitrate: 600000,
    maxIncomingBitrate: 1500000,
    enableSctp: true,
    numSctpStreams: { OS: 1024, MIS: 1024 },
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
