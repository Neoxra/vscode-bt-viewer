type ZmqRequestSocket = {
  receiveTimeout: number;
  sendTimeout: number;
  linger: number;
  connect(addr: string): void;
  close(): void;
  send(buf: Buffer): Promise<void>;
  receive(): Promise<Buffer[]>;
};

type ZmqModule = { Request: new () => ZmqRequestSocket };

let zmqCache: ZmqModule | null | undefined;

function loadZmq(): ZmqModule | null {
  if (zmqCache !== undefined) return zmqCache;
  try {
    zmqCache = require("zeromq") as ZmqModule;
  } catch {
    zmqCache = null;
  }
  return zmqCache;
}

export function isMonitorAvailable(): boolean {
  return loadZmq() !== null;
}

export interface MonitorStatus {
  nodes: Record<string, string>;
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

    const zmq = loadZmq();
    if (!zmq) {
      this.onError("Live monitoring unavailable: zeromq native binary not loaded for this platform");
      return;
    }

    this.running = true;
    const reqAddr = `tcp://${host}:${port}`;
    this.onInfo(`Connecting to ${reqAddr}...`);

    let sock: ZmqRequestSocket | null = null;
    let treeFetched = false;
    let polling = false;
    let sockBusy = false;

    const createSocket = (): ZmqRequestSocket => {
      if (sock) {
        try { sock.close(); } catch { /* ignore */ }
      }
      const next = new zmq.Request();
      next.receiveTimeout = 2000;
      next.sendTimeout = 1000;
      next.linger = 0;
      sock = next;
      next.connect(reqAddr);
      sockBusy = false;
      return next;
    };

    sock = createSocket();

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
              this.onStatus({ nodes });

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
          this.onStatus({ nodes: {} });
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
