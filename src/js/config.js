// Modo de la aplicacion (2026-10-02, decision de Francisco): para la primera
// presentacion a la direccion se publica un modelo BASICO pero funcional, y el
// resto se reserva para presentarlo mas adelante (concurso). Un solo codigo con
// funciones activables, en vez de dos versiones que mantener.
//
// Basico: subir trazado, buffer, analisis con semaforo y su porque, capas
// locales y zonas inundables en linea, Excel, cartografia e informe PDF.
// Solo en completo: redaccion asistida con IA (pendiente de que Quadrante
// decida que herramientas de IA se pueden usar), buffer propio por capa en los
// resultados y solapamiento entre tramos subidos.
//
// Desde 2026-10-06 se publican las dos versiones con el mismo codigo (decision
// de Francisco, con permiso de su superior):
//   - en el sitio publicado abre el BASICO, para que el enlace del piloto que
//     ya tiene la direccion siga mostrando lo mismo; la version avanzada tiene
//     su propio enlace (avanzado/index.html, que redirige con ?modo=completo);
//   - en local (localhost) abre el COMPLETO, el de trabajo diario.
// ?modo=basico o ?modo=completo en la URL lo fuerzan en cualquier sitio.
const MODE_PARAM = new URLSearchParams(window.location.search).get("modo");
const APP_MODE =
  MODE_PARAM === "basico" || MODE_PARAM === "completo" ? MODE_PARAM
  : ["localhost", "127.0.0.1"].includes(window.location.hostname) ? "completo"
  : "basico";

const FEATURES = {
  redactarIA: APP_MODE === "completo",
  bufferPorCapa: APP_MODE === "completo",
  solapamiento: APP_MODE === "completo",
  // Analisis por tramo (tramos.js): cada linea del archivo es un tramo, los
  // puntos de PK se asocian a su tramo y cada grupo de tramos se analiza a su
  // propio zoom.
  porTramo: APP_MODE === "completo",
  // Red ferroviaria y carreteras del Estado con sus PK (layers.js).
  infraestructuras: APP_MODE === "completo",
};
