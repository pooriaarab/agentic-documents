/**
 * A room refuses a message over 1 MiB. A document past this size cannot seed a room, so it cannot be saved from one.
 * The editor checks it too, before it puts in an image.
 */
export const MAX_LIVE_BYTES = 1_000_000;
