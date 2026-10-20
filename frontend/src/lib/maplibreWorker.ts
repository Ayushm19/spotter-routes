// Let Vite bundle MapLibre's web worker (with the chunks it imports) and point MapLibre at it.
// Without this the production build copies the worker file alone, it fails to load, and maps stay blank.
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(workerUrl);
