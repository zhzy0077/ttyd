/** Bytes of PTY payload per websocket INPUT frame.
 * Kept under the libwebsockets permessage-deflate inflate buffer (1024). */
export const INPUT_CHUNK_SIZE = 512;

const INPUT_COMMAND = 0x30; // '0'

export function encodeInputFrames(bytes: Uint8Array, chunkSize = INPUT_CHUNK_SIZE): Uint8Array[] {
    const frames: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, bytes.length);
        const payload = new Uint8Array(end - offset + 1);
        payload[0] = INPUT_COMMAND;
        payload.set(bytes.subarray(offset, end), 1);
        frames.push(payload);
    }
    return frames;
}
