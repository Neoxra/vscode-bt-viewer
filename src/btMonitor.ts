import * as zmq from "zeromq";

export interface MonitorStatus {
  nodes: Record<string, string>;
  timestamp: number;
}

const STATUS_NAMES: Record<number, string> = {
  0: "IDLE", 1: "RUNNING", 2: "SUCCESS", 3: "FAILURE",
  11: "IDLE", 12: "IDLE", 13: "IDLE",
};

const PROTOCOL_ID = 2;
const REQ_FULLTREE = 0x54;
const REQ_STATUS = 0x53;

function buildRequestHeader(requestType: number): Buffer {
  const buf = Buffer.alloc(6);
  buf.writeUInt8(PROTOCOL_ID, 0);
  buf.writeUInt8(requestType, 1);
  buf.writeUInt32LE(Math.floor(Math.random() * 0xFFFFFFFF), 2);
  return buf;
}

function parseStatusPayload(payload: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset + 3 <= payload.length) {
    const uid = payload.readUInt16LE(offset);
    const status = payload.readUInt8(offset + 2);
    const name = STATUS_NAMES[status];
    if (name !== undefined) {
      result[String(uid)] = name;
    }
    offset += 3;
  }
  return result;
}

export class BTMonitor {
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onStatus: (status: MonitorStatus) => void;
  private onInfo: (message: string) => void;
  private onError: (message: string) => void;
  private onTree: (xml: string) => void;

  constructor(callbacks: {
    onStatus: (status: MonitorStatus) => void;
    onInfo: (message: string) => void;
    onError: (message: string) => void;
    onTree: (xml: string) => void;
  }) {
    this.onStatus = callbacks.onStatus;
    this.onInfo = callbacks.onInfo;
    this.onError = callbacks.onError;
    this.onTree = callbacks.onTree;
  }

  async start(host: string = "localhost", port: number = 1666): Promise<void> {
    if (this.running) this.stop();

    this.running = true;
    const reqAddr = `tcp://${host}:${port}`;
    this.onInfo(`Connecting to ${reqAddr}...`);

    // Create a persistent REQ socket
    let sock: zmq.Request | null = null;
    let treeFetched = false;
    let polling = false;
    let sockBusy = false;

    const createSocket = () => {
      if (sock) {
        try { sock.close(); } catch { /* ignore */ }
      }
      sock = new zmq.Request();
      sock.receiveTimeout = 2000;
      sock.sendTimeout = 1000;
      sock.linger = 0;
      sock.connect(reqAddr);
      sockBusy = false;
    };

    createSocket();

    // Give socket time to connect before first request
    await new Promise(r => setTimeout(r, 200));

    // Try initial tree fetch
    try {
      if (sock) {
        sockBusy = true;
        await sock.send(buildRequestHeader(REQ_FULLTREE));
        const frames = await sock.receive();
        sockBusy = false;
        if (frames.length >= 2) {
          const xml = Buffer.from(frames[1]).toString("utf-8");
          if (xml.length > 10) {
            this.onTree(xml);
            treeFetched = true;
            this.onInfo("Monitoring active");
          }
        }
      }
    } catch {
      sockBusy = false;
      // Socket might be in bad state after timeout, recreate
      createSocket();
      this.onInfo("Listening (run a BT to see status)");
    }

    // Poll status every 150ms using the persistent socket
    let hadData = false;
    let failCount = 0;

    this.pollTimer = setInterval(async () => {
      if (!this.running || !sock || polling || sockBusy) return;
      polling = true;

      try {
        await sock.send(buildRequestHeader(REQ_STATUS));
        const frames = await sock.receive();

        if (frames.length >= 2) {
          const payload = Buffer.from(frames[1]);
          if (payload.length >= 3) {
            const nodes = parseStatusPayload(payload);
            if (Object.keys(nodes).length > 0) {
              hadData = true;
              failCount = 0;
              this.onStatus({ nodes, timestamp: Date.now() / 1000 });

              if (!treeFetched) {
                try {
                  await sock.send(buildRequestHeader(REQ_FULLTREE));
                  const treeFrames = await sock.receive();
                  if (treeFrames.length >= 2) {
                    const xml = Buffer.from(treeFrames[1]).toString("utf-8");
                    if (xml.length > 10) {
                      this.onTree(xml);
                      treeFetched = true;
                      this.onInfo("Monitoring active");
                    }
                  }
                } catch {
                  // Tree fetch failed, try next poll
                }
              }
            }
          }
        }
      } catch {
        failCount++;
        // If we previously had data and now failing, BT has finished
        if (hadData && failCount >= 3) {
          this.onInfo("BT finished");
          this.onStatus({ nodes: {}, timestamp: Date.now() / 1000 });
          hadData = false;
          treeFetched = false;
        }
        // Recreate socket for next BT execution
        createSocket();
      }

      polling = false;
    }, 150);

    // Store socket reference for cleanup
    const origStop = this.stop.bind(this);
    this.stop = () => {
      origStop();
      if (sock) {
        try { sock.close(); } catch { /* ignore */ }
        sock = null;
      }
    };
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }
}
