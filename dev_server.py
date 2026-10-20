"""Servidor de desarrollo local del geovisor.

Uso (desde la raiz del proyecto):
    python dev_server.py [puerto]        # por defecto 8000

Hace lo mismo que `python -m RangeHTTPServer 8000` (sirve los archivos con
peticiones por rangos, que necesita PMTiles) y ademas:

- Intermediario /miteco-wfs -> https://gis.miteco.gob.es/geoserver/wfs
  (2026-10-13). El GeoServer de MITECO empezo a mandar la cabecera
  "Access-Control-Allow-Origin: *, *" (duplicada); los navegadores la
  rechazan y bloquean la respuesta, asi que las zonas inundables salian como
  "Servicio de MITECO no disponible". Desde Python no hay esa restriccion:
  el servidor pide los datos y se los entrega al visor desde el mismo origen
  (localhost). Solo reenvia a esa URL fija -- no es un proxy abierto.
  wfs-layers.js lo usa unicamente cuando la pagina se abre en localhost; la
  web publicada sigue llamando a MITECO directamente. Solucion provisional
  hasta que MITECO lo corrija o las capas se sirvan desde data-web/.
- Varios hilos: el RangeHTTPServer original atendia de una en una y una
  consulta lenta a MITECO bloqueaba la carga de teselas.
- Cache-Control: no-cache en todo: el navegador revalida cada archivo, asi
  que tras editar un .js/.css ya no hace falta la recarga forzada
  (Ctrl+Shift+R) que pedia el RangeHTTPServer original.
- Solo escucha en 127.0.0.1 (no accesible desde otros equipos de la red).
"""
import sys
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from RangeHTTPServer import RangeRequestHandler

MITECO_WFS = "https://gis.miteco.gob.es/geoserver/wfs"
PROXY_PATH = "/miteco-wfs"
PROXY_TIMEOUT_S = 25  # algo mas que WFS_TIMEOUT_MS (20 s) de wfs-layers.js


class DevHandler(RangeRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == PROXY_PATH:
            self.proxy_miteco(query)
        else:
            super().do_GET()

    def proxy_miteco(self, query):
        url = f"{MITECO_WFS}?{query}"
        try:
            with urllib.request.urlopen(url, timeout=PROXY_TIMEOUT_S) as res:
                status, body = res.status, res.read()
                ctype = res.headers.get("Content-Type", "application/octet-stream")
        except urllib.error.HTTPError as e:
            status, body = e.code, e.read()
            ctype = e.headers.get("Content-Type", "text/plain")
        except Exception as e:  # sin red, DNS, tiempo agotado...
            self.send_error(502, f"MITECO no responde: {e}")
            return
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("127.0.0.1", port), DevHandler)
    print(f"Geovisor en http://localhost:{port}/src/index.html (intermediario MITECO en {PROXY_PATH})")
    server.serve_forever()


if __name__ == "__main__":
    main()
