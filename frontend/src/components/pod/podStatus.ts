import { models } from '../../../wailsjs/go/models';

// Shared by the pod list row and its expanded detail (pod/detail), so a
// container reads the same colour in both places.

// Waiting reasons that mean "on its way", not "broken". Anything else a
// container waits on (CrashLoopBackOff, ImagePullBackOff, ...) is a fault.
export const BENIGN_WAITING = new Set(['', 'ContainerCreating', 'PodInitializing']);

// Per-container status color:
//   green  ready
//   amber  running but not (yet) ready — probe failing or still warming up
//   blue   waiting for a normal reason (ContainerCreating, PodInitializing)
//   grey   finished cleanly (a completed init container or job)
//   red    waiting on a fault (CrashLoopBackOff, ImagePullBackOff, ...) or exited with an error
export const containerDotColor = (c: models.ContainerStatusInfo) => {
    if (c.ready) return 'var(--ok)';
    if (c.state === 'Terminated') return c.reason === 'Completed' ? 'var(--ink-3)' : 'var(--err)';
    if (c.state === 'Running') return 'var(--warn)';
    if (c.state === 'Waiting' && BENIGN_WAITING.has(c.reason)) return 'var(--info)';
    return 'var(--err)';
};

// Live usage formatting, mirroring the Monitoring dashboard.
// usage < 0 means metrics-server is unavailable.
export const fmtCpu = (m: number) => (m < 0 ? '—' : m >= 1000 ? `${(m / 1000).toFixed(2)} cores` : `${m} m`);
export const fmtMem = (mi: number) => (mi < 0 ? '—' : mi >= 1024 ? `${(mi / 1024).toFixed(1)} GiB` : `${mi} MiB`);

// The backend reports kubectl's STATUS (see services.getPodStatus), so the
// status is a container reason as often as a pod phase.
export const getStatusSeverity = (status: string) => {
    if (status === 'Running') return 'success';
    if (status === 'Completed' || status === 'Succeeded') return 'secondary';
    if (status === 'Pending' || status === 'Terminating' || BENIGN_WAITING.has(status)) return 'warning';
    // Init:1/3 is progress; Init:CrashLoopBackOff is not.
    if (/^Init:\d+\/\d+$/.test(status)) return 'warning';
    if (status === 'Unknown') return 'info';
    return 'danger';
};
