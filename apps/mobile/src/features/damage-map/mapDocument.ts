import { ISPARTA_CENTER, INITIAL_MAP_ZOOM, demoMapMarkers } from './demoMapMarkers.ts';
import { escapeDocumentJson, isMapSession, MAP_PROTOCOL_VERSION } from './mapBridge.ts';
import { LEAFLET_JS, LEAFLET_CSS, MAP_RUNTIME_JS, LEAFLET_SCRIPT_HASH, MAP_RUNTIME_HASH } from './generated/leafletAssets.ts';

export function createMapDocument(session = 'roadsense-preview'): string {
  if (!isMapSession(session)) throw new Error('Invalid map session');
  const config = escapeDocumentJson({ v: MAP_PROTOCOL_VERSION, session, center: ISPARTA_CENTER, zoom: INITIAL_MAP_ZOOM, markers: demoMapMarkers });
  const policy = `default-src 'none'; script-src 'sha256-${LEAFLET_SCRIPT_HASH}' 'sha256-${MAP_RUNTIME_HASH}'; style-src 'unsafe-inline'; img-src data: https://tile.openstreetmap.org; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<title>RoadSense demo haritası</title><style>${LEAFLET_CSS}
html,body,#map{width:100%;height:100%;margin:0}body{background:#E7EDE8;font-family:system-ui,sans-serif}
.leaflet-container{font:14px/1.4 system-ui,sans-serif}.leaflet-control-zoom a{width:44px;height:44px;line-height:44px}
.leaflet-control-attribution{font-size:11px;max-width:calc(100vw - 12px)}.leaflet-popup-content{overflow-wrap:anywhere}
.leaflet-popup-close-button{min-width:32px;min-height:32px}.leaflet-popup-content p{margin:8px 0}
</style></head><body><div id="map" role="region" aria-label="Isparta demo hasar haritası"></div>
<script type="application/json" id="map-config">${config}</script>
<script>${LEAFLET_JS}</script><script>${MAP_RUNTIME_JS}</script></body></html>`;
}
