// How long a toast stays up, by severity — the one place this is decided.
//
// Every panel mounts its own PrimeReact <Toast>, so without a shared table each
// one picked its own number (2.5–8s for the same kind of message). The length
// follows what the message asks of the reader: a success only confirms what the
// user just did, a warning needs reading, an error usually carries backend text
// worth reading twice. PrimeReact pauses the timer while the pointer is over a
// message, so a long path or error can still be read in full.
export const TOAST_LIFE = {
    success: 3000,
    info: 3000,
    warn: 5000,
    error: 6000,
} as const;

export type ToastSeverity = keyof typeof TOAST_LIFE;
