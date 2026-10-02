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
// Para ver el modo completo: anadir ?modo=completo a la URL.
const APP_MODE = new URLSearchParams(window.location.search).get("modo") === "completo" ? "completo" : "basico";

const FEATURES = {
  redactarIA: APP_MODE === "completo",
  bufferPorCapa: APP_MODE === "completo",
  solapamiento: APP_MODE === "completo",
};
