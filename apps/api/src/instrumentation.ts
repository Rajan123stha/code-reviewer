// Loaded with `node --import` before main.ts so instrumentation can patch modules on import.
import { startTracing } from '@reviewlens/shared';

startTracing('reviewlens-api');
