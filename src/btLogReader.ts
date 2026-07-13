// Decoder for BehaviorTree.CPP `BT::FileLogger2` recordings (.btlog).
//
// On-disk layout (little-endian throughout), verified against real recordings:
//   [0..18)   18-byte ASCII magic "BTCPP4-FileLogger2"
//   [18]      u8  version (currently 1)
//   [19..23)  u32 xmlSize in BYTES (not characters)
//   [23..23+xmlSize)  tree XML (carries _uid on every node)
//   next 8    u64 firstTimestamp, microseconds since the Unix epoch
//   then      9-byte transition records until EOF:
//               [0..6) u48 deltaMicros  absolute offset from firstTimestamp
//               [6..8) u16 node uid
//               [8]    u8  status (see NodeStatus)
//
// A record's delta is measured from the first timestamp (not the previous
// record), so its playback time is deltaMicros / 1e6 seconds. Halts write IDLE
// resets, so an aborted or finished run's tail is a burst of IDLE rows.

/** BT.CPP node status codes as written in a .btlog transition record. */
enum NodeStatus {
  Idle = 0,
  Running = 1,
  Success = 2,
  Failure = 3,
  Skipped = 4,
}

export interface ReplayTransition {
  /** Playback time in seconds from the start of the recording. */
  t: number;
  /** Node uid, matching the `_uid` attribute in the embedded XML. */
  uid: number;
  /** Status name: IDLE | RUNNING | SUCCESS | FAILURE | SKIPPED. */
  status: string;
}

export interface BtLogReplay {
  /** The full tree XML embedded in the recording (parse with parseBTXml). */
  xml: string;
  /** Every status transition, in file order (time-sorted, non-decreasing). */
  transitions: ReplayTransition[];
  /** Total playback duration in seconds (time of the last transition; 0 if none). */
  duration: number;
  /** When the recording started, milliseconds since the Unix epoch. */
  recordedAtMs: number;
}

/**
 * Decode a `.btlog` recording into its embedded tree XML and the ordered list
 * of status transitions. Throws with a clear message on a bad magic/version or
 * a file truncated mid-header.
 */
export function readBtLog(bytes: Uint8Array): BtLogReplay {
  const magic = "BTCPP4-FileLogger2";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  if (new TextDecoder("latin1").decode(bytes.subarray(0, magic.length)) !== magic) {
    throw new Error(`Not a .btlog file: missing "${magic}" header`);
  }
  offset += magic.length;

  const version = view.getUint8(offset);
  offset += 1;
  if (version !== 1) {
    throw new Error(`Unsupported .btlog version ${version} (this reader handles version 1)`);
  }

  const xmlSize = view.getUint32(offset, true);
  offset += 4;
  if (offset + xmlSize + 8 > bytes.byteLength) {
    throw new Error("Corrupt .btlog: header/XML overruns the file");
  }

  const xml = new TextDecoder().decode(bytes.subarray(offset, offset + xmlSize));
  offset += xmlSize;

  const firstMicros = view.getBigUint64(offset, true);
  offset += 8;

  const transitions: ReplayTransition[] = [];
  while (offset + 9 <= bytes.byteLength) {
    // 6-byte little-endian delta: low u32 plus high u16 shifted up 32 bits.
    const micros = view.getUint32(offset, true) + view.getUint16(offset + 4, true) * 2 ** 32;
    const uid = view.getUint16(offset + 6, true);
    const status = (NodeStatus[view.getUint8(offset + 8)] ?? "unknown").toUpperCase();
    transitions.push({ t: micros / 1e6, uid, status });
    offset += 9;
  }

  return {
    xml,
    transitions,
    duration: transitions.at(-1)?.t ?? 0,
    recordedAtMs: Number(firstMicros / 1000n),
  };
}
