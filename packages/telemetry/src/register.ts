// Node --import preload entry.
//
// Usage in Dockerfile / k8s Deployment:
//   NODE_OPTIONS="--import @openpanel/telemetry/register"
//
// This is the alternative to `import '@openpanel/telemetry/bootstrap'` in
// the app entry file. Preload runs BEFORE any user code, which is the
// safest ordering for auto-instrumentation (patches http/undici/etc. at
// module-load time).

import './bootstrap.js';
